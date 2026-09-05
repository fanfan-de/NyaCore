# 从 0.0 开发版迁移到 0.1 候选

> 状态：Current<br>
> 类型：How-to<br>
> 适用范围：使用 `0.0.0` 或仓库源码的宿主与插件作者

## 1. 使用同批包并锁定依赖

先备份应用配置和业务数据，保留原 lockfile 以便回退。取得 `0.1.0-rc.1` 候选目录，将 `vendor/` 复制到宿主目录。使用实际文件安装，不假设 npm 上存在这个版本：

```bash
npm install --save-exact ./vendor/nya-core-0.1.0-rc.1.tgz ./vendor/nya-loader-0.1.0-rc.1.tgz ./vendor/nya-logger-console-0.1.0-rc.1.tgz ./vendor/nya-timer-0.1.0-rc.1.tgz
npm ls @nya/core @nya/loader @nya/logger-console @nya/timer
```

只安装实际使用的外围包；它们现在要求 Core `^0.1.0-rc.1`，不再接受任意 `>=0.0.0`。提交新的 package.json 和 lockfile。插件的 Core 应为 peer dependency，开发时使用同版 devDependency；不要把 Core 代码内联到插件产物中。候选尚不等于稳定版，后续 RC 的变化仍需阅读[版本记录](../../CHANGELOG.md)。稳定补丁承诺见[兼容政策](../compatibility.md)。

## 2. 改用公开安装与观察接口

删除从 `@nya/*/src/*`、`@nya/*/lib/*` 或仓库路径导入的代码。全部框架导入必须来自包根入口。下列开发期泄漏的成员不再出现在公开声明中：

| 旧依赖 | 迁移方式 |
| --- | --- |
| `Fiber.root()` / `Fiber.component()` / `fiber.start()` | 使用 `new Context()` 和 `context.installComponent()`，等待返回的 Fiber |
| `fiber.assertActive()` | 根据 `fiber.state` / `fiber.inspect()` 判断当前状态；通过 Context 创建资源，让真实操作执行生命周期校验 |
| `DependencySnapshot` / `ServiceImplementation` | 依赖排查使用公开 `DependencyDiagnosticSnapshot` 和 `fiber.inspect().dependencies`；不要读取固定运行快照或内部服务实现对象 |
| `EventHook` | 订阅通过 `context.on()` / `once()`，持有返回的 `Disposer`；需要事件类型时使用 `EventCallback` / `EventOptions` 等公开类型 |
| 包内 Symbol、`ServiceRegistry.onFiberStateChange()`、Context 内部隔离/intercept字段 | 生命周期观察使用 `context.registry.subscribe()`，作用域修改使用 `isolate()` / `intercept()` |

`Context.services/events`、公开 Registry 类、`DisposableStack` 和 `EffectScope` 仍保留。若服务实例自己的就绪条件改变而实现身份不变，显式调用 `fiber.refreshDependencies()`，再 `await fiber.awaitStable()` 并检查状态；`restart()` 本身不重新执行依赖检查。

## 3. 为默认 Resolver 指定宿主基址

旧版相对名称可能隐式相对 Loader 安装目录加载，裸包也未使用宿主基址。现在相对名称缺少基址会失败。宿主入口应这样安装 Loader：

```ts
import { Context } from '@nya/core'
import { Loader } from '@nya/loader'

const app = new Context()
await app.installComponent(Loader, { baseUrl: import.meta.url })
const entry = await app.loader.create({ id: 'worker', name: './worker.js' })
if (entry.state !== 'active') {
  console.dir(entry, { depth: null })
}
await app.fiber.dispose()
```

`worker.js` 指的是构建后宿主模块旁的真实文件，必须默认导出组件。目录基址写成 `new URL('./', import.meta.url).href`；配置文件目录先用 `pathToFileURL()` 转成带末尾 `/` 的目录 URL，不能把 Windows 路径直接作为 URL。文件名含 `#` / `%` 时，同样使用 `pathToFileURL()`，避免把文件字符误当 URL 片段或转义。

安装在宿主项目中的 npm 插件可作为 `name: 'your-plugin'`；其 `exports` 必须暴露可加载的默认组件。显式基址现在决定 npm 包查找位置与 `import` 条件选择，可能纠正旧版误载的同名依赖。无基址裸包仍保留 Loader 模块相对查找，宿主不应依赖这种偶然布局。更多规则见 [Loader README](../../packages/loader/README.md)。

若宿主使用自定义加载器、`--conditions` 或特殊符号链接策略，请提供 `resolver` 实现。自定义 Resolver 的方法签名不变。`resolve()` 继续用于失败恢复；改源码后先构建、再重启进程，不通过反复 resolve 绕过 ESM 缓存。

## 4. 检查就绪与失败恢复

需要通用文件配置时，另安装同批 Include/HMR tarball，按[专用示例](../../examples/include-hmr/README.md)先安装 Loader / Include / HMR，再调用 `hmr.start()`。不启用 HMR 时调用 `include.refresh()`。已有程序化 Loader 用法不需要迁移；新增树操作版本参数均为可选，`replace()` 是独立接口。

HMR 的 TS 支持只覆盖显式登记的入口及其受支持本地依赖。保存通过 Include 提交完整来源文档；检查 `saved` 与实际 Entry 状态，不能把“写入成功”当作“启动成功”。代码回退不会修改配置文件。

不要把 `await fiber`、`awaitStable()` 或 `loader.awaitIdle()` 的完成当成应用就绪。需要运行的 Fiber 必须是 `ACTIVE`，Entry 必须是 `active`。Entry 为 `failed` 时读取 `error`，即使错误值为 `undefined`；为 `pending` 时查询 `blockedBy`、依赖原因与提供者状态。

清理失败会持续保留目标与错误，更新或移动目标不会自动重建。确认允许继续运行后，调用 `loader.resolve(id)`；目标禁用则转为 `disabled`，目标启用则按最新目标恢复。它不重试旧 cleanup，旧资源是否需要人工修复由资源协议决定。`remove()` 拒绝也可能已经完整删除了 Entry，应重新 `get(id)` 确认。

组件启动/清理中的重入 `create()` 只登记 Entry，返回 `pending` 或适用的 `disabled`，随后才解析和安装。同一生命周期不能等待 `update/move/remove/resolve/awaitIdle`，这些自等待操作会拒绝。删除期间不能向正在删除的子树创建 Entry。相关行为见[核心概念](../concepts.md)。

## 5. 验证应用并退出

按[入门教程](../tutorials/framework-basics.md)运行组件、服务、资源、恢复与诊断例子，再按[任务日志教程](../tutorials/task-journal.md)验证自己的宿主关闭路径。至少确认：缺依赖不执行业务、更新先清理旧资源、禁用后无新调度、恢复后可继续、最终关闭等待在途资源。

宿主负责信号、启动/关闭期限与退出码；超时不能宣称 Core 已取消初始化或 cleanup。Timer 取消未来调度，但不会等待已开始的异步回调，业务 Effect 必须等待自己的在途任务。开发使用[构建重启流程](./development.md)。迁移测试通过后，再替换实际部署使用的版本和 lockfile。

## 6. 迁移已有 YAML 配置

当前工作树已将 Include 格式收敛为 JSON。这是相对旧候选的显式格式变更，已有 `.yaml` / `.yml` 配置不能直接继续使用。

1. 将根配置和所有被 include 引用的文件内容转换成标准 JSON，使用 `.json` 扩展名。保留 `version`、Entry ID、顺序、配置和禁用状态；仅改扩展名不能转换 YAML 语法。
2. 更新宿主 `IncludeOptions.path` 和每个 `type: "include"` 条目的 `path`。模块名和组件代码路径保持原有含义。
3. 将注释说明移到应用文档。JSON 不支持注释和尾随逗号，也不接受 `.jsonc`。
4. 在独立验证环境刷新声明，检查报告、组件状态和保存后的文件；完成关闭与重新加载验证后，再替换实际配置。多文件保存仍逐个来源执行，不提供跨文件事务。

可参考已迁移的[Include/HMR 示例](../../examples/include-hmr/README.md)。新增能力和完整格式边界见[Include README](../../packages/include/README.md)，决策依据见[ADR-0016](../adr/0016-json-only-configuration.md)。

# `@nya/loader`

`@nya/loader` 是 Nya 的通用内存组件加载层。它把稳定的 Entry 树映射为 `@nya/core` Fiber，并负责模块解析、配置更新、父子所有权、禁用恢复、移动和失败重试。

它不读取或写入配置文件，也不监听文件变化。[Include](../include/README.md) 的 YAML/JSON 持久化与[HMR](../hmr/README.md) 已建立在这层公开 API 之上。

## 外围控制器的版本检查

`revision` 跟踪声明与定义提交；`create/update/move/remove` 的最后一个可选参数接受 `expectedRevision`，在队列执行时拒绝过期操作。`request(id)` 只返回有效解析请求，`resolver` 用于捕获已有解析策略。

`replace(replacements, { expectedRevision, resolver?, signal? })` 接收已经准备好的定义，先清理整个集合并合并重叠子树，再共同提交成功定义缓存和未来 Resolver。它保留声明身份、原始配置与禁用状态，报告 `committed` 和实际状态。清理失败阻断提交；启动失败可能发生在提交之后；中途取消或版本过期不承诺撤销已经完成的清理。普通 `resolve()` 的缓存和恢复语义保持不变。

## 安装

```bash
npm install ./vendor/nya-core-0.1.0-rc.1.tgz ./vendor/nya-loader-0.1.0-rc.1.tgz
```

## 基本使用

```ts
import { Context } from '@nya/core'
import { Loader } from '@nya/loader'

const modules = new Map([
  ['clock', (ctx: Context) => {
    return ctx.provide('clock', { now: Date.now })
  }],
])

const app = new Context()
const loaderFiber = app.installComponent(Loader, {
  resolver({ name }) {
    const component = modules.get(name)
    if (!component) throw new Error(`unknown component: ${name}`)
    return component
  },
})
await loaderFiber

const entry = await app.loader.create({
  id: 'main-clock',
  name: 'clock',
})

console.log(entry.state) // active
await app.loader.remove(entry.id)
```

当前是本地 `0.1.0-rc.1` 候选，先取得同批 `vendor/` 归档，不假设版本已发布到 npm。Core peer 为 `^0.1.0-rc.1`，不支持混用 `0.0.x` 或 `0.2.x` Core。

## 加载真实文件与 npm 插件

不传 `resolver` 时，显式宿主 `baseUrl` 决定相对文件和裸包的查找位置，随后由 Node 原生动态 `import()` 加载。被加载文件必须默认导出 Component，运行前先把 TypeScript 编译为 JavaScript：

```ts
const app = new Context()
await app.installComponent(Loader, { baseUrl: import.meta.url })
const local = await app.loader.create({ id: 'local', name: './plugins/worker.js' })
const plugin = await app.loader.create({ id: 'plugin', name: 'your-installed-plugin' })
// 等待已完成仍可能是 pending 或 failed，必须检查真实状态。
console.dir({ local, plugin }, { depth: null })
await app.fiber.dispose()
```

`your-installed-plugin` 是宿主已经安装的 npm 包占位名；完整可运行示例见仓库中的框架入门教程。包的 `exports` 需允许目标入口，采用 ESM `node` / `import` 条件，支持导出的子路径与宿主 `package.json` 的 `imports` 别名。

`baseUrl` 优先采用 Entry 自身、最近祖先、Loader 配置中的值。它是绝对 `file:` URL：`import.meta.url` 表示宿主模块，`new URL('./', import.meta.url).href` 表示末尾带 `/` 的目录。查找不依赖进程当前目录；从配置文件目录构造基址时使用 Node 的 `pathToFileURL()`，为目录保留末尾 `/`。绝对文件 URL 可直接作为 name，无需基址；Windows 文件路径以及含 `#` / `%` 的文件名也应先通过 `pathToFileURL()` 编码。

无 `baseUrl` 的相对名称明确失败；无基址裸包名保留 Loader 模块相对加载，不能保证找到宿主项目的插件，因此宿主应始终传基址。默认解析不自动补扩展名、不猜目录 index；文件路径遵循 Node ESM 规则。

显式基址解析使用 `import-meta-resolve@4.2.0`，适用于当前支持的标准 Node ESM 环境。自定义加载钩子、自定义条件或符号链接保留等特殊策略请提供自己的 `resolver`。该解析器不清除 Node 的模块缓存，`resolve()` 仍只用于失败恢复。

## Entry 模型

- `id` 是 Loader 树中的稳定身份；重新安装产生新的 `fiberId`，不会改变 Entry ID。
- `type: 'component'` 通过 Resolver 获得 Component；`type: 'group'` 只建立 Context、Fiber 和子树所有权边界。
- `config` 是 Loader 保存的原始输入；Core 仍负责 Schema 校验和 `fiber.config` 的转换结果。
- `inject`、`intercept` 和 `isolate` 作为单次安装覆盖传给 Core，并通过父 Context 自然影响后代。
- `disabled` 会卸载整棵子树，但保留 Entry 与原始配置；重新启用后按原树结构安装。

Entry 状态为 `disabled`、`resolving`、`pending`、`active` 或 `failed`。`get()` 与 `entries()` 返回冻结快照；解析、Schema 或启动失败记录在对应快照中，不阻止无关兄弟条目运行。使用 `resolve(id)` 显式重试。

`entry.dependencies` 直接展示当前 Fiber 等待的服务、已知提供者状态和最近一次依赖检查结果，与 `fiber.inspect().dependencies` 使用相同协议。读取不会重新执行 `Service.check`。没有 Fiber 时数组为空；若存在 `blockedBy`，应继续查询那个父 Entry 的诊断，不能仅根据空数组判断就绪。状态和错误字段的完整类型以公开声明为准。

## 生命周期更新

- 只修改 `config` 时复用当前 Fiber，并调用 `fiber.update()`。
- 修改模块名、类型、父级、base URL 或安装覆盖时，只重新安装目标子树。
- 同一父级内调整顺序不会重启组件。
- 成功解析的定义按完整 Resolver 请求缓存；移动或祖先基址变化后，仅在 `id`、`name`、`parentId` 或有效 `baseUrl` 改变时重新解析。显式基址覆盖仍有效，Group 不经过 Resolver。
- Loader 管理的 Entry 启动或清理期间，相关生命周期调用方可 `await loader.create()` 声明 Entry，外部服务失效触发的清理也适用；该重入调用只登记条目并返回 `pending` 或适用的 `disabled`，随后再解析、安装，不保证返回时已运行。
- 同类重入中的 `update()`、`move()`、`remove()`、`resolve()` 和 `awaitIdle()` 立即拒绝，避免等待自身生命周期；普通 ACTIVE Root 并发调用仍正常排队。
- `remove()` 开始后，向其目标子树创建条目会在修改树之前拒绝；向其他分支或根创建仍允许。删除后 ID 可以复用，`get()` 与 `entries()` 均不保留旧条目。
- `remove()` 和 Loader 自身卸载都会沿 Core Effect 所有权树尽可能完成后代清理。
- 实例启动与清理经过 Loader 的串行协调队列；重入创建先即时登记，再进入后续协调。`awaitIdle()` 还会等待当前 Entry Fiber 稳定。

## 清理失败与恢复

清理失败（包括启动回滚中的清理失败）会保留最新目标和原错误，并阻止自动重建；Entry 始终显示 `failed`，即使其目标已是 `disabled: true`。Registry 状态变化、`awaitIdle()` 和后续目标修改都不会清除该阻断。

`resolve(id)` 是显式恢复入口，只解除指定 Entry 的清理阻断；各自清理失败的后代需要分别恢复。目标禁用时只解除阻断并转为 `disabled`；目标启用时复用尚有效的 Fiber，或在旧 Fiber 已销毁、安装目标已改变时按最新目标重新安装。该操作不会重新执行已经失败的旧 disposer；旧失败仍可能由 Core 父级最终清理再次报告。

`remove()` 遇到清理失败仍完成能够完成的清理、删除及后续协调，再拒绝其 Promise；尚未显式恢复的旧清理失败也会报告。单个错误保留原对象，多个独立错误使用 `AggregateError`。因此删除 Promise 拒绝不表示 Entry 仍存在，调用方可通过 `get()` 确认最终树状态。

## API

```ts
loader.create(input, parentId?, index?)
loader.update(id, patch)
loader.move(id, parentId, index?)
loader.remove(id)
loader.resolve(id)
loader.get(id)
loader.entries()
loader.awaitIdle()
```

完整类型以包的 `index.d.ts` 为准。

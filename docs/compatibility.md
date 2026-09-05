# 0.1 系列兼容承诺

> 状态：Current<br>
> 类型：Specification<br>
> 适用范围：`@nya/core`、`@nya/loader`、`@nya/include`、`@nya/hmr`、`@nya/logger-console`、`@nya/timer`

## 候选与稳定版本

当前交付版本为 **`0.1.0-rc.1`**，通过本地 npm tarball 分发；生成候选不代表已经发布到 npm。候选期用于验证下面的契约，后续 RC 如有不兼容修订，必须在[版本记录](../CHANGELOG.md)和[迁移指南](./how-to/migrate-0.1.md)中逐项说明。候选消费者应锁定确切版本或同批 tarball，不使用 `latest` 推断候选身份。

从稳定 `0.1.0` 起，`0.1.x` 的补丁版本维持已发布公共类型和已文档化行为的兼容；不会移除公共入口、增加必填参数、缩窄可接受配置或更改生命周期、服务解析及清理契约。可选能力的增补和符合契约的缺陷修复可以进入补丁版本。需要消费者改代码的调整留到 `0.2.0`，并提供迁移说明。增加消费者需要穷举处理的状态或事件联合成员也按破坏性变化处理。

六个框架包使用同一发行版本。外围包的 Core peer 范围为 `^0.1.0-rc.1`，Include/HMR 同时要求该范围的 Loader：接纳该候选序列及稳定 `0.1.x`，不接纳 `0.0.x` 或 `0.2.x`。SemVer 默认不会接纳不同基础版本的预发行包，例如 `0.1.1-rc.1`；新的预发行系列需重新声明和验证范围。应用的直接依赖锁定同一批版本，提交 lockfile；插件把 Core 声明为 peer，避免捆绑另一份 Core 导致类、Symbol 与模块扩充身份分裂。

## 支持的公开表面

兼容承诺覆盖六个包通过 `exports["."]` 提供的运行时导出、类型导出、Context 模块扩充和这些类型中的公共成员，以及对应包 README 和[核心概念](./concepts.md)描述的可观察语义。`./package.json` 可以用于查询包元数据，版本等内容会随发行更新。

| 范围 | 支持的用法与边界 |
| --- | --- |
| 组件与生命周期 | 用 `new Context()` 创建 Root，用 `installComponent()` / `inject()` 安装；通过返回的 Fiber 更新、重启、等待、检查和清理 |
| 服务与资源 | `Service` 扩展点、Context 服务/事件/Effect 接口、`DisposableStack` 和 `EffectScope`；资源必须有明确所有者 |
| 低层注册表 | 导出的 Registry、ServiceRegistry、EventRegistry 及其公开成员保留支持；组件作者优先使用 Context 以保持自动所有权 |
| 依赖刷新 | `fiber.refreshDependencies()` 显式重新捕获依赖，随后 `await fiber.awaitStable()`；读取诊断与单纯 `restart()` 不重新运行 `Service.check` |
| Loader | Entry 输入与冻结快照、默认或自定义 Resolver、创建/更新/移动/禁用/删除和显式恢复 |
| Loader 替换 | 声明版本检查、有效解析请求、成组定义与 Resolver 提交、提交前取消；失败报告不等于回滚 |
| Include | version 1 JSON/YAML 声明、文件来源、命名空间、预览和单文件保存；运行失败可以晚于成功保存 |
| HMR | 显式本地 ESM/TS 入口、配置监听、模块代数与替换报告、上一代回退和关闭；具体模块支持范围见包 README |
| 日志与诊断 | 声明中的字段、状态和事件码；允许新增可选字段，消费者不得拒绝未知对象字段；实际消息文字、ID 数值、时间与无关并发事件的交错不是固定输出 |
| Timer 与 ConsoleLogger | 两个可选组件各自声明的配置、服务方法、错误和资源归属语义 |

`lib/*`、`src/*` 等未列入 package exports 的子路径不是公共入口。Core 的包内 Symbol 协议、私有成员和标为 `@internal` 的工厂/协调方法不属于支持面，已从发布声明中移除。JavaScript 中偶然能读取到某个实现字段，不会使它成为兼容承诺。不要绕过 `exports` 通过绝对路径访问实现。

[`api/`](../api/) 是从构建后声明图生成的审查基线，记录公开入口及其可达声明，包含实现所需的辅助类型引用；它不会把未导出的类型或子路径变成公共 API。`npm run api:check` 检查漂移。刻意修改声明时，先判断兼容性、更新相应测试和迁移说明，再运行 `npm run api:update` 并审查差异。基线检查不能替代行为回归。

## 必须维持的运行时语义

- 等待生命周期稳定不等于应用就绪或业务结束。`await fiber` / `awaitIdle()` 后仍应检查状态；Loader 失败可能作为 fulfilled Promise 的 `failed` 快照返回。
- Effect 由调用方 Fiber 持有，幂等清理、LIFO、异步串行等待和多错误聚合保持不变。单个错误保留原值，包括 `undefined`，不能靠真假判断是否失败。
- 清理失败不意味着外部资源已释放。Loader 保存失败及最新目标，显式 `resolve()` 允许按目标继续运行，不重做已经失败的旧 cleanup。`remove()` 尽可能完成删除后仍可拒绝。
- 普通 Fiber 销毁后不能复活；Root 清理后是空的 ACTIVE Root，可以复用。日志缓冲和最近失败快照按既有保留规则存在。
- Core 不超时取消用户初始化或 cleanup，不终止永不结束的用户 Promise。宿主负责启动/关闭期限、信号与退出状态。

## 运行环境与默认模块加载

支持 Node.js **≥22.12.0**，发布 ESM JavaScript 和声明；教程使用 TypeScript **5.9.3**、`strict` 和 `NodeNext` 验证。`require('@nya/core')`、浏览器打包器、非 Node 宿主、任意 TypeScript 旧版不在当前验收矩阵内。普通 Loader 使用构建后的 `.js` / `.mjs`；显式 HMR 模式可以检查并转换受管 TS 源文件。

Include 使用 YAML 1.2 的 JSON 数据子集，拒绝别名、复杂键和自定义标签。HMR 固定使用 TypeScript 5.9.3 和 import-meta-resolve 4.2.0，保留 ESM 模块边界；不自动热替换 npm 依赖、CommonJS、原生扩展或任意动态路径。包或构建环境变化与导入代数上限请求宿主重启。完整边界见[Include](../packages/include/README.md)和[HMR](../packages/hmr/README.md)。

默认 Resolver 接受 `default` 导出的组件，宿主应显式给出绝对 `file:` 基址：模块 URL 使用 `import.meta.url`，目录 URL 必须以 `/` 结尾。相对名称及裸 npm 包名都从该基址解析，后者遵循 ESM 的 `node` / `import` 条件和包的 `exports` / `imports`。无基址的相对名称明确失败；无基址的裸包名仍相对 Loader 模块解析，不能保证指向宿主项目。

Linux 的 npm 10.9.0 在含 `#` 的项目路径中安装本地 tarball 时存在路径解析问题。使用教程中的普通目录名完成安装，需要时再整体移动项目；消费者回归采用这种方式验证特殊宿主路径。此限制发生在 npm 安装阶段，实际模块文件的中文、空格、`#` 和 `%` 仍通过编码后的 file URL 加载。

宿主基址解析使用固定版本的 `import-meta-resolve`，随后交给 Node 原生 `import()` 加载。自定义加载钩子、自定义条件或保留符号链接等特殊解析策略应提供自己的 Resolver；这不是完整复制所有 Node 启动选项的协议。标准行为及原因见 [Loader README](../packages/loader/README.md)和 [ADR-0013](./adr/0013-release-contract.md)。成功定义与 Node 模块缓存仍然有效；`resolve()` 不是 HMR。

## 候选的验证与分发

`npm run release:check` 验证文档、strict 类型、全部测试、声明基线，以及仓库外安装实际 tarball 的消费者。消费者检查包括真实 npm 插件、宿主基址、相对文件、教程提取编译运行、任务日志应用，以及 Include/HMR 的配置保存恢复、同进程替换、共享 Core 和资源回收。

`npm run release:pack` 构建并生成可复制的 `artifacts/release-candidate/`，包含六包归档、摘要、发行文档和两个独立示例。它不发布 npm；交付前先通过 `release:check`。CI 配置覆盖 Windows/Linux 与 Node 22.12.0/24.x；配置矩阵不表示相应运行已经通过，具体记录见[实施计划](./include-hmr-plan.md)。验收不代表所有第三方插件或宿主都已验证。

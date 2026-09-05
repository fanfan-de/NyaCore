# ADR-0015：通过版本化模块产物和公开替换协议实现 HMR

> 状态：Proposed<br>
> 类型：ADR<br>
> 日期：2026-09-05

## 背景

[ADR-0009](./0009-loader-entry-tree.md)要求外围能力使用公开协议协调稳定 Entry 与 Fiber。[ADR-0014](./0014-config-persistence-boundary.md)将文件持久化交给 Include，并明确 HMR 需要另行设计。

当前 [Loader](../../packages/loader/src/loader.ts)缓存成功解析定义，`resolve()`只恢复失败；[默认 Resolver](../../packages/loader/src/resolver.ts)随后使用 Node 原生动态导入。[Node 22.12 ESM 文档](https://nodejs.org/download/release/v22.12.0/docs/api/esm.html#urls)说明模块按 URL 缓存，ESM 不使用 CommonJS 的 `require.cache`。更改入口 URL 不能自动改变其全部传递依赖的身份。

现有[示例开发宿主](../../examples/task-journal/scripts/dev-supervisor.mjs)使用进程重启刷新代码，适合退出策略复用，但不满足同进程组件替换的目标。Cordis 将文件读写放在 [Include](https://github.com/cordiverse/cordis/blob/main/packages/include/src/index.ts)，代码监听与重载放在 [HMR](https://github.com/cordiverse/cordis/blob/main/packages/hmr/src/index.ts)；其内部缓存操作不是 Nya 必须继承的契约。

## 提议决策

1. 新建外围 `@nya/hmr`。配置监听调用 Include 的验证/规划/应用入口；代码模式准备新 Component 定义并请求 Loader 替换。Core 不引入文件系统、构建工具或 Node 私有加载器。
2. Loader 新增与模块来源无关的公开替换操作，保持现有 `resolve()`、默认 Resolver 和五种 Entry 状态的含义。定义缓存更新、目标版本检查、重叠子树处理和生命周期协调进入现有队列。
3. 替换保留 Entry ID、原始名称和配置，创建新的安装身份。新版本必须同时用于后续新建、启用、移动和恢复；Loader 缓存与 HMR Resolver 的版本映射不能分别提交而产生新旧混用。
4. 先验证构建适配器产生不可变 ESM 版本产物的方案。产物覆盖受支持的本地依赖图，共享模块保留一致身份；Core、Nya 共享包和外部依赖从原宿主解析。原型不通过共享身份、循环导入或资源路径验收时，改用保留模块边界的输出并记录证据，再确定实现。
5. 变化按共享本地模块连接的入口集合处理。局部替换范围包括必要的所有权子树；服务依赖传播仍由 Core 决定，不能保证所有结构外消费者都保持运行。
6. 构建和类型检查通过后才导入候选，导入不作为无副作用预检。受支持组件把长期资源登记到 Core 生命周期中；候选顶层执行或业务副作用不承诺自动回滚。
7. 旧运行清理完成后才启动新定义。清理失败停止对应替换集合，保留原阻断；配置或启动失败报告目标与实际结果。显式回退上一代是新的生命周期操作，不承诺恢复之前的业务内存。
8. HMR 拥有 watcher、构建任务和产物租约，宿主拥有退出和重启权。原生 ESM 缓存不承诺可以卸载；累计导入版本有上限，达到上限或遇到不支持的模块变化时请求宿主重启。
9. 文档持久化只记录声明，不记录代码产物 URL、构建版本或运行错误。Include 与 HMR 可以各自准备，提交必须检查最新 Loader 目标，过期结果不得覆盖用户新配置。

## 后果

能够交付同进程的组件代码替换，并保持现有配置身份、服务依赖和 Effect 清理模型。文件监听可以先作为独立模式交付，Include 手动使用不需要启用构建。

需要增加 Loader 公开能力、模块图与构建适配器，验证成本高于全进程重启。默认不保留任意组件闭包状态，也不支持所有 Node 加载方式。共享模块可能扩大替换集合；原生 ESM 历史版本最终需要由宿主进程退出释放。

本文保持 Proposed，不以设计选择代替验证。实施证据及明确限制如下。

## 实施证据（2026-09-05）

实现选择 TypeScript 5.9.3 的逐模块输出，直接保留 ESM 模块边界；使用 import-meta-resolve 4.2.0 从原始导入者解析外部包。未执行 esbuild 对照实验，选择理由是缩小转换范围，而不是已证明 esbuild 无法处理这些场景。

[模块图实现](../../packages/hmr/src/modules.ts)与[测试](../../packages/hmr/tests/hmr.spec.ts)覆盖共享身份、循环导入、原始资源 URL、间接依赖、严格 TS、旧候选和关闭竞态。[独立消费者](../../scripts/check-include-hmr-consumer.mjs)在实际 tarball 中验证单份 Core、原生 ESM、多个 Entry 和真实监听。Loader 的版本检查、清理阻断与提交取消见[替换测试](../../packages/loader/tests/loader-replacement.spec.ts)。

HMR 实例拥有监听和队列；已提交版本可能继续由 Loader 使用，因此产物租约实际归 Root 生命周期。Root Effect 是 LIFO，产物清理回调可能先于组件 cleanup；实现把磁盘删除延后到 Root 稳定之后，以允许 cleanup 中动态导入本地模块。该回收任务不阻塞 Root dispose，错误写入 Root 日志。默认最多导入 100 代，失败导入也计数，磁盘清理不会卸载原生 ESM 缓存。正式支持范围见[HMR README](../../packages/hmr/README.md)，跨平台执行状态见[实施记录](../include-hmr-plan.md#2026-09-05-实施记录)。

## 考虑过的替代方案

- 仅反复调用 `resolve()` 或 `restart()`：复用当前定义，不能证明新源码已运行。
- 只给入口附加时间参数：无法覆盖未改变 URL 的传递依赖，并不断形成新的缓存身份。
- 复用 Node 私有模块缓存接口：把支持范围绑定到非公开结构，与现有公开边界及宿主环境要求不符。
- 直接删除再重建 Loader Entry：丢失稳定声明和动态后代，无法统一处理同模块多实例及清理失败。
- 将进程重启作为唯一交付：可作为明确标记的宿主降级流程，但不满足同进程 HMR。
- 为每个组件创建 Worker 并销毁 Worker 卸载模块：需要跨执行环境代理 Context、Service 和资源，与当前同进程运行模型不同，首轮不采用。
- 首轮承诺任意热替换失败都自动回滚：缺少可撤销所有外部副作用的事务协议，无法兑现。

## 关联

- [Include 与 HMR 实施计划](../include-hmr-plan.md)
- [通用配置与持久化计划](../config-persistence-plan.md)
- [ADR-0012：开发辅助生命周期](./0012-development-lifecycle-boundaries.md)
- [ADR-0013：宿主模块解析](./0013-release-contract.md)
- [兼容政策](../compatibility.md)
- [esbuild 构建元数据](https://esbuild.github.io/api/#metafile)

# 版本记录

本文件记录面向消费者的变化。兼容边界见[兼容承诺](./docs/compatibility.md)，升级步骤见[迁移指南](./docs/how-to/migrate-0.1.md)。

## 0.1.0-rc.1 — 2026-09-05

本地发布候选，尚不代表已发布到 npm。六个公开包采用同一版本，Node.js 最低版本为 22.12.0。

### 公开 API 与兼容

- 外围包的 Core peer 从 `>=0.0.0` 收紧到 `^0.1.0-rc.1`。候选建议精确锁定；稳定 `0.1.x` 维护公开类型和已文档化行为的补丁兼容。
- Core 声明移除内部 Fiber 工厂、启动/校验方法、包内 Symbol 协议，以及 `EventHook`、`DependencySnapshot`、`ServiceImplementation` 三个入口类型。组件通过 Context 安装；公开声明消费者和自动生成基线防止意外扩大支持面。
- `refreshDependencies()` 保留为显式依赖刷新接口，随后等待 `awaitStable()`。Registry、ServiceRegistry、EventRegistry、DisposableStack 与 EffectScope 的公开能力保留。

### 运行时与开发体验

- 修复清理重入、自等待、已销毁 Fiber 所有权残留、DisposableStack 重入、Loader 旧定义缓存、孤儿 Entry 和失败日志订阅残留。
- Loader 清理失败保留错误及最新目标，由 `resolve()` 显式允许恢复；删除尽可能完成后报告原清理错误。
- Fiber 与 Entry 诊断显示阻塞服务、已知提供者状态和真实发生的 Service.check 结果，读取不运行检查。
- 新增 `@nya/timer`，提供归属调用方 Effect 的 timeout / interval；回调失败自动停止调度并记日志。
- 新增可独立安装或嵌入的任务日志应用，以及串行清理、构建、重启的开发宿主。

### 模块加载变化

- 新增 `@nya/include`：版本化 JSON/YAML、跨文件挂载、来源归属、纯预览、单文件保存与冲突检测，保存后协调失败如实报告。
- 新增 `@nya/hmr`：配置目录监听、固定 TypeScript 编译器、保留 ESM 模块边界的版本产物、共享本地依赖替换、严格 TS 检查与显式回退。保持 PID，无关代码分支保持运行。
- Loader 增加 `revision`、`resolver`、`request()`、`replace()`，树修改新增可选预期版本参数。新定义与未来 Resolver 共同提交；清理失败不自动解锁，关闭可撤销未提交候选。
- HMR 的旧模块缓存需要宿主进程退出释放；导入代数默认上限 100，不支持的模块或环境变化报告重启请求。

- 默认 Resolver 使用显式宿主基址解析真实文件、npm 包及 ESM `exports/imports`，再交给 Node 动态 import；Loader 新增固定运行依赖 `import-meta-resolve@4.2.0`。
- 相对模块名缺少 `baseUrl` 时明确失败。宿主应传绝对 `file:` 模块或目录 URL；裸包不再在提供宿主基址时误用 Loader 所在位置。
- 定义缓存与 Node 模块缓存继续有效；`resolve()` 不提供 HMR，自定义加载策略仍使用自定义 Resolver。

### 交付与验证

- 增加入门教程，覆盖组件、服务、资源管理、配置更新、失败恢复和依赖排查；代码围栏提取到仓库外，通过真实 tarball 安装、strict 编译和运行断言验证。
- 包消费者增加真实 npm 插件、条件导出、宿主项目基址和相对文件加载检查，延续任务日志持久化、退出及开发重启验收。
- `release:pack` 生成带 SHA-256 摘要、版本清单、教程与独立应用的本地候选目录，不执行 npm publish。
- 候选增加 Include/HMR 示例与实际 tarball 消费者，验证特殊路径、单份 Core、真实文件替换监听、多代资源回收和保存恢复；CI 扩展 Windows/Linux 与 Node 22.12.0/24.x。

## 0.0.0 — 开发基线

仓库此前使用的开发版本，无稳定补丁兼容承诺。本记录不追溯推定该版本已发布到 npm；迁移到候选时按上述变化重新检查依赖、公开导入和宿主就绪判断。

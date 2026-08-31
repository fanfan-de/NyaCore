# ADR-0008：Registry 通过不可变快照提供生命周期观察

> 状态：Accepted<br>
> 类型：ADR<br>
> 日期：2026-08-31

## 背景

Loader、调试界面和运行时管理工具需要知道 Component 是否已安装、处于何种 Fiber 状态以及何时永久移除，但它们不应修改 Fiber 状态机。当前 `Fiber.state`、`stateSince`、`error` 和 `ComponentRuntime.fibers` 对外可写，无法形成稳定的只读观察边界。

日志和诊断是旁路证据，不应被外围组件反向当作生命周期控制协议。

## 决策

### 只读状态

- `Fiber.state`、`stateSince` 和 `error` 改为只读 getter；
- Registry 对外发布冻结的 Fiber 与 Runtime 生命周期快照；
- 快照只携带标量状态、错误引用和只读身份信息，不把可变集合交给观察者。

### Registry 订阅

Registry 提供返回幂等 Disposer 的 `subscribe()`，事件分为：

- `snapshot`：订阅 replay 时交付的当前安装快照；
- `installed`：Fiber 已登记，但尚未由安装 Effect 启动；
- `state`：状态已提交后的变化；
- `detached`：永久销毁的 Fiber 已从定义 Runtime 解除。

订阅可以请求 replay 当前安装实例。Replay 使用 `snapshot`，不伪装成新的状态迁移。

### 观察旁路

- 观察回调同步交付，但返回值被忽略；
- 回调抛错不会改变组件启动、更新、清理或 Registry 操作结果；
- 抛错的观察者自动取消，并通过 Root Logger 记录；
- 订阅本身不自动绑定任意 Fiber。组件内订阅者应显式用 Effect 拥有返回的 Disposer。

## 后果

- Loader 可以只依赖公开事件和快照维护 Entry 状态；
- 生命周期控制仍通过 `Fiber.update()`、`restart()` 和 `dispose()` 等正式操作完成；
- 状态先提交再观察，观察者不会看到半提交状态；
- 外部直接赋值 Fiber 状态的代码将不再通过类型检查。

## 考虑过的替代方案

### 暴露内部生命周期事件

内部事件参数和顺序会随实现变化，直接公开会把 Loader 绑定到 Fiber 私有状态机。

### 只使用 Logger

Logger 允许丢弃、过滤和回放，语义是诊断而不是精确的当前状态，因此不能作为 Loader 控制面。

## 关联

- [ADR-0005：运行时可观测性](./0005-runtime-observability.md)
- `packages/core/tests/registry-observer.spec.ts`

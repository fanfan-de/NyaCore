# ADR-0009：Loader 用稳定 Entry 树协调外围模块生命周期

> 状态：Accepted<br>
> 类型：ADR<br>
> 日期：2026-09-01

## 背景

Core 已经区分 Component 定义、安装 Fiber 与运行轮次，也提供单次安装覆盖和只读 Registry 生命周期观察。配置文件、模块导入和可编辑条目树不应进入 Core，但上层适配器需要一条不依赖 Core 私有字段的统一加载边界。

如果文件适配器、HMR 或宿主应用各自直接操作 Fiber，它们会重复实现父子顺序、失败隔离、配置更新和清理协调，也容易把持久化身份错误绑定到会变化的 Fiber ID。

## 决策

### 独立外围包

建立独立的 `@nya/loader`。它只依赖 `@nya/core` 的公开 API，不把文件系统、YAML / JSON、文件监听或 HMR 引入 Core。首版只保存进程内状态；持久化适配器以后通过 Loader 公共操作读写 Entry。

### 三种不同身份

- Entry ID 是 Loader 树中由调用方提供的稳定字符串身份；
- Component definition identity 是 Resolver 返回的原始定义引用；
- Installation identity 仍是每次安装得到的 `Fiber.id`。

移动、禁用恢复或安装覆盖变化可以替换 Fiber，但不得替换 Entry ID。Loader 通过私有映射关联两者，不向 Fiber 写入 Entry 字段。

### Entry 树与 Group

Entry 分为 `component` 和 `group`。Component Entry 把名称交给可替换 Resolver；Group Entry 使用 Loader 内建的空 Component，只建立 Context、Fiber 和 Effect 所有权边界。两者都可以有子条目，并接受 Core 的 `inject`、`intercept` 与 `isolate` 单次安装覆盖。

子条目只在父 Entry Fiber ACTIVE 时安装。父级 PENDING、FAILED 或禁用时，后代保留在 Entry 树中并显示阻塞状态；父级再次 ACTIVE 后由 Registry 观察触发重新协调。Entry 的 `baseUrl` 沿祖先继承，但模块如何取得仍由 Resolver 决定。

### 配置与结构变更

Loader 分别保存原始 Entry 配置和当前 Fiber：

- 纯配置更新调用同一个 Fiber 的 `update()`；
- 名称、类型、base URL、父级或安装覆盖变化会重新安装目标子树；
- 同一父级内只调整顺序不会重启 Fiber；
- 禁用会卸载子树但保留 Entry，删除会同时移除整棵 Entry 子树。

Loader 操作通过一条串行队列执行，并在返回前等待当前相关 Fiber 与观察产生的后续任务稳定。正在被该操作等待的 Component 可以嵌套创建新 Entry；嵌套创建在当前串行暂停点完成，以当前 LOADING Entry 为父级时先保持 PENDING，避免生命周期入口与 Loader 队列自等待。Core 的生命周期仍是唯一状态控制者；Loader 只通过公开方法控制，并从 Registry 冻结事件观察结果。

### 状态与失败

Loader 暴露冻结的 Entry 快照，状态为 `disabled`、`resolving`、`pending`、`active` 或 `failed`。模块解析、配置或组件启动失败记录到目标 Entry，不阻止无关兄弟条目继续协调。`resolve(id)` 是显式重试入口；无效 ID、重复 ID、非法父级与树环属于控制面错误，操作直接拒绝。

### 安装 Effect 的主动解除

公开调用子 `Fiber.dispose()` 必须经由父 Fiber 中的安装 Effect 完成，而不是只销毁子 Fiber。主动清理成功的 Disposer 同时从 DisposableStack 解除强引用；失败项保留到所属栈最终清理，以继续传播同一个失败。这样 Loader 的删除和移动不会在父诊断树或 Effect 栈中积累已销毁安装。

## 后果

- 宿主可以用内存 Resolver、包名 Resolver 或注册表 Resolver 驱动同一个 Loader；
- 文件配置、HMR 和管理界面可以依赖稳定 Entry ID，而不接触 Fiber 私有状态；
- Group 复用 Core 的 Context 继承与 Effect 所有权，不需要第二套作用域系统；
- Loader 不是安全沙箱，也不约束被加载模块能访问的宿主资源；
- 首版没有持久化、文件监听、模块缓存失效或事务批量 API。

## 考虑过的替代方案

### 把 Loader 放入 Core

这会让最小运行时依赖模块导入和配置来源语义，并迫使浏览器、Node.js 与其他宿主共享不必要的实现，因此拒绝。

### 用 Fiber ID 作为配置身份

Fiber ID 会在移动、禁用恢复和重新安装后改变，无法作为持久化条目的稳定引用，因此拒绝。

### 让每个持久化适配器直接操作 Core

这会复制生命周期协调和失败隔离逻辑，也无法形成一致的 Entry 状态模型，因此拒绝。

## 关联

- [ADR-0007：Component 安装身份](./0007-component-installation-identity.md)
- [ADR-0008：生命周期观察](./0008-lifecycle-observation.md)
- `packages/loader/tests/loader.spec.ts`

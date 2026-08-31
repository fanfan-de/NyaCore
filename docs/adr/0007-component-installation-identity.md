# ADR-0007：Component 定义、安装实例与运行轮次使用不同身份

> 状态：Accepted<br>
> 类型：ADR<br>
> 日期：2026-08-31

## 背景

Component 可以是函数、构造器或带 `apply` 的对象。对象定义会归一化为 `apply` 回调，但回调不是定义身份：两个不同对象可能故意复用同一个 `apply`，同时拥有不同名称、依赖或 Schema。

Registry 当前按归一化回调索引 Runtime，会让这些不同定义错误共享元数据。未来 Loader 还需要区分稳定的配置 Entry、某一次安装和该 Fiber 因配置或依赖变化产生的多轮运行。

## 决策

### 三层身份

- Component definition identity 是传入 Core 的原始函数、构造器或对象引用；
- Installation identity 是每次安装得到的 `Fiber.id`；同一定义安装多次产生独立 Fiber；
- Run identity 属于 Fiber 的单轮运行，由现有配置版本与依赖快照共同确定。

Registry 按原始 Component 引用索引定义级 Runtime，不再按归一化 callback 索引。相同定义引用的多个安装共享只读定义元数据，但不共享 Context、Fiber、配置或 Effect。

### 单次安装覆盖

`Context.installComponent()` 可以为一次安装附加：

- 额外 `inject`；
- `intercept`；
- `isolate`。

安装覆盖不能替换 callback、Component 名称或 Config Schema，也不能删除静态依赖。Core 在安装时复制覆盖容器；其中的未知配置值按不透明值保存，调用方应将其视为不可变。

Loader 等外围组件应在自身维护 Entry 与 Fiber 的映射，不向 Fiber 写入领域字段。

### Runtime 封装

- Registry 内部使用可变 Runtime 记录维护 Fiber 集合；
- 公共 `Registry.get()` 返回冻结的只读快照；
- 公共快照不暴露可修改的 `Set`；
- `Registry.delete(definition)` 只处理精确的定义身份，并等待所有实例完成清理后再返回。

## 后果

- 复用同一个 `apply` 的对象 Component 不再冲突；
- Loader 可以把稳定 Entry 映射到安装 Fiber，而无需改变 Core 身份模型；
- Runtime 公共形状发生收紧，依赖可变 `fibers` Set 的代码需要迁移到只读数组快照。

## 考虑过的替代方案

### 继续使用 callback 身份

无法区分共享入口函数但元数据不同的对象定义，因此拒绝。

### 要求用户提供字符串 ID

字符串 ID 适合 Loader Entry，但不适合作为 Core 中 JavaScript 定义对象的唯一身份，还会引入跨 Loader 的命名冲突。

## 关联

- [ADR-0002：配置生命周期](./0002-config-lifecycle.md)
- `packages/core/tests/component-identity.spec.ts`

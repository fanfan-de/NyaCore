# ADR-0006：Context Intercept 按调用方作用域解析 Service 配置

> 状态：Accepted<br>
> 类型：ADR<br>
> 日期：2026-08-31

## 背景

同一个 Service Provider 可能被多个派生 Context 使用，而不同调用方需要为该 Service 提供不同配置。配置不能写回 Provider 全局实例，否则兄弟作用域会互相污染；也不能和 Component 自己的运行配置混为一谈。

`Inject` 已允许对象形式，但当前只读取键并丢弃值，因此尚不能表达“依赖某个 Service，并为本次调用作用域附加配置”。未来 Loader 也需要在不修改 Component 定义的前提下，为单次安装附加这类配置。

## 决策

### 不可变的 Context 派生

- `Context.intercept(name, config)` 返回派生 Context，原 Context 保持不变；
- intercept 按服务逻辑名称保存，并沿 Context 原型链继承；
- 同一个 Root 中的不同派生分支可以为同一 Service 保存不同配置；
- 隔离标签决定 Service 地址，intercept 决定调用配置，两者互不替代。

### Inject 与安装层

- 数组形式 `inject: ['service']` 只声明依赖；
- 对象形式的键同样声明依赖，非 `undefined` 值同时成为该 Service 的 intercept 层；
- 对象值为 `undefined` 时只声明依赖；`null` 是合法的显式配置；
- 单次安装可以额外提供 `inject` 和显式 `intercept`；静态声明先应用，安装层后应用；
- 安装层只能增加依赖，不能移除 Component 静态依赖。

完整优先顺序从低到高为：父 Context、子 Context、Component 对象形式 Inject、单次安装 Inject、单次安装显式 Intercept。

### Service 解析

- Service 配置通过调用方绑定后的 facade Context 解析，而不是通过 Provider 原始 Context 全局缓存；
- `Service.resolveConfig` 协议按父到子的顺序读取配置层；
- 默认解析策略是最后一层替换。Service 如需字段级或其他合并，应通过自己的配置合并协议显式声明；
- Component 的 `fiber.config` 仍只表示 Component 自己经过 Schema 处理的运行配置，与 Service intercept 相互独立。

## 后果

- 两个调用方可以安全地使用同一个 Provider，并获得不同 Service 配置；
- intercept Context 是不可变派生，因此已经启动的一轮 Fiber 不会被后续派生作用域反向修改；
- Core 只规定配置层和解析边界，不假设业务配置一定是普通对象；
- `Inject` 对象值从保留位升级为公共可观察语义，相关类型和测试必须维持该行为。

## 考虑过的替代方案

### 把配置写入 Service Provider

实现简单，但同一 Provider 的多个调用方会互相覆盖配置，也会破坏严格隔离和并发调用语义。

### Core 默认深合并对象

深合并无法一致处理数组、类实例、`null` 和领域自定义结构。默认替换更可预测，需要合并时由 Service 显式选择。

## 关联

- [ADR-0003：Service 隔离](./0003-service-isolation.md)
- [ADR-0004：Service 调用方 Context](./0004-service-caller-context.md)
- `packages/core/tests/intercept.spec.ts`

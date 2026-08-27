# ADR-0004：Service 调用保留调用方 Context 并按隔离地址过滤事件

> 状态：Accepted<br>
> 类型：ADR<br>
> 日期：2026-08-27

## 背景

ADR-0003 已经把服务身份定义为 Root Context、服务名和隔离标签组成的严格地址，但消费者读取 `Service` 实例后仍可能直接调用原对象。此时服务方法只能看到提供方 Context，无法知道本次调用来自哪个隔离分支；如果服务把自身作为事件 `thisArg`，EventRegistry 也无法按调用方所在的服务地址过滤监听器。

直接在调用前临时改写原 Service 实例的 `ctx` 会产生更严重的问题：两个同步嵌套或异步并发调用会互相覆盖 Context，跨越 `await` 后也无法可靠恢复。另一方面，普遍代理所有通过 `provide()` 注册的对象会改变普通对象的引用身份，并可能破坏依赖原生内部 slot 的对象。

## 决策

### 只为 Service 建立调用方绑定视图

- 通过 Context 属性代理或 `context.get()` 读取 `Service` 实例时，运行时返回绑定到当前调用 Context 的 Proxy 视图，而不是直接暴露原始实例；
- 同一个调用 Context 对同一个服务实现重复读取时返回稳定视图。不同调用 Context 获得不同视图，但它们仍指向同一个提供方实例；
- 只有继承 `Service`、因而显式加入框架追踪协议的实例会被包装。普通 `context.provide(name, value)` 对象、函数和原生对象保持原引用和值语义；
- 提供方在构造、`Service.init`、`Service.check` 和自身清理中继续使用原始 Service 实例与提供方 Context。

### 调用 Context 与提供方依赖快照各司其职

- Service 原始实例永久保存提供方 Context；运行时不得为了某次调用临时修改它；
- 调用方绑定视图中的普通 prototype 方法以该视图作为 `this` 执行，因此方法读取 `this.ctx` 时得到从调用方派生的混合 Context；它与调用方原 Context 不保证引用相等，但 `root`、`fiber`、隔离视图和资源所有权来自调用方。这个绑定对象跨越异步边界保持稳定，不依赖进程级全局变量或临时栈；
- Service 读取它声明的依赖时仍受提供方 Fiber 当前固定依赖快照约束，不能借用调用方声明的依赖绕过自身 `inject`，也不能在同一轮运行中实时切换实现；
- 混合 Context 的服务属性、`get()` 与 `name in context` 都观察提供方依赖地址；调用方隔离视图用于事件范围、显式派生和新安装组件，不会改写 Service 已捕获的依赖；
- Root 提供方没有组件依赖快照，继续沿用 Root 对其当前服务地址进行实时、非 `inject` 限制的读取语义；
- Service 方法通过调用方 Context 创建的 Effect、监听器或子组件仍归调用方 Fiber 所有。需要与 Service 提供方同寿命的资源应在构造或 `Service.init` 中创建；
- 从 Service 方法继续取得另一个可追踪 Service 时，新的视图继续携带最初调用方 Context，同时使用下游服务自己的提供方信息。
- 在混合 Context 上调用 `extend()` 或 `isolate()` 会保留提供方依赖来源，并把派生 Context 推进为新的调用方视图；通过它安装的新组件则清除 Service 调用帧，使用组件自己的 `inject` 与快照。

### Service 作为事件 thisArg 时按调用地址过滤

- `Service` 实现 `Context.filter` 协议。Service 作为 `emit()`、`parallel()`、`serial()`、`bail()` 或 `waterfall()` 的显式 `thisArg` 时，只选择与其调用方 Context 在该服务名上具有相同隔离标签、且属于同一 Root 的局部监听器；
- 从提供方自身直接派发时，提供方 Context 就是调用 Context；从消费者取得的绑定视图派发时，使用消费者 Context；
- 使用 `{ global: true }` 注册的监听器继续跳过 `Context.filter`，用于明确需要跨作用域观察的框架或诊断逻辑；
- 没有显式 Service `thisArg` 的普通事件派发维持现有行为，不自动按所有服务隔离标签过滤。

### 明确 Proxy 编程限制

- Service 中需要参与调用方追踪的方法必须声明为 prototype 普通方法；箭头函数 class field 在构造时已经词法绑定原始实例，调用它会绕过 Proxy 的 `this`，因此不能依赖其中的 `this.ctx` 获得调用方 Context；
- 实例自身的函数值（包括箭头函数字段、构造器或其他可调用对象）保持原 identity 与可构造性，不会被稳定绑定；只有 prototype 数据方法及其 Symbol 方法获得可解构的稳定 wrapper；
- 以 Proxy 作为 `this` 调用 prototype 方法时，JavaScript 原生 `#private` 字段的品牌检查会失败。需要被调用方代理的方法应使用普通字段或 TypeScript `private` / `protected` 字段，不应访问 `#private` 字段；
- facade 的 `ctx` 是不可替换的调用视图，不能通过赋值、删除或属性描述符改写。为维持 Proxy 不变量，Service 的 `ctx` 必须保持可配置，facade 也不支持 `preventExtensions`、`seal` 或 `freeze`；
- callable Service、`Service.extend` 和 mixin 尚未由本决策实现。它们后续必须复用同一套调用方绑定协议，并继续遵守上述限制，不能另建会修改原实例 Context 的路径。

## 后果

- 同一个 Service 实现可以安全服务于共享同一服务地址的多个 Context，并在同步嵌套或异步并发调用中保持各自调用方信息；
- Service 发出的带 `thisArg` 事件可以复用既有 EventRegistry 过滤机制，不需要为每个隔离标签建立独立事件总线；
- 普通 `provide()` 对象保持引用身份和兼容性，但不会自动获得调用方追踪或隔离事件过滤；需要这些能力时应使用 `Service`；
- Service 作者必须遵守 Proxy 可代理的方法形态，原生 `#private` 字段和箭头函数实例方法不能用于依赖调用方 Context 的路径；
- caller-bound 视图需要按调用 Context 缓存。缓存必须使用弱引用键或随具体服务实现释放，避免 Service 卸载后长期持有消费者 Context；
- 服务隔离和事件过滤仍只是同一 JavaScript 进程内的运行时路由规则，不是权限或安全沙箱。代码仍可访问文件系统、网络、环境变量和全局对象。

## 考虑过的替代方案

### 调用前临时替换原 Service 的 Context

实现较少，但同步重入、Promise 并发和跨 `await` 调用会互相污染，因此不采用。

### 为所有 provide 值创建 Proxy

表面上一致，但会改变普通对象 identity，并破坏 Map、Set、Date 或其他依赖内部 slot 的对象。调用方追踪属于 Service 的显式高级协议，不应强加给所有值。

### 每个隔离地址创建独立 EventRegistry

可以天然分流事件，但会复制事件基础设施，也无法自然表达 `{ global: true }` 的跨作用域监听。保留单一 Root EventRegistry 并使用 `Context.filter` 更符合当前架构。

### 使用 AsyncLocalStorage 保存调用方

可以避免部分 Proxy 限制，但它是宿主相关的异步上下文机制，会给浏览器等运行时增加依赖，也不能单独解决 Service 对象成员的 Context 绑定。Core 保持显式 Proxy 视图。

## 关联

- [ADR-0003：服务身份由名称与隔离标签共同确定](./0003-service-isolation.md)
- [核心概念指南](../concepts.md)
- [当前架构总览](../architecture.md)
- [核心设计](../design.md)
- `packages/core/tests/caller-tracking.spec.ts`
- `packages/core/tests/service-events.spec.ts`

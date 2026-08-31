# Nya

Nya 是一个面向 TypeScript 的作用域组件运行时。它通过动态服务依赖决定组件何时运行，并把定时器、监听器、服务、子组件等副作用归属到明确的生命周期中，以便在依赖、配置或组件状态变化时完整撤销和重新建立运行。

> 项目仍处于早期开发阶段，当前版本为 `0.0.0`。作用域运行时位于 `@nya/core`，内存加载层位于 `@nya/loader`，公共 API 尚未进入稳定兼容期。

## 为什么使用 Nya

普通组件加载器通常只能“执行一次入口函数”，Nya 进一步处理长期运行应用中的动态关系：

- 组件可以先于依赖安装，并在服务可用后自动启动；
- 服务消失或被替换时，消费者会先清理旧运行，再等待或使用新实现；
- 每次组件安装都有独立的 Context、Fiber、配置和资源所有权；
- Effect、事件监听、服务注册和子组件会跟随所属 Fiber 自动清理；
- 结构化日志和只读 Effect 树会保留失败路径，且不会改变组件原有错误；
- 同名服务可以通过 Context 隔离在同一棵运行时树中并存；
- 配置更新、手动重启和异步清理都通过同一个串行生命周期协调。

Nya 借鉴 Cordis 的时空可组合模型，但不以兼容 Cordis 的内部实现或私有 API 为目标。

## 快速开始

当前仓库建议使用 Node.js 22.12 或更高版本。

```bash
npm install
npm run playground
```

下面的示例展示了动态服务依赖与自动清理。消费者先被安装，但在 `clock` 服务出现前保持 `PENDING`；服务出现后自动启动，服务移除后自动停止并回到等待状态。

```ts
import { Context, FiberState } from '@nya/core'

interface Clock {
  now(): number
}

declare module '@nya/core' {
  interface Context {
    clock: Clock
  }
}

const app = new Context()

const ticker = app.installComponent({
  name: 'ticker',
  inject: ['clock'],

  apply(ctx) {
    const timer = setInterval(() => {
      console.log(ctx.clock.now())
    }, 1000)

    return () => clearInterval(timer)
  },
})

console.log(ticker.state === FiberState.PENDING) // true

const removeClock = app.provide('clock', { now: Date.now })
await ticker

console.log(ticker.state === FiberState.ACTIVE) // true

await removeClock()
console.log(ticker.state === FiberState.PENDING) // true

await ticker.dispose()
```

`installComponent()` 会同步返回一个 Fiber。Fiber 是 thenable，`await fiber` 表示等待当前以及等待期间追加的生命周期转换达到稳定状态，并不表示等待组件永久结束。

需要观察运行状态时，可直接使用当前 Context 的结构化 Logger，并在失败后检查 Fiber：

```ts
app.logger.info('clock installed')

try {
  await ticker.restart()
} catch (error) {
  console.dir(ticker.inspect(), { depth: null })
}
```

`logger.records()` 在每棵 Root 中保留最近 1000 条记录；`fiber.inspect()` 返回当前 run 与最近失败 run 的冻结快照。两者都只旁路观察生命周期，不会替换启动或清理抛出的原错误。

## 核心模型

一次安装可以概括为：

```text
组件定义 + 本次配置 + 父 Context
                ↓
        独立 Context + Fiber
                ↓
        组件运行 + Effect 栈
```

| 概念 | 职责 |
| --- | --- |
| Component | 可复用的组件定义；支持函数、class 和带 `apply` 的对象 |
| Context | 表达组件运行的作用域，提供组件安装、服务、事件和 Effect API |
| Fiber | 管理一次安装的状态、配置、依赖快照和多轮运行 |
| Effect | 把资源创建与清理配对，并归属到当前 Fiber |
| Service | 由组件提供、由其他组件通过 `inject` 声明依赖的具名能力 |
| Event | 根运行时中的类型安全消息通道；监听器仍归订阅方 Fiber 所有 |
| Registry | 索引组件定义对应的 Runtime 及其全部 Fiber 实例 |
| Loader | 用稳定 Entry 树解析模块，并把配置控制面映射为 Fiber 子树 |
| Logger / Diagnostics | 记录结构化生命周期事实，并检查当前与最近失败的 Effect 树 |

最重要的边界是：Context 负责“在哪里运行”，Fiber 负责“运行多久以及如何撤销”。Context 隔离只影响运行时解析空间，不是权限或安全沙箱。

## 已实现能力

### 组件与生命周期

- 支持函数、class 和对象形式的组件定义；
- 同一组件定义可以安装多次，每次得到独立的 Context 和 Fiber；
- Fiber 提供 `PENDING`、`LOADING`、`ACTIVE`、`UNLOADING`、`FAILED` 和 `DISPOSED` 状态；
- `fiber.update()` 使用新配置安全重启，`fiber.restart()` 使用当前配置重建运行；
- 父组件卸载时会级联卸载它安装的子组件；根 Fiber 清理后仍可继续使用。

### Effect 与资源清理

- `context.effect()` 将资源登记到当前 Fiber 的本轮运行；
- 支持清理函数、Promise、同步迭代器和异步迭代器形式的 CleanupSource；
- 清理函数幂等，并按后进先出顺序执行；
- 启动失败会回滚已经登记的资源，多项清理失败会聚合报告。

### Service 与动态依赖

- `provide()` 注册服务，`inject` 声明组件运行所需的依赖；
- 依赖缺失时组件保持 `PENDING`，服务可用性或实现变化会触发生命周期重新协调；
- 每轮运行固定使用同一份依赖快照，避免启动和清理期间读到混合实现；
- `context.isolate()` 为指定服务创建严格隔离的解析地址，不会回退到默认实现；
- `context.intercept()` 为 Service 派生调用方配置，对象形式 `inject` 可以同时声明依赖和调用配置；
- 基于 `Service` 的 class 服务会为方法调用绑定调用方 Context，普通 `provide()` 值保持原始 identity。

### Event 与配置

- 通过 TypeScript 模块扩展声明类型安全的事件签名；
- 提供 `emit`、`parallel`、`serial`、`bail` 和 `waterfall` 五种派发模式；
- 事件监听支持 `once`、前置注册、作用域过滤和全局监听；
- 监听器注册自动归属于当前 Fiber，卸载或重启时不会泄漏；
- 组件可通过 Standard Schema 声明同步配置校验与转换，并使用 `ValidationError` 读取问题详情。

### Logger 与运行时诊断

- `context.logger` 提供 `debug`、`info`、`warn`、`error`、child 命名空间、记录读取和生命周期托管订阅；
- Fiber 状态、配置失败、启动失败和清理失败会形成结构化记录；每个 Root 最多保留最近 1000 条；
- sink 抛错后会自动移除，不会改变 Fiber 状态、生命周期 Promise、原错误身份或 Effect 清理顺序；
- `fiber.inspect()` 显示当前 run 的 Effect 树、子 Fiber 和最近失败 run；异步清理中的节点显示为 `disposing`；
- 诊断只能看到通过 Effect、Event、Service、Logger 订阅或组件安装登记的资源，Core 不为 cleanup 设置统一超时；
- 控制台输出由独立的 `@nya/logger-console` Component 提供，只有显式安装后才输出，导入包没有副作用。

```ts
import { ConsoleLogger } from '@nya/logger-console'

const consoleLogger = app.installComponent(ConsoleLogger, {
  level: 'info',
  replay: true,
})

await consoleLogger
// 不再需要输出时，卸载组件即可立即取消订阅。
await consoleLogger.dispose()
```

### 内存 Loader

- `@nya/loader` 以独立 Service 管理稳定 Entry ID、父子顺序和当前 Fiber 映射；
- Component Entry 通过可替换 Resolver 获得定义，默认 Resolver 使用动态 `import()`；
- Group Entry 只建立 Context / Fiber 所有权边界，并让 intercept、isolate 与 base URL 向后代组合；
- 纯配置更新复用 Fiber，移动、安装覆盖或模块名变化只重建目标子树；
- 解析和启动失败保存在目标 Entry 快照中，不影响无关兄弟条目，并可显式重试。

```ts
import { Loader } from '@nya/loader'

const loaderFiber = app.installComponent(Loader, {
  resolver({ name }) {
    if (name === 'worker') return () => undefined
    throw new Error(`unknown component: ${name}`)
  },
})
await loaderFiber

const worker = await app.loader.create({
  id: 'main-worker',
  name: 'worker',
})

console.log(worker.state) // active
```

## API 速览

| API | 用途 |
| --- | --- |
| `new Context()` | 创建一棵独立运行时树 |
| `context.extend()` | 通过原型链派生 Context |
| `context.isolate(name, label?)` | 为单个服务名派生严格隔离空间 |
| `context.intercept(name, config)` | 为 Service 派生调用方配置 |
| `context.installComponent(component, config?, options?)` | 安装组件，并可追加 inject / intercept / isolate |
| `context.inject(dependencies, callback)` | 安装仅在依赖齐备时运行的轻量组件 |
| `context.effect(setup, label?)` | 创建跟随当前 Fiber 清理的 Effect |
| `context.provide(name, value)` / `context.get(name)` | 注册或显式读取服务 |
| `context.on()` / `context.once()` | 注册生命周期托管的事件监听器 |
| `context.emit()` / `parallel()` / `serial()` | 以不同模式派发事件 |
| `context.logger` | 写入、读取或订阅当前 Root 的结构化日志 |
| `fiber.update(config)` | 校验并提交新配置，等待生命周期稳定 |
| `fiber.restart()` | 使用当前配置重建组件运行 |
| `fiber.dispose()` | 永久销毁普通 Fiber；清空并复用根 Fiber |
| `fiber.inspect()` | 获取当前 run 与最近失败 run 的冻结诊断快照 |
| `context.registry.subscribe(listener, options?)` | 订阅只读 Component 生命周期快照 |
| `loader.create()` / `update()` / `move()` | 创建或变更稳定 Entry，并协调对应 Fiber 子树 |
| `loader.remove()` / `resolve()` | 删除 Entry 子树或显式重试失败条目 |
| `loader.get()` / `entries()` / `awaitIdle()` | 读取冻结快照或等待 Loader 协调稳定 |

完整公共导出以 [`packages/core/src/index.ts`](./packages/core/src/index.ts) 为准；当前行为的详细说明见[核心概念指南](./docs/concepts.md)。

## 仓库结构

```text
NyaCore/
├── packages/core/       # @nya/core 源码、构建配置与测试
├── packages/loader/     # @nya/loader 内存 Entry 树与模块解析
├── packages/logger-console/ # 可选的 @nya/logger-console 输出组件
├── playground/          # 可运行示例与手动验证场景
├── docs/                # 架构、概念、设计和 ADR
├── scripts/             # 仓库级检查脚本
└── package.json         # npm workspaces 与统一命令入口
```

## 开发

```bash
npm install
npm run check
```

| 命令 | 说明 |
| --- | --- |
| `npm run build` | 构建 `@nya/core`、`@nya/loader` 和 `@nya/logger-console` |
| `npm test` | 运行三个发布包的 Vitest 测试 |
| `npm run typecheck` | 检查三个发布包、测试和 Playground 的类型 |
| `npm run docs:check` | 检查 Markdown 结构、代码围栏和本地链接 |
| `npm run check` | 依次运行文档、类型和测试检查 |
| `npm run package:check` | 构建、打包并以外部消费者方式验证三个发布包 |
| `npm run release:check` | 运行完整仓库检查和 npm 包发布前验证 |
| `npm run playground` | 构建 Core 并运行全部示例场景 |
| `npm run dev:core` | 监听 Core 源码并持续构建 |
| `npm run dev:playground` | 监听并运行 Playground |

代码变更完成前默认运行 `npm run check`；准备发布时运行 `npm run release:check`；只修改 Markdown 时至少运行 `npm run docs:check`。

## 文档

- [文档地图](./docs/README.md)：文档分类、状态与权威规则；
- [架构总览](./docs/architecture.md)：系统边界、运行时视图和关键流程；
- [核心概念](./docs/concepts.md)：有源码与测试支撑的当前行为；
- [核心设计](./docs/design.md)：目标版本设计，其中未落地内容不能视为当前能力；
- [架构决策记录](./docs/adr/README.md)：已经接受的关键技术决策；
- [文档贡献指南](./docs/contributing.md)：文档类型、维护方式与检查要求。

描述当前行为时，以源码、公共导出类型和测试为直接证据。文档与实现冲突时，请按照[文档权威规则](./docs/README.md#文档权威规则)处理，不要静默选择其中一方。

## 当前边界

callable Service、mixin、文件配置持久化和 HMR 仍属于目标设计，尚不能作为已实现能力使用。当前 Loader 只保存内存 Entry 树，不读取 YAML / JSON，也不监听文件。异步 Standard Schema 校验同样不在当前版本支持范围内。运行时诊断不会自动发现绕过 Core 所有权协议创建的宿主资源，也不会以超时自动中断 cleanup。

## 许可证

本项目采用 [MIT License](./LICENSE)。

## 贡献

公共 API 或可观察行为变化应同时更新测试和 `docs/concepts.md`；生命周期、依赖解析、清理顺序或作用域语义变化必须补充相应测试。新的跨模块架构决策应记录到 `docs/adr/`。

提交前请运行：

```bash
npm run release:check
```

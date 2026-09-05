# 从零使用 Nya：组件、服务与生命周期

> 状态：Current<br>
> 类型：Tutorial<br>
> 适用范围：Node.js 22.12+、Nya 0.1.0-rc.1 发布候选包的公开入口

本教程从一个打印问候语的组件开始，逐步加入服务依赖、可清理资源、配置更新和失败恢复。每一节都有完整的 TypeScript 文件和断言；可以单独运行，也可以一次运行全部六个入口。最后，你会知道如何区分“等待依赖”“启动失败”和“已经就绪”。

## 1. 安装并运行第一个组件

准备 Node.js 22.12 或更高版本，取得维护者提供的 `release-candidate/` 候选目录。在仓库外新建 `nya-basics`，把候选中的 `vendor/` 整体复制到 `nya-basics/vendor/`。已有这四个 tarball 即可继续，不需要 Nya 仓库或它的 `node_modules`；不假设候选版本已经发布到 npm。

如果从源码自行生成候选，才需要在 NyaCore 仓库根目录执行：

```bash
npm install
npm run release:pack
```

这会得到 `artifacts/release-candidate/vendor/`。按上面的步骤复制后，后续所有命令都在新建的 `nya-basics` 中执行。

创建 `package.json`：

```json
{
  "name": "nya-basics",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node dist/01-component.js && node dist/02-service.js && node dist/03-effects.js && node dist/04-update.js && node dist/05-loader.js && node dist/06-pending.js"
  },
  "dependencies": {
    "@nya/core": "file:vendor/nya-core-0.1.0-rc.1.tgz",
    "@nya/loader": "file:vendor/nya-loader-0.1.0-rc.1.tgz",
    "@nya/logger-console": "file:vendor/nya-logger-console-0.1.0-rc.1.tgz",
    "@nya/timer": "file:vendor/nya-timer-0.1.0-rc.1.tgz"
  },
  "devDependencies": {
    "@types/node": "22.20.1",
    "typescript": "5.9.3"
  }
}
```

创建 `tsconfig.json` 和空的 `src/` 目录：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmitOnError": true,
    "types": ["node"],
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

执行 `npm install`。四个 Nya 包来自本地归档；TypeScript、Node 类型及其他传递依赖仍按 npm 配置安装，因此首次安装可能需要网络。

将下面内容保存为 `src/01-component.ts`。`Context` 是应用的根，`installComponent()` 返回的 `Fiber` 表示这一次安装。对象组件的 `apply()` 负责启动，返回的函数负责清理。

```ts nya-check:01-component.ts
import assert from 'node:assert/strict'
import { Context, FiberState, type Component } from '@nya/core'
import { ConsoleLogger } from '@nya/logger-console'

interface GreetingConfig { name: string }

const app = new Context()
let started = 0
let cleaned = 0

const Greeting: Component.Object<GreetingConfig> = {
  name: 'Greeting',
  apply(ctx, config) {
    started++
    ctx.logger.info(`Hello, ${config.name}!`)
    return () => { cleaned++ }
  },
}

try {
  await app.installComponent(ConsoleLogger, { timestamps: false })
  const greeting = app.installComponent(Greeting, { name: 'Nya' })
  await greeting
  assert.equal(greeting.state, FiberState.ACTIVE)
  assert.equal(started, 1)

  await greeting.dispose()
  await greeting.dispose()
  assert.equal(greeting.state, FiberState.DISPOSED)
  assert.equal(cleaned, 1)
} finally {
  await app.fiber.dispose()
}

assert.equal(app.fiber.inspect().children.length, 0)
console.log('01 component passed')
```

运行：

```bash
npm run build
node dist/01-component.js
```

你会看到问候日志和 `01 component passed`。控制台输出来自显式安装的 `ConsoleLogger`；导入 Core 本身不会打印日志。重复调用 disposer 不会重复执行清理。结束应用时等待 `app.fiber.dispose()`，由 Root 回收其拥有的子组件和资源。

也可以使用带类型的箭头函数组件，或通过构造器启动的 class。入门时使用对象加 `apply()`，容易同时写清名称、配置和依赖。组件入口应在初始化结束后返回；长期工作由所登记的资源继续运行。

## 2. 提供并使用一个 Service

保存为 `src/02-service.ts`。`Service` 子类用 `static provide` 声明服务名，安装后提供实例。TypeScript 的模块扩充只声明 `ctx.tutorialGreeter` 的类型；真正的运行时依赖由消费者的 `inject` 声明。

```ts nya-check:02-service.ts
import assert from 'node:assert/strict'
import { Context, FiberState, Service, type Component } from '@nya/core'

class Greeter extends Service {
  static provide = 'tutorialGreeter'

  greet(name: string): string {
    return `Hello, ${name}!`
  }
}

declare module '@nya/core' {
  interface Context { tutorialGreeter: Greeter }
}

const app = new Context()
const messages: string[] = []
let cleaned = 0
const Consumer: Component.Object<void> = {
  name: 'GreeterConsumer',
  inject: ['tutorialGreeter'],
  apply(ctx) {
    messages.push(ctx.tutorialGreeter.greet('Nya'))
    return () => { cleaned++ }
  },
}

try {
  const consumer = app.installComponent(Consumer)
  await consumer
  assert.equal(consumer.state, FiberState.PENDING)
  assert.deepEqual(messages, [])

  const provider = app.installComponent(Greeter)
  await provider
  await consumer
  assert.equal(consumer.state, FiberState.ACTIVE)
  assert.deepEqual(messages, ['Hello, Nya!'])

  await provider.dispose()
  await consumer
  assert.equal(consumer.state, FiberState.PENDING)
  assert.equal(cleaned, 1)

  await app.installComponent(Greeter)
  await consumer
  assert.equal(consumer.state, FiberState.ACTIVE)
  assert.equal(messages.length, 2)
} finally {
  await app.fiber.dispose()
}

assert.equal(cleaned, 2)
console.log('02 service passed')
```

运行 `npm run build` 和 `node dist/02-service.js`。消费者可以先安装：服务缺失时 `apply()` 尚未执行。提供方进入 `ACTIVE` 后消费者才启动；提供方卸载后，消费者清理当前运行并回到 `PENDING`，新提供方就绪时再启动。

这是一份可变化的运行时依赖关系。不要把某一轮取得的 Service 引用保存在组件生命周期之外继续使用。若只需提供一个普通值，也可以在组件入口调用 `ctx.provide(name, value)`；第 6 节的诊断示例会用它提供启动条件。

## 3. 把资源交给 Effect

保存为 `src/03-effects.ts`。这个组件登记两个 Node 事件监听器，并使用 `Timer`。手动清理一个 Effect 后，组件最终卸载仍会清理剩余资源。

```ts nya-check:03-effects.ts
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Context, type Disposer } from '@nya/core'
import { Timer } from '@nya/timer'

const app = new Context()
const source = new EventEmitter()
let automaticHits = 0
let manualHits = 0
let stopManual: Disposer | undefined
let finishTick!: () => void
const ticked = new Promise<void>(resolve => { finishTick = resolve })

try {
  await app.installComponent(Timer)
  const worker = app.installComponent({
    name: 'ResourceOwner',
    inject: ['timer'],
    apply(ctx) {
      ctx.effect(() => {
        const listener = () => { automaticHits++ }
        source.on('pulse', listener)
        return () => { source.off('pulse', listener) }
      }, 'automatic listener')

      stopManual = ctx.effect(() => {
        const listener = () => { manualHits++ }
        source.on('pulse', listener)
        return () => { source.off('pulse', listener) }
      }, 'manual listener')

      ctx.timer.timeout(finishTick, 0)
      ctx.timer.interval(() => {}, 60_000)
    },
  })
  await worker
  await ticked
  source.emit('pulse')
  assert.deepEqual([automaticHits, manualHits], [1, 1])

  assert.ok(stopManual)
  await stopManual()
  await stopManual()
  source.emit('pulse')
  assert.deepEqual([automaticHits, manualHits], [2, 1])

  await worker.dispose()
  assert.equal(source.listenerCount('pulse'), 0)
  source.emit('pulse')
  assert.deepEqual([automaticHits, manualHits], [2, 1])
} finally {
  await app.fiber.dispose()
}

console.log('03 effects passed')
```

运行 `npm run build` 和 `node dist/03-effects.js`。脚本不会等待一分钟：间隔定时器属于创建它的消费者 `ResourceOwner`，卸载消费者会取消后续调度。一次性定时器实际触发后才继续验证，没有用固定 sleep 猜测完成时间。

`ctx.effect(setup, label)` 立即执行 setup，并登记其返回的清理函数。监听器、文件句柄、连接等都应在各自拥有的 Effect 中建立和清理；框架无法发现未经登记的宿主资源。

Timer 的取消只停止未来调度，不等待已经开始的异步回调；间隔回调也可能重叠。涉及文件写入等业务时，组件还需要跟踪并在清理中等待在途任务。可继续阅读[完整任务日志应用](./task-journal.md)中的串行写入示例。

## 4. 更新配置并显式重启

保存为 `src/04-update.ts`。这里用启动、清理记录验证每一轮运行，随后制造一次可恢复的启动失败。

```ts nya-check:04-update.ts
import assert from 'node:assert/strict'
import { Context, FiberState, type Component } from '@nya/core'

interface WorkerConfig { label: string }

const app = new Context()
const history: string[] = []
const startupError = new Error('temporary startup failure')
let failNextStart = false

const Worker: Component.Object<WorkerConfig> = {
  name: 'ConfigurableWorker',
  apply(_ctx, config) {
    if (failNextStart) {
      failNextStart = false
      throw startupError
    }
    history.push(`start:${config.label}`)
    return () => { history.push(`stop:${config.label}`) }
  },
}

try {
  const worker = app.installComponent(Worker, { label: 'first' })
  await worker
  const installationId = worker.id

  await worker.update({ label: 'second' })
  assert.equal(worker.id, installationId)
  assert.deepEqual(history, ['start:first', 'stop:first', 'start:second'])

  await worker.restart()
  assert.deepEqual(history.slice(-2), ['stop:second', 'start:second'])

  failNextStart = true
  await assert.rejects(worker.restart(), error => error === startupError)
  assert.equal(worker.state, FiberState.FAILED)

  await worker.restart()
  assert.equal(worker.state, FiberState.ACTIVE)
  assert.equal(worker.id, installationId)
  assert.deepEqual(worker.config, { label: 'second' })
  assert.equal(history.at(-1), 'start:second')
} finally {
  await app.fiber.dispose()
}

assert.equal(history.at(-1), 'stop:second')
console.log('04 update passed')
```

运行 `npm run build` 和 `node dist/04-update.js`。在这里的默认更新流程中，`update()` 接收新的完整配置，清理旧运行，再以新配置启动；它不会自动把两个配置对象做深度合并。`restart()` 使用当前配置建立新一轮运行，两者都保留这个 Fiber 的安装身份。

组件配置类型用于 TypeScript 检查；从文件或网络取得的输入仍需运行时校验。Core 支持组件的 `Config` Standard Schema，本教程的配置由代码直接给出。失败不应被当成成功等待：捕获 Promise 拒绝后检查错误和状态，修正条件，再显式恢复。已 `dispose()` 的普通组件 Fiber 不能通过 restart 复活，需要重新安装。

## 5. 用 Loader 管理模块与失败恢复

Loader 在 Fiber 之上保留稳定的 Entry ID，适合用配置管理组件。它本身不读取配置文件或监听源码。先保存 `src/05-plugin.ts`：

```ts nya-check:05-plugin.ts
import assert from 'node:assert/strict'
import type { Component } from '@nya/core'

export const startupError = new Error('plugin first start failed')
export const history: string[] = []
let firstAttempt = true

const Plugin: Component.Object<{ label: string }> = {
  name: 'TutorialPlugin',
  apply(_ctx, config) {
    assert.equal(typeof config.label, 'string')
    if (firstAttempt) {
      firstAttempt = false
      throw startupError
    }
    history.push(`start:${config.label}`)
    return () => { history.push(`stop:${config.label}`) }
  },
}

export default Plugin
```

再保存 `src/05-loader.ts`。这个入口导入插件的错误对象和运行记录来做断言；组件定义仍由 Loader 的默认 Resolver 通过相对模块名取得。

```ts nya-check:05-loader.ts
import assert from 'node:assert/strict'
import { Context } from '@nya/core'
import { Loader } from '@nya/loader'
import { history, startupError } from './05-plugin.js'

const app = new Context()

try {
  await app.installComponent(Loader, {
    baseUrl: new URL('./', import.meta.url).href,
  })
  const loader = app.loader
  await loader.create({ id: 'workers', type: 'group' })
  const failed = await loader.create({
    id: 'worker',
    name: './05-plugin.js',
    config: { label: 'first' },
  }, 'workers')
  assert.equal(failed.state, 'failed')
  assert.equal(failed.error, startupError)
  assert.ok(Object.isFrozen(failed))

  const recovered = await loader.resolve('worker')
  assert.equal(recovered.state, 'active')
  assert.equal(recovered.id, 'worker')
  assert.equal(recovered.fiberId, failed.fiberId)
  assert.deepEqual(history, ['start:first'])

  const updated = await loader.update('worker', { config: { label: 'second' } })
  assert.equal(updated.fiberId, recovered.fiberId)
  assert.deepEqual(history.slice(-2), ['stop:first', 'start:second'])

  await loader.update('workers', { disabled: true })
  assert.equal(loader.get('worker')?.state, 'disabled')
  assert.equal(history.at(-1), 'stop:second')
  await loader.update('workers', { disabled: false })
  await loader.awaitIdle()
  const restored = loader.get('worker')
  assert.equal(restored?.state, 'active')
  assert.equal(restored?.id, 'worker')
  assert.notEqual(restored?.fiberId, recovered.fiberId)
  assert.equal(history.at(-1), 'start:second')

  await loader.remove('workers')
  assert.equal(loader.get('worker'), undefined)
  assert.equal(loader.entries().length, 0)
} finally {
  await app.fiber.dispose()
}

assert.equal(history.at(-1), 'stop:second')
console.log('05 loader passed')
```

运行 `npm run build` 和 `node dist/05-loader.js`。TypeScript 源文件写 `.js` 相对导入，因为运行的是 `dist/` 下的 JavaScript。`baseUrl` 明确指向当前宿主模块所在目录，传入的是 URL 字符串。

第一次组件启动失败会留在 Entry 快照中；检查 `state === 'failed'` 后读取 `error`，不要仅依赖其真假。`resolve('worker')` 显式重试，保留稳定 Entry ID；这个例子的旧 Fiber 仍可复用。只有配置变化时，Loader 调用 Fiber 的 update；Group 禁用后保留条目和配置，再启用则重新安装子树并产生新的 Fiber ID。

默认 Resolver 使用 Node 原生模块加载，被加载模块通过 `default` 导出 Component。Node 的 ESM 缓存仍然存在，这也是插件局部 `firstAttempt` 能保留的原因。`resolve()` 是生命周期恢复入口，不会使源文件变化自动生效。源码开发请使用[构建并重启应用的流程](../how-to/development.md)。

本例展示启动失败恢复。清理失败另有持续阻断：后续 update 不会自动清除它，需显式 `resolve(id)`；该操作也不会重新执行已经失败的旧 disposer。细节见 [Loader 的清理失败与恢复说明](../../packages/loader/README.md)。

## 6. 看懂 PENDING，而不是一直等待

保存为 `src/06-pending.ts`。消费者等待 Greeter，Greeter 又等待启动条件。通过读取两层诊断，可以找出真正缺少的服务。

```ts nya-check:06-pending.ts
import assert from 'node:assert/strict'
import { Context, FiberState, Service } from '@nya/core'

class WaitingGreeter extends Service {
  static provide = 'tutorialWaitingGreeter'
  static inject = ['tutorialBootstrap']

  greet(): string { return 'ready' }
}

declare module '@nya/core' {
  interface Context { tutorialWaitingGreeter: WaitingGreeter }
}

const app = new Context()
let runs = 0

try {
  const provider = app.installComponent(WaitingGreeter)
  const consumer = app.installComponent({
    name: 'WaitingConsumer',
    inject: ['tutorialWaitingGreeter'],
    apply(ctx) {
      assert.equal(ctx.tutorialWaitingGreeter.greet(), 'ready')
      runs++
    },
  })
  await provider.awaitStable()
  await consumer.awaitStable()
  assert.equal(consumer.state, FiberState.PENDING)
  assert.equal(runs, 0)

  const before = consumer.inspect()
  const dependency = before.dependencies[0]
  assert.equal(dependency?.serviceName, 'tutorialWaitingGreeter')
  assert.equal(dependency?.reason, 'provider-inactive')
  assert.equal(dependency?.providers[0]?.fiberId, provider.id)
  assert.equal(dependency?.providers[0]?.source, 'declared')
  assert.ok(Object.isFrozen(before.dependencies))
  assert.equal(provider.inspect().dependencies[0]?.serviceName, 'tutorialBootstrap')
  assert.equal(provider.inspect().dependencies[0]?.reason, 'missing')

  const stopBootstrap = app.provide('tutorialBootstrap', {})
  await provider
  await consumer
  assert.equal(consumer.state, FiberState.ACTIVE)
  assert.equal(runs, 1)
  assert.equal(consumer.inspect().dependencies[0]?.status, 'ready')
  assert.equal(before.state, FiberState.PENDING)

  await stopBootstrap()
  await provider
  await consumer
  assert.equal(consumer.state, FiberState.PENDING)
} finally {
  await app.fiber.dispose()
}

console.log('06 pending passed')
```

运行 `npm run build` 和 `node dist/06-pending.js`。`await fiber`、`awaitStable()` 和 Loader 的 `awaitIdle()` 等待当前生命周期稳定，**稳定不等于 ACTIVE**。依赖缺失时，等待可以正常结束，而组件仍为 `PENDING`。

诊断中的 `serviceName` 指出依赖，`reason` 解释阻塞，`providers` 标出已知提供者的身份和状态。`declared` 只表示已安装的 Service 类声明过这个名字，并不保证实例已经提供。先沿 `provider-inactive` 查提供者，再处理它的 `missing`，就能找到本例真正缺少的启动条件。

快照被冻结，恢复后要重新调用 `inspect()`；旧快照不会随着运行时改变。读取诊断不会重跑服务检查或触发恢复。Loader 管理的组件可从 `loader.get(id)?.dependencies` 取得同类信息；若 Entry 带 `blockedBy`，应继续检查那个父条目，空依赖列表不能单独证明已经就绪。其他阻塞原因的操作步骤见[依赖排查指南](../how-to/development.md)。

保存全部七个文件后运行 `npm test`，六个入口都应输出对应的 `passed` 并自然退出。仓库的教程消费者检查会提取上面标有 `nya-check:<filename>` 的 TypeScript 围栏，在仓库外使用发布候选 tarball 安装、以 strict 模式编译并运行这些断言；`05-plugin.ts` 是第 5 节的被加载模块。后续可以把这些组件组合方式用于[任务日志应用教程](./task-journal.md)，加入文件配置、运行失败通知和宿主关闭期限。

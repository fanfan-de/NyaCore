# `@nya/loader`

`@nya/loader` 是 Nya 的通用内存组件加载层。它把稳定的 Entry 树映射为 `@nya/core` Fiber，并负责模块解析、配置更新、父子所有权、禁用恢复、移动和失败重试。

它不读取或写入配置文件，也不监听文件变化。YAML / JSON、持久化、HMR 和宿主特定的模块注册表应建立在这层 API 之上。

## 安装

```bash
npm install @nya/core @nya/loader
```

## 基本使用

```ts
import { Context } from '@nya/core'
import { Loader } from '@nya/loader'

const modules = new Map([
  ['clock', (ctx: Context) => {
    return ctx.provide('clock', { now: Date.now })
  }],
])

const app = new Context()
const loaderFiber = app.installComponent(Loader, {
  resolver({ name }) {
    const component = modules.get(name)
    if (!component) throw new Error(`unknown component: ${name}`)
    return component
  },
})
await loaderFiber

const entry = await app.loader.create({
  id: 'main-clock',
  name: 'clock',
})

console.log(entry.state) // active
await app.loader.remove(entry.id)
```

不传 `resolver` 时，Loader 使用宿主原生动态 `import()`。裸包名保持原样；以 `.` 或 `/` 开头的名称会相对 Entry、最近祖先或 Loader 配置中的 `baseUrl` 解析。`baseUrl` 必须是 URL 字符串。

## Entry 模型

- `id` 是 Loader 树中的稳定身份；重新安装产生新的 `fiberId`，不会改变 Entry ID。
- `type: 'component'` 通过 Resolver 获得 Component；`type: 'group'` 只建立 Context、Fiber 和子树所有权边界。
- `config` 是 Loader 保存的原始输入；Core 仍负责 Schema 校验和 `fiber.config` 的转换结果。
- `inject`、`intercept` 和 `isolate` 作为单次安装覆盖传给 Core，并通过父 Context 自然影响后代。
- `disabled` 会卸载整棵子树，但保留 Entry 与原始配置；重新启用后按原树结构安装。

Entry 状态为 `disabled`、`resolving`、`pending`、`active` 或 `failed`。`get()` 与 `entries()` 返回冻结快照；解析、Schema 或启动失败记录在对应快照中，不阻止无关兄弟条目运行。使用 `resolve(id)` 显式重试。

`entry.dependencies` 直接展示当前 Fiber 等待的服务、已知提供者状态和最近一次依赖检查结果，与 `fiber.inspect().dependencies` 使用相同协议。读取不会重新执行 `Service.check`。没有 Fiber 时数组为空；若存在 `blockedBy`，应继续查询那个父 Entry 的诊断，不能仅根据空数组判断就绪。状态和错误字段的完整类型以公开声明为准。

## 生命周期更新

- 只修改 `config` 时复用当前 Fiber，并调用 `fiber.update()`。
- 修改模块名、类型、父级、base URL 或安装覆盖时，只重新安装目标子树。
- 同一父级内调整顺序不会重启组件。
- 成功解析的定义按完整 Resolver 请求缓存；移动或祖先基址变化后，仅在 `id`、`name`、`parentId` 或有效 `baseUrl` 改变时重新解析。显式基址覆盖仍有效，Group 不经过 Resolver。
- Loader 管理的 Entry 启动或清理期间，相关生命周期调用方可 `await loader.create()` 声明 Entry，外部服务失效触发的清理也适用；该重入调用只登记条目并返回 `pending` 或适用的 `disabled`，随后再解析、安装，不保证返回时已运行。
- 同类重入中的 `update()`、`move()`、`remove()`、`resolve()` 和 `awaitIdle()` 立即拒绝，避免等待自身生命周期；普通 ACTIVE Root 并发调用仍正常排队。
- `remove()` 开始后，向其目标子树创建条目会在修改树之前拒绝；向其他分支或根创建仍允许。删除后 ID 可以复用，`get()` 与 `entries()` 均不保留旧条目。
- `remove()` 和 Loader 自身卸载都会沿 Core Effect 所有权树尽可能完成后代清理。
- 实例启动与清理经过 Loader 的串行协调队列；重入创建先即时登记，再进入后续协调。`awaitIdle()` 还会等待当前 Entry Fiber 稳定。

## 清理失败与恢复

清理失败（包括启动回滚中的清理失败）会保留最新目标和原错误，并阻止自动重建；Entry 始终显示 `failed`，即使其目标已是 `disabled: true`。Registry 状态变化、`awaitIdle()` 和后续目标修改都不会清除该阻断。

`resolve(id)` 是显式恢复入口，只解除指定 Entry 的清理阻断；各自清理失败的后代需要分别恢复。目标禁用时只解除阻断并转为 `disabled`；目标启用时复用尚有效的 Fiber，或在旧 Fiber 已销毁、安装目标已改变时按最新目标重新安装。该操作不会重新执行已经失败的旧 disposer；旧失败仍可能由 Core 父级最终清理再次报告。

`remove()` 遇到清理失败仍完成能够完成的清理、删除及后续协调，再拒绝其 Promise；尚未显式恢复的旧清理失败也会报告。单个错误保留原对象，多个独立错误使用 `AggregateError`。因此删除 Promise 拒绝不表示 Entry 仍存在，调用方可通过 `get()` 确认最终树状态。

## API

```ts
loader.create(input, parentId?, index?)
loader.update(id, patch)
loader.move(id, parentId, index?)
loader.remove(id)
loader.resolve(id)
loader.get(id)
loader.entries()
loader.awaitIdle()
```

完整类型以包的 `index.d.ts` 为准。

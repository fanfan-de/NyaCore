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

## 生命周期更新

- 只修改 `config` 时复用当前 Fiber，并调用 `fiber.update()`。
- 修改模块名、类型、父级、base URL 或安装覆盖时，只重新安装目标子树。
- 同一父级内调整顺序不会重启组件。
- Component 启动或清理期间可以 `await loader.create()` 声明新 Entry；以当前 LOADING Entry 为父级时，新条目先返回 `pending`，父级 ACTIVE 后自动安装。
- `remove()` 和 Loader 自身卸载都会沿 Core Effect 所有权树完整清理后代。
- 所有结构变更经过 Loader 的串行协调队列；`awaitIdle()` 还会等待当前 Entry Fiber 稳定。

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

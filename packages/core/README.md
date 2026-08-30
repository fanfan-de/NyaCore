# `@nya/core`

`@nya/core` 是 Nya 的 TypeScript 作用域组件运行时。它通过动态 Service 依赖协调 Component 生命周期，并使用 Fiber 和 Effect 管理资源所有权与清理。

> 当前版本为 `0.0.0`，公共 API 尚未进入稳定兼容期。需要 Node.js 22.12 或更高版本。

## 安装

```bash
npm install @nya/core
```

## 基本使用

```ts
import { Context } from '@nya/core'

const app = new Context()
const fiber = app.installComponent((context) => {
  context.effect(() => {
    const timer = setInterval(() => console.log('tick'), 1000)
    return () => clearInterval(timer)
  })
})

await fiber
await fiber.dispose()
```

## 日志与诊断

每个 Context 都提供绑定当前 Fiber 的结构化 Logger。每棵 Root Context 保留最近 1000 条记录；订阅会作为当前 Fiber 的 Effect，在卸载时自动移除。

```ts
const stop = app.logger.subscribe(
  (record) => sendToCollector(record),
  { replay: true, minLevel: 'warn' },
)

app.logger.info('application ready')

try {
  await fiber.restart()
} catch (error) {
  console.dir(fiber.inspect(), { depth: null })
}
```

`fiber.inspect()` 返回冻结的当前 run 与最近失败 run 快照，包括已登记 Effect 的类型、状态和失败路径。Logger、sink 和诊断读取都不会改变生命周期 Promise、原错误身份或清理顺序。

诊断只覆盖通过 Nya Effect、事件、Service、Logger 订阅或组件安装协议登记的资源；未登记的宿主资源无法自动发现，Core 也不会为 cleanup 设置统一超时。需要控制台输出时，可显式安装独立的 `@nya/logger-console` Component；导入 `@nya/core` 本身不会打印日志。

完整说明、当前能力边界和贡献指南见 [NyaCore 仓库](https://github.com/fanfan-de/NyaCore)。

## License

MIT

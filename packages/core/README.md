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

完整说明、当前能力边界和贡献指南见 [NyaCore 仓库](https://github.com/fanfan-de/NyaCore)。

## License

MIT

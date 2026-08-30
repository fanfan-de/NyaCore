# `@nya/logger-console`

`@nya/logger-console` 是 Nya Core 结构化日志流的显式控制台适配器。导入包本身没有副作用；只有安装 `ConsoleLogger` 组件后才会订阅并输出日志。

```ts
import { Context } from '@nya/core'
import { ConsoleLogger } from '@nya/logger-console'

const app = new Context()

app.installComponent(ConsoleLogger, {
  level: 'info',
  replay: true,
})
```

默认配置为 `level: 'info'`、`replay: true`、`timestamps: true`，输出目标为 `globalThis.console`。组件卸载后，订阅会随其生命周期清理。

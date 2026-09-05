# `@nya/core`

`@nya/core` 是 Nya 的 TypeScript 作用域组件运行时。它通过动态 Service 依赖协调 Component 生命周期，并使用 Fiber 和 Effect 管理资源所有权与清理。

> 当前为本地 `0.1.0-rc.1` 发布候选，需要 Node.js 22.12 或更高版本。稳定 `0.1.x` 补丁将维持公开声明与文档行为兼容，破坏性调整进入 `0.2`；候选变更逐项记录迁移。请使用同批 tarball，不假设候选已经发布到 npm。

## 安装

```bash
npm install ./vendor/nya-core-0.1.0-rc.1.tgz
```

## 基本使用

仅从 `@nya/core` 包根导入。内部 Fiber 工厂、协调方法和包内 Symbol 不属于公开接口；创建根使用 `new Context()`，安装使用 `installComponent()`。`Context.services/events` 和导出的低层 Registry 类继续支持，组件作者优先用 Context 的资源托管接口。

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

组件等待依赖时，可查看 `fiber.inspect().dependencies`：它列出必需服务的阻塞原因与已知提供方身份、状态，并区分已注册实现和静态声明候选。诊断不会重复执行 `Service.check`；原有短路解析尚未检查的后续依赖标为 `unchecked`，抛错结果保留原值。

诊断只覆盖通过 Nya Effect、事件、Service、Logger 订阅或组件安装协议登记的资源；未登记的宿主资源无法自动发现，Core 也不会为 cleanup 设置统一超时。需要控制台输出时，可显式安装独立的 `@nya/logger-console` Component；导入 `@nya/core` 本身不会打印日志。

完整说明、当前能力边界和贡献指南见 [NyaCore 仓库](https://github.com/fanfan-de/NyaCore)。

## License

MIT

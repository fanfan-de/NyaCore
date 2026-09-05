# `@nya/timer`

`@nya/timer` 提供由 Nya Effect 管理的最小定时器服务。导入包没有副作用，安装 `Timer` 后通过 `ctx.timer` 使用。

当前候选为 `0.1.0-rc.1`，需要 Node.js ≥22.12.0 和 Core peer `^0.1.0-rc.1`。从同批 `vendor/` 安装 Core 与 Timer tarball；不支持混用 `0.0.x` 或 `0.2.x` Core。候选尚不表示已发布到 npm。

资源归属模式参考 [Cordis Timer](https://github.com/cordiverse/cordis/blob/main/packages/timer/src/index.ts)，本包通过 Nya 的 Service 调用方语义和 Effect 清理协议实现。

```ts
import { Context } from '@nya/core'
import { Timer } from '@nya/timer'

const app = new Context()
await app.installComponent(Timer)

const worker = app.installComponent({
  name: 'worker',
  inject: ['timer'],
  apply(ctx) {
    ctx.timer.interval(() => {
      ctx.logger.info('tick')
    }, 1000)
  },
})
await worker

// 卸载调用方会取消它创建的定时器。
await worker.dispose()
await app.fiber.dispose()
```

`Timer extends Service`，提供 `timeout(callback, delay)` 和 `interval(callback, delay)`，两者都返回 Core `Disposer`。回调类型为 `() => void | Promise<void>`；没有参数透传、Promise 延时重载或 Context 方法别名。

定时器 Effect 属于调用方的当前 Effect 作用域，嵌套 Effect 撤销时也会清理。手动取消和调用方卸载可重复执行。`timeout` 触发时先发起自身 Effect 注销，再运行回调；不会在完成后留下一个持续登记的计时器资源。依赖 `timer` 的组件也会在服务 Provider 被撤销时按 Core 的依赖规则卸载；Root 直接调用创建的定时器则由 Root 自己拥有。

`delay` 必须是有限数值：`timeout` 接受 0 到 2147483647，`interval` 接受 1 到 2147483647，单位毫秒。有限小数沿 Node 定时器规则截断；`timeout` 的 0 使用 Node 的最小延迟，不同步调用回调。

同步抛错和异步拒绝会停止这个定时器的后续调度，并通过调用方 Logger 记录原错误值；不会自动把调用方 Fiber 标记为失败。已开始的其他回调仍各自受到错误观察。

清理只取消未来调度，**不等待已开始的回调**，因此回调可以等待卸载自身。`interval` 使用原生间隔，较慢的异步回调可能重叠。业务需要串行执行或退出前等待写入时，应另外跟踪在途任务，并在拥有这些任务的业务清理流程中等待它们。

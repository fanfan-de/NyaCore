# 排查依赖等待并构建重启应用

> 状态：Current<br>
> 类型：How-to<br>
> 适用范围：Core 依赖诊断、Timer 与 task-journal 开发宿主

## 找出组件为什么没有启动

`await fiber` 与 `await loader.awaitIdle()` 只等待生命周期稳定。若组件仍为 `PENDING`，直接读取它的依赖诊断：

```ts
console.dir(fiber.inspect().dependencies, { depth: null })
```

由 Loader 管理的组件可以使用稳定 Entry ID 查询同一份诊断，无需找到内部 Fiber：

```ts
const entry = app.loader.get('job')
console.dir({
  state: entry?.state,
  blockedBy: entry?.blockedBy,
  dependencies: entry?.dependencies,
}, { depth: null })
```

先看 `blockedBy`：父 Entry 未就绪时，子组件可能还没有安装，此时空依赖列表不能证明子组件已经就绪。转而检查那个父 Entry。若已经安装，依赖列表中的 `serviceName` 指向正在等待的服务，`providers` 显示当前已知提供者的组件名、Fiber ID 和状态。

- `missing`：当前隔离地址没有服务实现。确认提供组件已经安装，并检查消费者与提供者使用的隔离标签是否一致。
- `provider-inactive`：已知提供者尚未进入 `ACTIVE`。继续查看该提供者的状态、依赖诊断或最近失败；异步初始化尚未完成时不要把等待结束误当成就绪。
- `implementation-unavailable`：提供方仍为 `ACTIVE`，但实现正在失效或它的来源已不可用。等待相关清理稳定，并检查提供方的依赖来源。
- `check-false`：实现已存在，但最近一次依赖解析中 `Service.check` 返回了假值。检查服务自己的就绪条件；条件改变后需要通过已有生命周期更新或依赖刷新触发重新判断。
- `check-threw`：最近一次检查抛出了错误。按 `reason` 判断这类失败，再读取 `error`；抛出值可能就是 `undefined`，不能依赖错误值的真假。

`unchecked` 表示现有依赖解析在更早的依赖处停止，还没有执行这个服务的检查。先处理已经确定的阻塞。读取诊断不会额外执行 `Service.check`，也不会自动重试组件。

提供者标为 `declared` 时，仅说明已安装的 Service 类通过静态 `provide` 声明了这个服务名，不代表已经提供了实例。普通组件可以在任意代码路径调用 `ctx.provide()`；首次提供之前，框架无法推断它会提供哪些服务。已销毁的安装不会为此保留历史实例引用。

诊断是冻结快照。要观察恢复后的状态，应再次查询；已有快照不会跟随运行时变动。隔离仍然是服务解析规则，不是权限或安全沙箱。

## 让定时器随调用组件清理

安装 `@nya/timer` 的 `Timer` 服务，再让使用它的组件声明依赖。下面的定时器属于 `worker`，销毁 `worker` 会撤销后续调度：

```ts
import { Context } from '@nya/core'
import { Timer } from '@nya/timer'

const app = new Context()
await app.installComponent(Timer)
const worker = app.installComponent({
  inject: ['timer'],
  apply(ctx) {
    ctx.timer.timeout(() => ctx.logger.info('one tick'), 100)
    ctx.timer.interval(() => ctx.logger.info('heartbeat'), 1000)
  },
})
await worker
// 宿主结束业务时：
await worker.dispose()
await app.fiber.dispose()
```

两种方法都返回可以重复调用的 disposer。timeout 触发后会自行释放登记；interval 保持原生固定间隔，异步回调可能重叠。需要串行任务时，像 [task-journal 任务组件](../../examples/task-journal/src/components/job.ts) 一样，在本次写入完成后再安排下一次 timeout。

Timer 撤销调度时不等待已经开始的回调。组件仍需用自己的 Effect 等待在途 I/O；示例中的任务 Effect 就负责等待文件写入。回调失败会记录原错误并停止该定时器，业务是否退出由应用自己的失败通道决定。完整用法见 [Timer README](../../packages/timer/README.md)。

## 修改、构建、重启独立应用

先按 [独立应用教程](../tutorials/task-journal.md) 取得并安装应用目录，然后运行：

```bash
npm run dev -- --config ./config.json
```

修改 `src/components/job.ts` 并保存。开发宿主会合并连续保存，先请求旧进程关闭并等待资源清理，再构建 TypeScript，构建成功后启动新的 Node 进程。编译错误会显示在终端，应用保持停止；修复并保存后会重新构建。它不会用旧的 JavaScript 冒充本次构建成功。

开发模式关注应用源码、TypeScript 配置与指定的 JSON 配置文件，不监听数据文件、构建输出或 `node_modules`。修改配置会触发完整重启；普通 `npm start` 仍只在启动时读取配置。

按 Ctrl+C 停止开发宿主。退出和重启使用同一条有期限的关闭路径；重复信号不会延长期限。Windows 下通过父子进程 IPC 请求应用清理，而不是把 `child.kill('SIGTERM')` 当作优雅关闭。旧应用不能在期限内退出时，会强制结束并停止开发宿主，避免继续启动第二个实例。

在 monorepo 内开发示例，可从仓库根目录运行：

```bash
npm run dev:example -- --config ./config.json
```

这个命令先构建框架包，再进入示例目录的开发宿主；相对配置路径以示例工作目录为准。框架包源码修改后，停止开发宿主并重新运行该命令，以完成整套包的构建。需要手动控制每一步时，依次使用 `npm run build` 和 `npm start`。

每次启动都有新的进程与模块定义，不使用模块缓存失效或组件热替换。进程等待策略属于示例宿主，Core 的初始化、清理 Promise 和错误身份保持原来的语义。

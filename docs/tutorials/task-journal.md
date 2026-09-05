# 从独立安装到嵌入：构建任务日志应用

> 状态：Current<br>
> 类型：Tutorial<br>
> 适用范围：Node.js 22.12+、任务日志示例与 Nya 的公开包 API

本教程会运行一个定期写入 JSONL 文件的小程序，观察任务更新、启停和依赖恢复，再把同一应用放进自己控制的 Node.js 程序。完成后，你会得到可脱离 monorepo 运行的目录，并能区分组件生命周期和宿主进程生命周期。

这里使用 [task-journal 示例](../../examples/task-journal/README.md)。无需数据库或外部服务；准备 Node.js 22.12 或更高版本，以及可安装项目依赖的 npm 环境即可。

## 1. 生成可搬移的应用目录

在 NyaCore 仓库根目录执行：

```bash
npm install
npm run example:pack
```

命令构建 Nya 发布包，再把示例及本地包归档放进 `artifacts/task-journal/`。这个目录同时包含 TypeScript 源码、JavaScript 构建输出、测试、配置和安装所需的 `vendor/*.tgz`。

把整个 `artifacts/task-journal/` 目录复制到仓库外的任意工作位置，然后进入复制后的目录。保留 package.json 和 `vendor/` 的相对位置；无需复制 monorepo 的 `node_modules`。

```bash
npm install
npm run build
npm run demo
```

从这里开始，本教程中的命令都在这个独立目录内执行。安装使用本地 Nya 归档，TypeScript 等其他依赖仍按 npm 配置获取；不要把“可独立安装”理解为“无需网络”。

## 2. 观察真正的组件协作

demo 会等待真实记录事件完成每个阶段，结束时关闭应用。打开 `data/tasks.jsonl`，可以看到每行一个 JSON 对象，包含记录序号、时间和标签；后续运行会继续追加内容。

应用中有两个主要组件：

- 存储组件打开文件并提供追加记录的服务，清理时等待写入完成并关闭文件。
- 任务组件通过 `inject` 声明存储依赖，创建定时任务并写入记录，清理时停止继续调度。

它们由 Loader 的稳定 Entry 管理。`business` Group 建立共同的所有权边界，下面的 `job` 表示任务条目，`storage` 表示存储条目；控制台 Logger 和 Timer 服务是单独安装的组件。可以先阅读 [应用组合](../../examples/task-journal/src/application.ts)，再看 [存储](../../examples/task-journal/src/components/storage.ts) 与 [任务](../../examples/task-journal/src/components/job.ts) 的实现。

启动时先创建任务条目，此时还没有存储服务，程序检查其状态为 `pending` 并记录 `job pending: waiting for journalStore`。接着创建存储条目，等到存储和任务都进入 `active`，应用才报告启动完成。这个顺序展示了消费者可以先于提供者存在。

`await fiber` 或 `await fiber.awaitStable()` 只表示当前生命周期转换已稳定，稳定状态仍可能是 `PENDING`，不等同于服务已经可用。应用因此会在等待后显式检查必需 Fiber 的 `ACTIVE` 状态，以及必需 Loader Entry 的 `active` 状态，再让宿主输出 `application ready`。

演示按下面的顺序检查行为：

1. 等到初始任务写入记录。
2. 提交新的完整任务配置，等到新标签的记录。
3. 禁用任务，再恢复任务，等到恢复后的记录。
4. 禁用存储，观察任务因为依赖缺失而停止；恢复存储，再等到任务写入记录。
5. 关闭应用，等待任务与存储资源完成清理。

记录写入后会发出 `journal/record` 事件，demo 使用这个事件推进，而不是根据固定 sleep 判断执行结果。业务失败通过 `journal/failure` 汇入应用的首个失败通知。业务演示流程在 [demo.ts](../../examples/task-journal/src/demo.ts)，关闭由外层宿主完成；组件入口本身不会为了常驻运行而等待一个永不结束的 Promise。

## 3. 改成持续运行的程序

独立目录已经提供 [默认配置文件](../../examples/task-journal/config.json)。先修改 `job.label`，再运行：

```bash
npm start -- --config ./config.json
```

程序会持续追加记录。观察几条新行后按 Ctrl+C，宿主会请求关闭并等待资源清理。配置文件不会被自动监听，修改文件后需要重新启动；下一节会展示运行中的应用 API 更新。

默认任务在每次写入完成后等待 1000 毫秒再调度下一次，首次也等待这个间隔；标签为 `heartbeat`，写入 `./data/tasks.jsonl`，控制台日志级别为 `info`。配置中的相对存储路径以配置文件所在目录为起点：把配置移到 `settings/config.json` 后，相同的 `./data/tasks.jsonl` 就指向 `settings/data/tasks.jsonl`。

不传 `--config` 时，CLI 读取当前工作目录中的 `config.json`。缺少该文件会报告配置错误；若想使用默认值，可以提供一个内容为 `{}` 的文件。配置完整形状、校验和默认值以 [config.ts](../../examples/task-journal/src/config.ts) 及其导出类型为准。

```bash
npm start -- --help
```

帮助列出当前 CLI 参数。配置错误的退出码为 2；启动、运行、清理错误和超时为 1；帮助和 demo 正常完成为 0。成功处理 SIGINT 与 SIGTERM 分别为 130 和 143。如果信号关闭期间发生清理错误或超时，失败码 1 优先。

## 4. 在自己的程序中控制应用

`createApplication(config)` 返回的是应用实例。它公开 `context` 供事件和诊断使用，`start()` 负责启动，`updateJob()` 接收完整任务配置，`setEnabled()` 控制 `job` 或 `storage`，`close()` 清理整棵应用资源树。

在独立目录中新建 `embedded.mjs`。下面的完整脚本自行定义一个输出绝对路径，启动应用，并调用相同的有限演示流程。它不启动命令行宿主，也不会安装进程信号处理器：

```js
import { resolve } from 'node:path'
import { createApplication } from './dist/application.js'
import { runDemo } from './dist/demo.js'

const config = {
  storage: { file: resolve('data/embedded-tasks.jsonl') },
  job: { intervalMs: 100, label: 'embedded' },
  logLevel: 'info',
  startupTimeoutMs: 10000,
  shutdownTimeoutMs: 10000,
}

const application = createApplication(config)
const errors = []

try {
  await application.start()
  await runDemo(application, config)
} catch (error) {
  errors.push(error)
}

try {
  await application.close()
} catch (error) {
  // close 再次报告同一个原始错误时，不重复包装它。
  if (!errors.some(previous => Object.is(previous, error))) errors.push(error)
}

if (errors.length === 1) throw errors[0]
if (errors.length > 1) throw new AggregateError(errors, 'application and cleanup failed')
```

```bash
node embedded.mjs
```

检查 `data/embedded-tasks.jsonl`，确认这个文件独立于 CLI 默认输出。仓库的外部消费者检查会从本教程提取这段完整脚本，在仓库外安装、构建后的应用目录中执行它。

脚本先保存启动或业务错误，再独立尝试关闭。只有一个错误时抛出原对象；业务和清理产生两个不同错误时才用 `AggregateError` 同时保留，避免关闭异常覆盖先前失败。

接入自己的界面或服务器后，可以把 `runDemo()` 换成宿主控制的工作流程。例如在应用启动后执行以下操作：

```js
await application.updateJob({ intervalMs: 250, label: 'from-host' })

await application.setEnabled('job', false)
await application.setEnabled('job', true)

await application.setEnabled('storage', false)
await application.setEnabled('storage', true)
```

这些调用等待各自的生命周期协调。禁用任务表示暂时不运行这个条目；禁用存储则让仍启用的任务等待依赖，恢复存储后再启动。示例不会通过绕过 Loader 的额外定时器模拟这些状态。

`application.failure` 会以首个业务或生命周期错误值 resolve，供现有宿主与请求结束、窗口关闭或其他终止条件竞速。它不是启动 Promise，也不会在正常关闭时 resolve；无效任务配置等入口校验错误由相应 API 拒绝报告。若宿主采用拒绝传播，可以在竞速分支中转换它：

```js
const failed = application.failure.then(error => { throw error })
await Promise.race([hostFinished, failed])
```

这里的 `hostFinished` 由你的宿主提供，表示它自己的工作已结束；这是接入片段，需放进上例的错误收集与关闭流程，保证关闭仍会执行且不会覆盖原错误。不要只等待 `start()` 就认为后续运行不会失败。

## 5. 明确谁决定程序退出

应用层不会读取命令行、监听 SIGINT / SIGTERM 或调用 `process.exit()`。同一应用可以由 CLI 管理，也可以由服务器、桌面程序或测试管理。重复或并发调用 `close()` 返回同一个 Promise，宿主可以让多条终止路径共同等待一次清理。

命令行宿主根据 `startupTimeoutMs` 和 `shutdownTimeoutMs` 限制启动、关闭的等待时间，默认各为 10000 毫秒。关闭时同时等待应用资源清理和已启动的 demo 收尾；它们共用一次关闭期限，重复信号不会延长期限。直接调用应用 API 时不会自动获得这些期限，嵌入者按自己的运行环境决定等待策略。

关闭期限到达后，CLI 通过宿主的 `forceExit` 边界结束进程。此时不能推断 cleanup 已完成或记录已全部落盘：Core 没有取消任意 JavaScript 清理函数的能力，超时只是宿主停止等待的决定。这个分工记录在 [ADR-0011](../adr/0011-application-host-lifecycle.md)，该 ADR 仍为 Proposed；当前示例行为应以源码和测试为证据。

## 6. 验证修改后的应用

修改独立目录中的 TypeScript 源码后运行：

```bash
npm run build
npm test
npm run demo
```

测试覆盖组件、应用组合与宿主边界；demo 再通过真实文件和记录事件检查可观察行为。Nya 的核心资源协议可继续阅读 [Effect 与生命周期说明](../concepts.md)，独立包的运行步骤可随时回到 [示例 README](../../examples/task-journal/README.md)。

需要保存代码后自动构建、清理旧进程并重新启动时，在独立目录运行 `npm run dev -- --config ./config.json`。编译失败时会保持停止，修复后保存会重试；源码、配置更新与依赖等待的排查步骤见[开发操作指南](../how-to/development.md)。

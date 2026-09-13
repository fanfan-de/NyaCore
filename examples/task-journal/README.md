# Task Journal：独立运行任务日志示例

> 状态：Current<br>
> 类型：How-to<br>
> 适用范围：Node.js 22.12+、`@nya/core`、`@nya/loader`、`@nya/logger-console`、`@nya/timer`

这个程序定期向 JSONL 文件追加任务记录，并演示任务配置更新、组件启停和存储依赖恢复。应用组合层可以嵌入其他程序，命令行宿主负责配置文件、进程信号和退出时限。

## 1. 取得独立目录

如果从 NyaCore 源码开始，在仓库根目录执行：

```bash
npm install
npm run example:pack
```

生成的 `artifacts/task-journal/` 包含 `src/`、`dist/`、`tests/`、`config.json`、本说明、package.json、TypeScript 配置和 `vendor/` 中的 Nya 包归档。可以把整个目录复制到仓库之外。已有这个完整目录时，直接进行下一步。

请保留 `vendor/` 与 package.json 的相对位置。Nya 依赖从其中的 `.tgz` 安装；其他依赖仍由 npm 按当前配置获取，这不是完全离线安装包。

## 2. 安装并构建

进入取得的独立目录后执行：

```bash
npm install
npm run build
npm run demo
```

demo 会根据实际写入记录的事件推进，依次更新任务、禁用和恢复任务、禁用和恢复存储，最后关闭应用。正常结束的退出码是 0；输出文件位于配置指定的位置。默认使用 `data/tasks.jsonl`，每行是一个带有 `sequence`、`recordedAt` 和 `label` 的 JSON 对象。

记录采用追加写入，重复运行会保留之前的内容。演示中的标签变化用于区分不同阶段；它不依靠固定等待时长猜测任务是否执行。

开发时运行 `npm run dev -- --config ./config.json`。保存 `src/` 下的代码、TypeScript 配置或指定的配置文件后，宿主先等待旧应用关闭，再构建并启动新进程。编译失败时保持停止，修复后再次保存即可继续；连续保存会合并处理。Ctrl+C 会清理应用和监听资源。清理失败或超时会停止开发宿主，需要处理错误后重新启动。

开发重启通过 IPC 请求旧应用清理，Windows 下也经过应用 `close()`；它不是模块 HMR。开发脚本只关注本应用，不监听 `data/`、`dist/` 或安装包的源码。修改框架包后，应在仓库重新构建并生成应用产物。

## 3. 持续运行

```bash
npm start -- --config ./config.json
```

使用 Ctrl+C 请求关闭。宿主停止任务并等待已登记资源清理，成功处理 SIGINT 后使用退出码 130；SIGTERM 对应 143。这两个退出码表示由信号结束，不表示清理失败。

编辑随目录提供的 [config.json](./config.json) 后重新启动。例如先修改 `job.label`，再修改 `job.intervalMs`，观察新增行中的标签与写入频率。持续运行时不会自动重读配置文件；应用内的即时更新通过 `updateJob()` 完成。

相对 `storage.file` 从**配置文件所在目录**解析。例如使用 `--config ./settings/config.json` 且文件中写着 `./data/tasks.jsonl`，输出会进入 `settings/data/tasks.jsonl`，而不是启动命令所在目录下的 `data/`。

不传 `--config` 时读取当前工作目录的 `config.json`。文件必须存在；一个内容为 `{}` 的文件会应用默认值：存储路径 `./data/tasks.jsonl`、间隔 1000 毫秒、标签 `heartbeat`、日志级别 `info`，启动与关闭时限各 10000 毫秒。

## 4. 查看帮助与检查失败

```bash
npm start -- --help
npm test
```

帮助和成功 demo 使用退出码 0，配置错误使用 2，启动、运行、清理失败或超时使用 1。信号触发的关闭如果又发生失败或超时，也使用 1。

`startupTimeoutMs` 和 `shutdownTimeoutMs` 控制宿主等待时间。关闭超时时，命令行宿主强制结束进程；这不代表 Core 取消了 cleanup，也不能据此断言尚未完成的写入已经落盘。

## 5. 嵌入已有程序

从构建后的 `dist/application.js` 导入 `createApplication(config)`，由现有宿主调用 `start()`，最后等待 `close()`。创建应用不会安装进程信号处理器或直接退出进程。`close()` 的并发调用共享同一个 Promise。

运行期间可以调用 `updateJob({ intervalMs, label })` 提交完整任务配置，以及 `setEnabled('job', enabled)` 或 `setEnabled('storage', enabled)` 切换组件。禁用存储会使仍然启用的任务等待依赖，恢复存储后任务重新运行。

等待原因可通过 `application.context.loader.get('job')?.dependencies` 查看，包含阻塞服务、已知提供者状态和最近一次 `Service.check` 结果。诊断读取不会重跑检查。任务通过公开 Timer 服务调度 timeout，并由任务自己的 Effect 等待在途文件写入。

宿主还应观察 `failure`：它以首个原始错误值 resolve，正常运行或正常关闭不会主动完成这个 Promise。嵌入者自行决定如何报告错误、何时关闭，以及是否施加启动或关闭时限。

具体类型和可运行实现见 [application.ts](./src/application.ts)、[demo.ts](./src/demo.ts) 与 [main.ts](./src/main.ts)。本地存在 `docs/tutorials/task-journal.md` 时可阅读完整学习过程，该教程不随 Git 克隆提供。

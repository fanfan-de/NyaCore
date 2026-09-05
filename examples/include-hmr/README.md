# 运行 Include 与 HMR 示例

这个示例读取两个 JSON 文件，启动一个定时打印消息的组件。修改消息配置会更新运行；修改间接依赖 `message.mjs` 会在同一进程中使用新代码。

## 从仓库运行

在仓库根目录安装依赖后执行：

```bash
npm run dev:include-hmr
```

依次尝试以下操作：

1. 把 `jobs.json` 中的 `"message": "hello"` 改成其他内容，观察新输出。
2. 把 `message.mjs` 中的 `message v1` 改成 `message v2`，观察旧组件先停止、新组件随后输出；HMR 日志中的 PID 保持。
3. 在 worker 条目中加入 `"disabled": true`（注意字段间的逗号），停止组件；删去该字段后恢复。
4. 暂时把 JSON 改成无效格式，观察配置错误和原有运行；修正后自动恢复刷新。
5. 按 Ctrl+C，等待组件和文件监听关闭。

只验证启动和清理时，可在构建后执行 `node examples/include-hmr/main.mjs --once`。

## 从候选目录独立运行

仓库执行 `npm run release:pack` 后，把生成的整个 `artifacts/release-candidate/` 复制到仓库外。在其中执行：

```bash
cd include-hmr
npm install
npm start
```

候选中的依赖已经指向本地 `../vendor/` 归档，应保留它们的相对位置。传递依赖仍需要 npm 安装，不代表离线包。源码目录的版本号不表示候选已发布到 npm。

## 宿主关闭

`main.mjs` 在 Ctrl+C / SIGTERM 时等待 Root 清理；超过 5 秒才由这个可执行宿主强制退出，并报告清理未确认完成。库自身不会调用 `process.exit()`。

包依赖、锁文件、构建配置变化或版本缓存达到上限时，HMR 请求重启。示例先关闭并以 75 退出；确认旧进程结束后再运行 `npm start`。需要全自动重启时，由上层进程管理器处理该退出状态。

持久化编辑 API、文件限制见[Include README](../../packages/include/README.md)，代码支持范围和失败语义见[HMR README](../../packages/hmr/README.md)。本示例及打包后的启动/退出由仓库消费者检查覆盖。

# @nya/hmr

监听配置文件，并在同一个 Node 进程中替换本地组件代码。它使用 Loader 的公开版本检查与替换协议；进程退出和重启由宿主决定。

需要 Node.js ≥22.12 和同批的 `@nya/core`、`@nya/loader`。配置监听通过结构化控制器接口接入[Include](../include/README.md)，代码模式也可以独立使用。

## 使用

```js
import { Hmr } from '@nya/hmr'

// app 已安装 Loader 和 Include；不要在组件自己的启动中反向等待控制器。
await app.installComponent(Hmr, {
  entries: [new URL('./worker.mjs', import.meta.url).href],
  include: app.include,
  onReport(report) { console.log(report.status, report.phase) },
})
await app.hmr.start()
```

`start()` 先准备代码 Resolver，再读取配置，因此 Include 可以直接声明受管的 TypeScript 文件。仅提供 `include` 可只监听配置；`watch: false` 关闭自动监听，使用 `reload()` 显式重试。完整可运行宿主见[专用示例](../../examples/include-hmr/README.md)。

## 替换过程

HMR 读取静态本地依赖图，使用固定的 TypeScript 5.9.3 检查 TS，再输出保留模块边界的 ESM 版本目录。所有受影响入口及其共享本地模块使用同一代路径，因此原生循环导入和共享对象身份得以保留。只给入口加查询参数无法做到这一点。

候选通过检查并完成导入后，Loader 检查准备前的声明版本，先清理整个替换集合，再提交定义及后续解析映射。Entry ID、配置和禁用状态保持；新的 Fiber 承载新代码。无关代码分支保持运行，所有权后代及服务消费者可能随 Core 依赖传播重新安装。

无效配置、构建和导入错误会报告相应阶段；准备阶段不停止旧运行。模块顶层代码已经执行的副作用无法撤销，应把长期资源登记到组件 Effect 中。清理失败阻止候选提交，需要显式恢复；启动失败可能在定义已提交后发生。

`rollback()` 使用保留的上一代定义再次执行清理和安装，既不还原配置文件，也不恢复任意业务内存。之后的 reload 或文件事件仍以磁盘源码为目标。返回的 `entries` 仍需检查依赖等待和失败。

## 支持边界

- 本地 ESM `.js` / `.mjs` / `.ts` / `.mts`、静态导入/导出、字面量动态导入，以及带 Node 导入属性的 JSON。相对 `.js` / `.mjs` 不存在时可映射到 TS 源文件。
- 裸 npm 包从原始导入者位置按 ESM 条件解析，并保持外部模块身份，包括 Core；npm 依赖本身不热替换。入口必须显式列出，不自动将任意新配置名称加入代码构建。
- `import.meta.url`、`dirname`、`filename` 指向原始源码位置；字面量 `new URL('./asset', import.meta.url)` 的资源会被追踪。任意运行时读文件不会自动成为构建依赖。
- TS 强制 strict，可指定 `tsconfig`；不承诺实现打包器的路径别名、插件、CSS、Wasm、原生扩展和 CommonJS 转换。非字面量动态导入、运行时 require/eval、其他 import.meta 用法报告需要宿主重启。
- watcher 监听目录并合并事件，支持文件替换、暂时删除与重建。配置回写只产生无差异协调。更改包清单、锁文件或指定 tsconfig 会持续报告 `restart-required`；宿主重启后重新读取环境。
- `close()` 立即停止监听并取消尚未提交的候选，等待已经进入的导入与生命周期操作收尾。永久不结束的用户 Promise 仍由宿主设置期限。
- Node ESM 缓存无法主动卸载。默认最多导入 100 代（失败导入也计数），之后报告需要重启。版本产物归 Root 生命周期，HMR 卸载后当前 Loader 仍可使用它们。Root 清理稳定后异步删除文件，使组件 cleanup 的延迟导入仍可用；Root 的 dispose 不等待这次磁盘回收，回收失败记入 Root 日志。释放 Node 历史模块缓存需要进程退出。

报告包含阶段、代数、PID、实际快照和原始错误。观察回调失败只写日志。公开类型见[生成的 API 基线](../../api/hmr.api.txt)，实际支持与验收范围见[兼容政策](../../docs/compatibility.md)。

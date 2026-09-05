# @nya/include

把 JSON 声明文件同步到 Loader 的 Entry 树。Include 管理读取、预览和保存；组件启动、依赖等待与资源清理仍由 Loader / Core 完成。

需要 Node.js ≥22.12 和同批的 `@nya/core`、`@nya/loader`。候选通过本地 tarball 安装，版本与边界见[兼容政策](../../docs/compatibility.md)。

## 使用

`config.json`：

```json
{
  "version": 1,
  "entries": [
    { "id": "jobs", "type": "include", "path": "./jobs.json" },
    { "id": "worker", "name": "./worker.mjs", "config": { "message": "hello" } }
  ]
}
```

`jobs.json` 可以从 `{ "version": 1, "entries": [] }` 开始。宿主在安装稳定后显式加载：

```js
import { fileURLToPath } from 'node:url'
import { Context } from '@nya/core'
import { Loader } from '@nya/loader'
import { Include } from '@nya/include'

const app = new Context()
await app.installComponent(Loader)
await app.installComponent(Include, {
  path: fileURLToPath(new URL('./config.json', import.meta.url)),
  id: 'app',
})
const report = await app.include.refresh()
console.log(report.status, report.entries)
// 宿主结束时等待资源清理。
await app.fiber.dispose()
```

保存时传入完整来源文档：`await app.include.save(nextDocument)`。先调用 `preview(nextDocument)` 可以查看即将执行的树操作。编辑子文件时，把 `sources()` 返回的该文件绝对路径作为第二个参数。

## 行为

- 一个 Include 独占挂载根。文件内 ID 在整份文件中唯一，普通分组不改变身份；子文件通过 include 挂载 ID 建立命名空间。用 `entryId(localId, mountIds)` 获取 Loader ID。宿主应通过该控制器修改受管声明。
- 子文件相对包含它的文件定位，组件默认相对所属文件目录解析。普通组继承 Loader 基址覆盖；字符串隔离标签转换为该挂载内稳定的 Symbol。
- 完整来源图通过格式、身份、来源冲突和树规划检查后才改变运行。循环包含、重复挂载同一真实文件、无效格式均保留上次接受的运行。
- 保存只写指定来源，先检查读取时的内容摘要，再写同目录临时文件并重命名；检测到外部编辑抛出 `ConfigConflictError`。这是冲突检测和单文件替换，不是跨进程锁、跨文件事务或断电持久性保证。
- 文件保存成功后，启动或清理仍可能失败。报告分别给出 `saved`、`status` 和运行快照；失败目标保留在磁盘。依赖 PENDING 不等于失败或应用就绪。修正外部条件后显式调用 `recover(loaderId)`。
- 未变化的声明不重启；清除可选字段会传递显式清除操作。保留条目先迁出，再删除旧祖先。删除预览列出随祖先清理的动态后代；挂载根以外的条目保持独立。
- 根文件和所有 include 来源只接受 `.json`，使用标准 JSON 语法；不支持 YAML、JSONC、注释或尾随逗号。配置只接受无损 JSON 数据，函数、Symbol、循环引用、访问器、稀疏数组等会被拒绝。保存使用两空格缩进并添加末尾换行。
- `close()` 停止本控制器并移除其挂载树，文件保留。它不结束宿主进程。生命周期内反向等待本控制器会被拒绝。

文件监听由[可选 HMR 包](../hmr/README.md)提供。可运行组合见[专用示例](../../examples/include-hmr/README.md)，导出类型见[生成的 API 基线](../../api/include.api.txt)。

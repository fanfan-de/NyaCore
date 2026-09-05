# ADR-0013：发布契约与宿主模块解析

> 状态：Proposed<br>
> 类型：ADR<br>
> 日期：2026-09-05

## 背景

运行时和独立应用已经形成可验证流程，但初始开发版的 Core peer 范围接受任意版本，声明还暴露了包内协调方法。包检查中的自定义 Resolver 只能证明安装协调，无法证明宿主自己的模块和插件可被默认 Resolver 找到。发布候选需要可审查的 API 边界、迁移记录和真实安装证据。

## 决策

四包使用同一 `0.1.0-rc.1` 候选版本，以 tarball 交付，不在生成产物时发布 npm。稳定 `0.1.x` 补丁保持公开类型和文档行为兼容，破坏性变更进入 `0.2`；候选变更单独记录。外围 Core peer 收紧到 `^0.1.0-rc.1`，具体版本规则写入兼容政策。

公共边界由 package exports 和发布声明共同表达。隐藏包内 `@internal` 方法与 Symbol 成员，移除无用户端用途的三个索引类型；保留现有低层公开注册表和依赖刷新能力。构建后生成声明图基线，消费者同时验证可用入口与内部入口拒绝访问。基线只辅助评审，不能替代行为测试。

默认 Resolver 在显式 file 基址下按 ESM 规则解析相对文件与裸包，再调用原生 import。目录基址使用同目录虚拟父模块进行包作用域解析。无基址相对名称拒绝，无基址裸包保留原生 Loader 模块相对行为。宿主始终显式传基址以获得可预测的插件查找位置。

Node 22.12 的 `import.meta.resolve` 第二个 parent 参数仍需实验标志；`createRequire().resolve()` 使用 require 条件，会选错 ESM 插件的导出分支。因此使用固定版本 `import-meta-resolve@4.2.0`，不要求宿主开启实验标志。它不能接管任意 Node 加载钩子；特殊条件、符号链接或自定义加载器策略保留给自定义 Resolver。模块缓存不失效，失败恢复不扩展成 HMR。

教程中的完整程序从 Markdown 提取，在外部目录安装真实候选、重新编译并运行。默认 Resolver 验收必须加载真实文件和经 npm pack/install 的插件，并验证资源清理，不能只断言 Resolver 被调用。

## 后果

- 从 `0.0.0` 迁移需要统一包版本、替换内部导入，并为相对模块设置宿主基址。
- 维护者必须审查声明差异、行为回归和迁移说明，才能主张稳定补丁兼容。
- Loader 增加一个固定版本的运行依赖；Core 继续不承担 Node 模块查找和宿主进程策略。
- 本地候选可复制安装，但传递依赖与编译工具首次安装仍可能需要网络；tarball 不是离线 npm 仓库。

## 考虑过的替代方案

只列导出名不能发现类成员和可达类型泄漏；手写 API 参考容易漂移。全部隐藏低层 Registry 会扩大迁移成本，本轮保留。强制用户启用 Node 实验标志会增加薄宿主的负担；用 CommonJS 解析代替 ESM 会产生可见的插件差异，因此均不采用。

## 关联

- [兼容承诺](../compatibility.md)、[迁移指南](../how-to/migrate-0.1.md)和[入门教程](../tutorials/framework-basics.md)。
- [ADR-0009](./0009-loader-entry-tree.md)：延续稳定 Entry 与外围边界，细化默认 Resolver 的宿主基址规则。
- [Node 22.12 ESM 文档](https://github.com/nodejs/node/blob/v22.12.0/doc/api/esm.md#importmetaresolvespecifier)：父模块参数与解析行为。
- [import-meta-resolve](https://github.com/wooorm/import-meta-resolve)：显式父模块解析与加载钩子边界。

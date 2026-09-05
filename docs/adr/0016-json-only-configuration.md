# ADR-0016：Include 仅支持 JSON 配置文件

> 状态：Proposed<br>
> 日期：2026-09-06<br>
> 范围：Include 文件协议、示例宿主、配置迁移与发布验证

## 上下文

维护者决定将配置格式统一为 JSON。原有 JSON 与 YAML 最终使用同一份 `IncludeDocument`，但 YAML 需要额外解析依赖、文档节点写回、注释处理和格式测试。统一格式可以减少维护分支，并让程序生成、编辑和校验使用同一套标准 JSON 数据。

本决策收敛[Include 与 HMR 实施计划](../include-hmr-plan.md)中的文件格式范围；[ADR-0014](./0014-config-persistence-boundary.md)的声明归属、先保存后协调和冲突语义继续适用。

## 决策

1. Include 的根配置和全部跨文件来源只接受 `.json`，扩展名大小写不敏感。读取使用标准 JSON 语法，不接受 YAML、JSONC、注释或尾随逗号。
2. 预览和保存提供替代文档时，同样检查来源扩展名；不能绕过格式约束。格式错误发生在改变运行树或写入文件之前。
3. JSON 保存使用两空格缩进与末尾换行。移除 YAML 解析和注释回写逻辑，以及 Include 的 `yaml` 运行依赖。
4. 多文件挂载、稳定声明身份、来源查询、冲突检测、保存恢复以及 HMR 配置刷新继续通过现有公开协议提供。Loader 和 Core 不增加文件格式职责。
5. 仓库示例、打包清单和外部消费者验证统一使用 JSON。HMR 对 `pnpm-lock.yaml` 的环境变化检测继续保留，它不属于 Include 配置格式。

## 后果

这是相对旧候选的文件格式不兼容变更。已有 YAML 内容需要转换成 JSON，并更新宿主入口和所有 include 路径；只改扩展名不能完成语法转换。JSON 没有注释，原有说明应迁移至应用文档。迁移步骤见[迁移指南](../how-to/migrate-0.1.md#6-迁移已有-yaml-配置)。

拒绝的根文件和嵌套来源、非 JSON 语法、原有运行保留及多文件保存由[Include 测试](../../packages/include/tests/include.spec.ts)覆盖；JSON 文件与 HMR 的集成由[原生消费者检查](../../scripts/check-include-hmr-consumer.mjs)覆盖。

## 替代方案

- 继续支持两种格式：保留人工注释体验，同时继续承担两套格式适配与验证成本。
- 暂时隐藏 YAML 但继续兼容：格式边界与实际实现长期不一致，不能达到统一支持面的目标。

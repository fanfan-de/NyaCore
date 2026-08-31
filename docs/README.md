# Nya 文档地图

这里是 Nya 项目文档的入口。文档与代码保存在同一仓库，通过同一个 Pull Request 评审和演进。

## 从哪里开始

| 需求 | 文档 | 类型 | 状态 |
| --- | --- | --- | --- |
| 快速理解当前架构 | [架构总览](./architecture.md) | Explanation | Current |
| 理解当前运行时 | [核心概念](./concepts.md) | Explanation | Current |
| 理解 Loader Entry 树 | [ADR-0009](./adr/0009-loader-entry-tree.md) | ADR | Accepted |
| 理解 Logger 与诊断边界 | [ADR-0005](./adr/0005-runtime-observability.md) | ADR | Accepted |
| 了解目标架构 | [核心设计](./design.md) | Specification | Proposed |
| 查看技术决策 | [架构决策记录](./adr/README.md) | ADR | 按条目确定 |
| 编写或维护文档 | [文档贡献指南](./contributing.md) | How-to | Current |

随着项目增长，可以增加 `tutorials/`、`how-to/`、`reference/` 和 `explanation/` 目录；在出现实际内容前不创建空目录。

## 文档权威规则

“当前实现”和“目标设计”是两类不同事实，不能用一个简单的全局优先级混在一起。

### 当前可观察行为

判断当前版本实际做什么时，按以下证据核对：

1. `packages/core/src/`、`packages/loader/src/` 与 `packages/logger-console/src/` 中的实现和导出类型；
2. 相应包测试中可重复运行的行为测试；
3. `docs/concepts.md` 中对上述行为的解释。

如果概念文档与源码或测试不一致，应把它视为文档漂移并修正；如果测试与声明的公共契约不一致，应先明确这是实现缺陷还是契约变更。

### 设计约束与未来行为

- 状态为 **Accepted** 的规范和 ADR 表示实现应当维持或逐步满足的约束。
- 状态为 **Proposed** 或 **Draft** 的内容用于讨论，不能用来断言功能已经存在。
- `docs/design.md` 当前是 Proposed 目标设计；其中的“必须”表示该设计方案内部的要求，而不是对当前实现状态的证明。

发现文档、测试和代码互相冲突时，不要静默选择看起来最新的一份。应在 Pull Request 中指出冲突，并通过测试、ADR 或状态变更记录最终结论。

## 文档类型

| 类型 | 回答的问题 | 内容要求 |
| --- | --- | --- |
| Tutorial | 如何从零学会？ | 有顺序、可完成、面向学习者 |
| How-to | 如何完成一个具体任务？ | 前提明确、步骤短、结果可验证 |
| Reference | 具体参数和接口是什么？ | 精确、完整，尽可能自动生成 |
| Explanation | 为什么这样工作？ | 建立心智模型，不承担步骤说明 |
| Specification | 系统必须满足什么？ | 明确状态、范围、约束与非目标 |
| ADR | 为什么选择了这个方案？ | 记录上下文、决策、后果和替代方案 |

## 最小文档元数据

新增规范、提案和长期维护的说明文档时，在标题下标注：

```text
> 状态：Proposed | Accepted | Current | Deprecated
> 类型：Tutorial | How-to | Reference | Explanation | Specification | ADR
> 适用范围：包、功能或版本
```

状态只有在作者实际核对相应代码、测试或决策后才能更新。不要为了制造“新鲜度”而机械修改日期。

## 维护入口

- 文档修改规范和检查方式见[文档贡献指南](./contributing.md)。
- 新建决策记录时，从 [ADR 模板](./adr/0000-template.md)复制结构并分配下一个编号。
- 当前文档体系的建立原因记录在 [ADR-0001](./adr/0001-repository-documentation.md)。
- Logger 不影响生命周期、1000 条缓冲、诊断保留范围和 console 包边界记录在 [ADR-0005](./adr/0005-runtime-observability.md)。
- 稳定 Entry、Group、Resolver 和 Loader 到 Fiber 的映射记录在 [ADR-0009](./adr/0009-loader-entry-tree.md)。

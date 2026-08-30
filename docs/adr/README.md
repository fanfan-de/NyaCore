# 架构决策记录

架构决策记录（ADR）用于保存影响多个模块、公共语义或长期维护方式的关键选择。ADR 记录“当时为什么这样决定”，而不是替代当前 API 参考。

## 状态

- **Proposed**：正在讨论，尚不约束实现；
- **Accepted**：已经接受，后续实现应遵循；
- **Superseded**：已由另一条 ADR 替代，但保留历史；
- **Deprecated**：决策不再适用，且没有单一替代项。

Accepted ADR 不应通过改写历史来适配新结论。需要改变决策时，新建 ADR，并在旧记录中只追加替代关系。

## 索引

| 编号 | 标题 | 状态 |
| --- | --- | --- |
| [0001](./0001-repository-documentation.md) | 文档采用仓库内可验证的 Docs-as-Code 模式 | Accepted |
| [0002](./0002-config-lifecycle.md) | 配置生命周期与 Fiber 串行协调 | Accepted |
| [0003](./0003-service-isolation.md) | 服务身份由名称与隔离标签共同确定 | Accepted |
| [0004](./0004-service-caller-context.md) | Service 调用保留调用方 Context 并按隔离地址过滤事件 | Accepted |
| [0005](./0005-runtime-observability.md) | 运行时日志与 Effect 诊断不参与生命周期结果 | Accepted |

## 新建 ADR

复制 [0000-template.md](./0000-template.md)，使用下一个四位编号和简短的 kebab-case 文件名，例如 `0002-service-identity.md`。Pull Request 合并时再把状态从 Proposed 更新为 Accepted。

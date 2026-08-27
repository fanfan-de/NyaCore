# Nya

Nya 是一个以动态服务依赖驱动、能够追踪并完整撤销组件副作用的 TypeScript 作用域运行时。本仓库目前处于早期开发阶段，核心实现位于 `@nya/core`。

## 当前状态

- 核心组件、Context、Fiber、Effect、Service 与 Inject 已有实现和测试。
- Event 注册、生命周期清理、作用域过滤和多模式派发已有实现和测试。
- Standard Schema 同步配置校验、`fiber.update()`、`restart()` 和严格服务隔离已实现；Context 拦截、调用方追踪、Logger、Loader 和 HMR 仍属于后续设计目标。
- 公共 API 尚未稳定，不应假设当前行为已经遵循语义化版本兼容承诺。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| [`packages/core`](./packages/core) | `@nya/core` 源码与测试 |
| [`playground`](./playground) | 运行时示例与手动验证场景 |
| [`docs`](./docs) | 概念、设计、决策与贡献文档 |

## 开始开发

建议使用 Node.js 22.12 或更高版本。

```bash
npm install
npm run check
```

常用命令：

```bash
npm run build        # 构建 @nya/core
npm test             # 运行测试
npm run typecheck    # 检查 core 与 playground 类型
npm run docs:check   # 检查文档结构与本地链接
npm run playground   # 构建 core 并运行示例
```

## 文档

从[文档地图](./docs/README.md)开始：

- [架构总览](./docs/architecture.md)：当前系统边界、核心构件、运行时视图与关键流程；
- [核心概念](./docs/concepts.md)：当前已经实现的运行时心智模型；
- [核心设计](./docs/design.md)：面向后续版本的目标设计，不等同于当前行为；
- [架构决策记录](./docs/adr/README.md)：已经接受的关键技术决策；
- [文档贡献指南](./docs/contributing.md)：如何新增、验证和更新文档。

当文档与实现发生冲突时，请先根据[文档权威规则](./docs/README.md#文档权威规则)判断冲突类型，不要静默选择其中一方。

## 贡献

行为或公共 API 变更应同时提交测试和相应文档。提交前运行 `npm run check`；涉及核心生命周期语义的变更，还应新增或更新 ADR。

# Super-Org

[English](README.md)

Super-Org 帮助团队把持续变化的讨论变成可以推进的项目工作。团队提交会议纪要、确认目标和分工，由选定的 Agent 协助执行、跟进和通知交付，再由成员验收。看板记录发生了什么、谁需要行动，以及实际执行结果。

项目可以从一次讨论开始，仓库可以之后再关联。任务既可以由成员完成，也可以交给 Agent。GitHub Issue 是可选的任务关联，PR 是代码交付的一种证据。后续讨论可以继续调整目标、依赖和分工。

## 项目怎么推进

1. **确认行动项。** Agent 从纪要提取具体任务、负责人和验收条件，团队确认范围并开工。
2. **按同一份状态协作。** 看板和项目群调用相同的项目操作。交给 Agent 的任务生成执行工单，用于查看进度、阻塞问题和交付。
3. **由事实唤起 Agent。** 依赖解除、执行受阻、预约到期或关联 PR 收到反馈时，Agent 读取当前上下文，按项目授权决定如何跟进。
4. **验收当前交付。** 成员通过或退回本版交付。验收通过可以解除后续任务的依赖，也可以同步关闭该任务明确负责解决的 Issue。

项目事实、Agent 决定、工具结果和发送回执保存在 SQLite 中。GitHub、钉钉、飞书和本地请求共用事件源契约。GitHub 和钉钉支持本文描述的项目协作，飞书保留消息和工单接入。独立服务目前由 Codex 负责规划和执行。

## 快速体验

需要 Node.js `^22.19.0 || >=24.0.0` 和 pnpm `11.7.0`。

```sh
git clone https://github.com/neug-ai/super-org.git
cd super-org
pnpm install --frozen-lockfile
pnpm build
pnpm start:codex --projects-only
```

打开[项目工作台](http://127.0.0.1:3082/orchestrator/projects)，体验本地项目和成员管理。需要 Agent 执行、群聊或仓库联动时，按部署文档启动完整服务。 [部署 Super-Org](docs/deployment.zh-CN.md)

## 跟着 2048 示例走一遍

从项目群里的一份纪要开始，带团队从分工走到验收。教程附可复制的群消息和动图，可以对照看板观察 A 验收后 B 如何开工。 [2048 图文教程](docs/tutorials/2048.zh-CN.md)

## 文档

[文档索引](docs/README.md)还收录各类事件参考和验证记录。

| 我想了解 | 文档 |
| --- | --- |
| 团队怎么从会议推进到验收 | [项目协作指南](docs/project-guide.zh-CN.md) |
| 怎么配置 Agent、钉钉、GitHub 或迁移数据 | [部署与运维](docs/deployment.zh-CN.md) |
| 任务、工单和事件之间是什么关系 | [架构设计](docs/architecture.zh-CN.md) |
| 怎么配置事件或接入新的来源 | [事件配置](docs/events/README.zh-CN.md) · [事件源适配](docs/source-adapters.zh-CN.md) |
| 怎么验证一遍完整流程 | [2048 人工验收](docs/2048-manual-acceptance.zh-CN.md) |

开发检查使用 `pnpm check`，包含类型检查、测试和构建。

## 上游与许可

Super-Org 基于 DeepSeek 的执行和来源基础设施。原型的 DSH 设计和安装资料由上游维护。 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)

本项目使用 [MIT 许可证](LICENSE)。

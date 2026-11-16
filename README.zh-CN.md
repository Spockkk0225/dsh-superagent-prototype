# NeuG Super Agent

基于 [DeepSeek Super-agent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype)的 NeuG 适配版，保留原有 Runtime、Store、Engine、Policy、Executor、工具和 MIT 许可证。本仓库包含当前 Codex CLI、钉钉和 GitHub 集成的代码及测试。

## 当前能力

- 使用 Codex CLI app-server 执行主 Agent 和 Worker 会话，每个任务使用独立 Git worktree，复用原有任务编排、授权、持久化和 Outbox。
- 接收钉钉群内 @ 机器人的消息，支持通过任务 ID 继续对话；可选 AI 卡片累计展示来源回执、Agent 确认和最终结果。
- 支持个人 GitHub CLI 认证，以及按仓库选择 installation 的 GitHub App 认证，适用于 upstream/fork 协作。
- GitHub App 模式接收任务指派、个人 review request 和评论提及；任务创建的 PR 可继续接收未提及机器人的评论、review 和关闭事件。
- GitHub App 模式监控 `main` 当前提交上的 checks/statuses，快照连续两轮稳定后，仅为新增检查生成通知任务。Worker 可以按需查看 PR CI，但不会等待 CI。
- GitHub 触发的任务可将反馈发送至指定钉钉群；人工 GitHub 提及的确认和结果会累计更新同一处理轮次的 GitHub 评论。

## 环境准备

需要 Node.js `^22.19.0 || >=24.0.0`、pnpm `11.7.0`、Git、Python 3、GitHub CLI（`gh`），以及已经认证、支持 app-server 动态工具的 Codex CLI。无需运行桌面应用。

准备目标仓库的本地 checkout，并确认配置的 GitHub 身份能访问目标仓库及推送所用 fork。个人认证模式先完成 `gh auth login`；GitHub App 模式的权限和 installation 映射见下文链接。启动时会导出目标仓库的 admin 用户作为 GitHub 静态允许名单，导出失败会停止启动。

```sh
git clone https://github.com/neug-ai/super-agent.git
cd super-agent
pnpm install --frozen-lockfile
pnpm check
cp .env.template .env
```

编辑 `.env`，最少填写：

```dotenv
DINGTALK_CLIENT_ID=your-client-id
DINGTALK_CLIENT_SECRET=your-client-secret
SUPERAGENT_REPOSITORY=/absolute/path/to/neug
SUPERAGENT_GITHUB_REPOSITORY=alibaba/neug
SUPERAGENT_GITHUB_CLI=gh
SUPERAGENT_GITHUB_AUTH=user
SUPERAGENT_STATE_DIR=/absolute/path/to/super-agent/state-codex
CODEX_BINARY=codex
CODEX_MODEL=gpt-6.1-sol
CODEX_SANDBOX=workspace-write
```

路径须使用本机绝对路径，env 文件中的 `~` 不会自动展开。模型名称按当前 Codex 账号的可用模型填写。`.env.template` 列出了其余配置项；未使用卡片和群通知时，保留对应变量为空即可。

## 启动和交互

在钉钉应用中启用机器人和 Stream 接入，发布应用并把机器人加入目标群。若同一机器人已有旧服务，先停止旧服务，再启动：

```sh
pnpm start:codex -- --env-file .env
```

等待日志出现 `ready`，在群中发送 `@机器人 列出当前未合并的 PR，并给出摘要`。机器人接收请求后，由主 Agent 分配工作，Worker 汇报结果，再经原有回复工具和 Outbox 发送反馈。每个处理轮次需要 Agent 确认和最终回复；自动来源回执不算 Agent 确认。

继续已有任务时发送 `@机器人 #<12位任务ID> 补充要求`。也可以引用卡片并 @ 机器人；客户端必须在回调中携带可识别的任务信息，无法自动关联时请手动填写任务 ID。任务引用只在原群内关联。Ctrl+C 可停止服务。

`read-only` 限制 Worker 文件写入，`workspace-write` 允许修改任务 worktree；服务自身仍会保存状态、创建 worktree 和发送消息。显式设置 `danger-full-access` 可启用主机直接执行，使用服务账号的主机权限和已有 CLI 凭据，且不等待审批。macOS Keychain 的沙箱访问及原生命令规则见[适配说明](docs/009-codex.md)。

## 卡片、GitHub App 和群通知

- AI 卡片：按[卡片说明](cards/README.md)导入并发布模板，授予 `Card.Instance.Write`，填写 `DINGTALK_CARD_TEMPLATE_ID` 和机器人名称，再重启服务。来源回执、确认和结果在同一卡片内累加，结束时保留完整内容。
- 群通知：填写 `DINGTALK_GITHUB_NOTIFY_CONVERSATION_ID`，选择 GitHub 触发任务的钉钉反馈群，机器人需加入该群并具备相应发送权限。留空则保留原有 GitHub 回复目的地。
- GitHub App：将 `SUPERAGENT_GITHUB_AUTH` 设为 `app`，填写 App ID、私钥绝对路径和 installation 配置。多仓库使用 `SUPERAGENT_GITHUB_INSTALLATIONS`，与单仓库 `SUPERAGENT_GITHUB_INSTALLATION_ID` 二选一。私钥放在 checkout 外。upstream/fork 的权限、凭据路由及已有安装的切换步骤见[适配说明](docs/009-codex.md)。

## 配置、升级和迁移

首次启动将仓库、prepare 命令和授权等配置写入状态库。后续启动保留已有设置；修改 env 文件不会替换已经保存的 Source 设置，应通过原有 settings API 修改。管理 API 默认位于 `http://127.0.0.1:3082/orchestrator/api/`，此入口不提供 DSH 桌面/Web UI 外壳。

升级时停止服务，拉取代码，执行 `pnpm install --frozen-lockfile` 和 `pnpm check`，再使用同一 env 文件和状态目录启动。卡片布局升级还需重新发布模板。

代码仓库不包含运行状态、凭据、任务 worktree 或 Codex 会话历史。换机新部署可重新填写配置并启动；继续旧任务需协调迁移数据库、worktree、Codex 历史及其中的绝对路径，单独复制 SQLite 文件不足以恢复。

## 开发与更多资料

`pnpm check` 执行类型检查、现有测试和构建。真实模型 smoke test 为显式启用项，运行方式见[适配说明](docs/009-codex.md)。当前禁用模型子 Agent；附件保留来源信息，但不会自动下载和解析二进制内容。钉钉发送与 SQLite 提交之间的崩溃窗口可能造成重复消息。

- [Codex CLI / DingTalk 适配及详细配置](docs/009-codex.md)
- [原版 DSH 安装向导](SETUP.md)
- [架构](docs/007-architecture.md)与[部署说明](docs/006-deployment.md)
- [MIT 许可证](LICENSE)

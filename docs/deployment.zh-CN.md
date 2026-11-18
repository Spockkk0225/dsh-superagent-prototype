# Super-Org 部署与运维

## 启动模式

| 用途 | 命令 | 所需环境 |
| --- | --- | --- |
| 本地维护项目、任务和成员 | `pnpm start:codex --projects-only` | Node.js 和 pnpm |
| 执行任务、处理项目消息和仓库反馈 | `pnpm start:codex --env-file .env` | 已认证的 Codex CLI，按需配置 GitHub 和钉钉 |

从 [Super-Org README](../README.zh-CN.md#快速体验)完成安装和构建。完整服务需要 Git，GitHub 联动需要真实的 `gh` 命令。Codex CLI 需要支持 app-server 动态工具。工作台默认位于 [本机 3082](http://127.0.0.1:3082/orchestrator/projects)，使用 `SUPERAGENT_PORT` 可改端口。全局「Agent 状态」用于检查运行条件与连接。当前由 Codex 完成规划与执行，其余检测到的本地命令会展示可用性。

从 [环境变量模板](../.env.template)创建本机 `.env`。本地执行可从以下设置开始，按账号可用性调整模型：

```dotenv
SUPERAGENT_STATE_DIR=/absolute/path/to/super-org/state-codex
SUPERAGENT_PORT=3082
CODEX_BINARY=codex
CODEX_SANDBOX=workspace-write
```

`CODEX_MODEL` 可按需指定。用于 env 文件的路径推荐写为绝对路径，Node 的 env 加载器不会展开 `~`。设为 `read-only` 时 Worker 文件写入受限，`workspace-write` 允许在任务工作区写入。macOS Keychain 和需要审批的命令仍按 Codex 原生权限处理，无头服务无法交互审批。可按本机需要审查并安装仓库提供的 [只读 GitHub 命令规则](../codex-readonly.rules)。

两个模式通过 `SUPERAGENT_STATE_DIR` 使用同一份数据库。目录有独占锁，切换时先停止原进程。已有部署继续使用实际状态目录路径。完整服务也可在没有群或仓库的情况下运行项目，未关联仓库的工单使用独立本地工作区。

文档和工作流以 Super-Org 为项目名。`SUPERAGENT_*` 环境变量、`dsh-superagent` 插件名及原有启动脚本仍是运行兼容标识，升级继续使用原配置键。

## 钉钉项目群

在钉钉应用中启用机器人和 Stream 接入，发布并把机器人加入群。使用同一机器人时保留一个接收服务。在 `.env` 同时填写 `DINGTALK_CLIENT_ID` 和 `DINGTALK_CLIENT_SECRET`。若要从空群提交首次纪要建项，将 `DINGTALK_OPEN_CONVERSATION_ID` 设为该群会话 ID。已有项目也可在项目设置中绑定会话 ID。

当前机器人处理群内 @ 消息。引用任务、交付或卡片时，客户端需提供可解析的引用字段。可在正文带任务短引用或明确名称。同一项目的后续通知按实际群绑定发送。会话 webhook 过期时由应用群发送接口投递，需要相应权限。项目回复支持会话级 Markdown 偏好。 [沟通事件](events/communication.zh-CN.md)

`DINGTALK_CARD_TEMPLATE_ID` 用于可选的回执卡片。 `DINGTALK_GITHUB_NOTIFY_CONVERSATION_ID` 是独立 GitHub 通知与本地通用请求的回复群，不是每个项目的群绑定。 [钉钉卡片配置](../cards/README.md)

`POST /orchestrator/api/requests` 是本机通用工单入口，使用 `X-Orchestrator-Request: 1` 和正文 `{"prompt":"..."}`，并依赖上述回复群。项目对话使用 `POST /orchestrator/api/projects/:id/messages`。查看项目操作的实时 schema 使用 `GET /orchestrator/api/projects/tools`。

## GitHub 仓库与权限

在项目中保存仓库 `owner/repository`。仓库可在项目建立后添加，也可留空。 `SUPERAGENT_REPOSITORY` 和 `SUPERAGENT_GITHUB_REPOSITORY` 是旧单仓库安装的配置，不是绑定新项目的必填项。

1. **认证。** 个人模式使用服务账号所配置的 GitHub CLI 登录。App 模式设置 `SUPERAGENT_GITHUB_AUTH=app`、App ID、私钥路径和 installation 映射。具体变量见 [模板](../.env.template)。私钥留在 checkout 外，由服务账号读取。
2. **配置来源。** 通过本机管理 API 启用 GitHub，并按需打开 Issue、PR 或评论观察。在 DSH 面板运行时可使用「设置 → 来源 → GitHub」。全局「Agent 状态」显示各仓库状态，认证就绪与是否监听是独立信息。
3. **配置项目事件。** 已关联的 Issue、PR 和评审反馈通过 GitHub 适配器读取。是否应用相应事实由 `sources.github` 的事件开关控制。若使用 `watch` 白名单，请按需包括 `issues`、`pull_requests` 和 `comments`。 [事件配置](events/README.zh-CN.md)
4. **检查操作者授权。** 对已关联 PR 的反馈，GitHub 账号需通过来源的允许名单。团队名册的外部账号资料与来源操作权限分别维护。在推进记录中可核对被忽略的反馈及原因。 [仓库协作](events/repository.zh-CN.md)

独立服务读取 `GET /orchestrator/api/settings`，在 `sources` 中找到 `id=github`，保留其 `value` 和 `revision`。修改 `value.enabled` 为 `true`，按需将 `value.config.observeIssues`、`observePulls` 或 `observeComments` 设为 `true`。将更新后的 `{ "value": ..., "revision": ... }` 发送到 `PUT /orchestrator/api/settings/source:github`。带 `X-Orchestrator-Request: 1` 和 JSON 请求头。调整评论权限时读取同一响应的 `blocks.policy`，更新 `value.sources.github.allowed` 后提交到 `PUT /orchestrator/api/settings/policy`。保留其他来源和策略字段，按返回结果刷新修订或重启。

App 模式需要对读取的仓库安装应用。首次启动可以用 `SUPERAGENT_GITHUB_INSTALLATIONS` 显式映射所有目标，第一个仓库用作启动校验目标。单 ID 模式使用 `SUPERAGENT_GITHUB_INSTALLATION_ID` 和 `SUPERAGENT_GITHUB_REPOSITORY` 指定校验仓库。App 校验要求上游仓库具备 Contents 读取及 Pull requests、Issues 写入权限，额外安装仓库具备 Contents 写入权限。已有部署改认证方式时通过来源设置保存 GitHub `app` 配置并按提示重启。环境变量主要用于初始设置，后续以数据库保存的来源设置为准。部署级单仓库监听启用时，启动会按该仓库的管理员名单同步 GitHub 来源授权。

## 项目管理入口

默认仅本机。独立项目管理模式可用 `SUPERAGENT_PROJECT_PREVIEW_IP` 指定本机网卡 IPv4，配合 `SUPERAGENT_PROJECT_PREVIEW_LAN=1` 允许同网段访问。设回 `0` 并重启恢复本机限制。

若需要在独立管理模式提供公网入口，设置 `SUPERAGENT_PROJECT_PUBLIC_ENABLED=1`、`SUPERAGENT_PROJECT_PUBLIC_ORIGIN=https://projects.example.com`，并用 `SUPERAGENT_PROJECT_PUBLIC_USER` 和 `SUPERAGENT_PROJECT_PUBLIC_PASSWORD` 配置账号和至少 16 字符的密码。以 `pnpm start:codex --env-file .env --projects-only` 启动。外部 HTTPS 反向代理指向 `127.0.0.1:3092` 或配置的专用端口，保留外部 Host 和浏览器 Origin，并由代理设置 `X-Forwarded-Proto: https`。登录账号具有项目编辑权限。完整 Agent 服务仍使用本机管理入口。

## 升级与数据迁移

升级时停止服务，对 `orchestrator.sqlite` 制作一致性备份，拉取代码，运行 `pnpm install --frozen-lockfile` 和 `pnpm check`，再用原状态目录启动。原任务、工单、配置和事件随数据库继续使用。换机继续执行还需要迁移工单工作区、Codex 会话和相关路径。 [存量兼容](events/project-history.zh-CN.md)

如需从 Mission Control 导入，先停止目标服务并备份源快照与目标库。构建后运行：

```sh
pnpm import:mission-control /path/to/mission-control/data /path/to/super-org-state
```

导入项目、任务、归档、目标和项目决定。目标映射为里程碑，首个顶层目标用作当前目标，无项目归属的记录进入导入收件箱。同一来源的已导入记录会被跳过。旧执行分派保留为任务文字，导入后由团队确认成员和分工。跨项目、缺失或成环的依赖需在源快照修正后重新导入。

开发用 `pnpm check` 做完整检查。真实模型专项可使用 `CODEX_SMOKE_BINARY=/path/to/codex pnpm test tests/codex-harness.spec.ts -t 'real read-only'`，运行于隔离状态目录并使用模拟的钉钉输出。

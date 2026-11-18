# Super Agent 钉钉与 GitHub 人工验收

首轮用一个钉钉测试群、一个私有 GitHub 仓库和一个项目。用真实账号完成两次操作：成员先在钉钉报进展，再在 GitHub Issue 提交证据。两个事件必须归到同一个项目成员和同一个任务。项目负责人验收该任务后，Agent 自动派发依赖它的下一项任务。

当前版本可验收钉钉收发、原群工单跟进、项目页人工派发和验收、任务关联 GitHub Issue。成员页可手填外部账号。双端身份验证、群与项目的路由、从两端回填任务进展以及自动派发，需要完成下文的开发待办后再验收。

## 1. 操作员准备清单

- [ ] **钉钉管理员**在所属企业创建或选择专用的内部测试应用，启用机器人及 Stream 模式，发布后把机器人加到独立测试群。把 `Client ID` 和 `Client Secret` 填在部署机的本地 env 文件里。先用文本回复。若同一机器人已连接另一服务，先用专用机器人或停止该测试机器人的旧服务。 [钉钉官方 Stream SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)
- [ ] **GitHub 仓库管理员**复用 [私有验收仓库](https://github.com/longbinlai/super-agent-acceptance)，在部署机完成 `gh auth login` 并准备本地 checkout。以下按个人认证模式启动，该 GitHub 身份需要仓库管理权限以便服务读取管理员名单。仓库另开三条 Issue，分别用于身份验证、任务 A、任务 B。
- [ ] **两位测试成员**分别准备自己的企业钉钉和 GitHub 账号，加入测试群，并能在三条 Issue 留评。至少一位真实测试成员的 GitHub 账号与 Agent 的运行账号不同。指定一位项目负责人做批准和验收，可由操作员兼任。
- [ ] **Super Agent 操作员**用新的持久状态目录和空闲端口启动，在部署机打开项目页，新建「钉钉联动验收」和两条任务。首次启动的默认钉钉准入允许收到的群内 @ 发起工作，先只把机器人放在独立测试群。项目页由本机操作员操作。 [现有部署说明](009-codex.md)

把 `.env.template` 复制到 checkout 外的本地文件。以下以 `3091` 为例，路径请换成实际绝对路径。本轮先用 `read-only` 跑只读任务。

```dotenv
DINGTALK_CLIENT_ID=<内部测试应用的 Client ID>
DINGTALK_CLIENT_SECRET=<内部测试应用的 Client Secret>
DINGTALK_CARD_TEMPLATE_ID=
DINGTALK_GITHUB_NOTIFY_CONVERSATION_ID=
SUPERAGENT_REPOSITORY=/absolute/path/to/super-agent-acceptance
SUPERAGENT_GITHUB_REPOSITORY=longbinlai/super-agent-acceptance
SUPERAGENT_GITHUB_CLI=gh
SUPERAGENT_GITHUB_AUTH=user
SUPERAGENT_STATE_DIR=/absolute/path/to/dingtalk-pilot-state
SUPERAGENT_PORT=3091
CODEX_BINARY=codex
CODEX_SANDBOX=read-only
```

```sh
cd /Users/robeenly/Documents/git/super-agent
pnpm build
pnpm start:codex --env-file /absolute/path/to/dingtalk-acceptance.env
```

看到 `ready` 后，打开 [本机项目页](http://127.0.0.1:3091/orchestrator/projects)，确认页面显示「Agent 可接单」。本轮状态保存在 `SUPERAGENT_STATE_DIR` 下的 `orchestrator.sqlite`。重启仍使用同一份 env 文件，项目和工单才会继续从此处读取。

## 2. 现版本可以实测

| 编号 | 人工操作 | 通过标准 |
| --- | --- | --- |
| T1 真实收发 | 成员用自己的钉钉在测试群发送 `@机器人 请只读检查验收仓库 README 的首行标题，给出标题和链接`。 | 原群收到接单确认和具体结果。SQLite 的入站记录包含该次消息的 `senderCorpId`、发件人 ID、`conversationId` 和 `messageId`。记录结果中的工单号。 |
| T2 原群跟进 | 发起一张新工单，请 Agent 先问「用中文还是英文汇报 README 标题？」并等待回复，再在原群发送 `@机器人 #<12 位工单号> 请用中文回答`。 | 回复进入原工单，补充结果在原群可见。若有第二个获准的测试群，用同一工单号再发一次，核对没有续接到原工单。 |
| T3 项目页执行 | 创建任务 A 和 B，各贴自己的 Issue URL，B 依赖 A。尝试先派发 B，再人工派发 A，核对只读报告并验收 A。 | B 在 A 验收前受阻，验收后可以手动派发。从任务页分别点开对应 Issue。每次执行的工单可从对应任务查看。该步通过后只勾选手动项目执行。 |

钉钉的企业 ID 来自回调的 `senderCorpId`，发件人 ID 来自 `senderStaffId`，后者存为 `actor.id`。操作员可在部署机运行以下只读查询核对，验收记录可以遮蔽账号 ID。 [钉钉适配器](../src/sources/dingtalk.ts)

```sh
sqlite3 -readonly /absolute/path/to/dingtalk-pilot-state/orchestrator.sqlite <<'SQL'
.headers on
.mode column
SELECT at, id AS trigger_id,
       json_extract(value, '$.meta.senderCorpId') AS corp_id,
       json_extract(value, '$.actor.id') AS staff_id,
       json_extract(value, '$.meta.conversationId') AS group_id,
       json_extract(value, '$.meta.messageId') AS message_id
FROM trigger
WHERE json_extract(value, '$.source') = 'dingtalk'
ORDER BY at DESC LIMIT 5;
SQL
```

## 3. 全链路开发待办

- [ ] **保存已验证身份。** 给内部项目成员 `memberId` 记录已验证的钉钉身份和 GitHub 身份。钉钉以受信任 Stream 连接取得的 `senderCorpId + senderStaffId` 识别，另外校验接入应用及群的配置。GitHub 以 `github.com + user.id` 识别，`login` 用来展示。两端账号各自只能绑定一个成员。迁移既有手填记录为待验证，记录验证证据、批准人、时间及撤销事件。成员所属项目与角色另行授权。 [GitHub 用户 ID 说明](https://docs.github.com/en/rest/users/users#get-a-user-using-their-id)
- [ ] **做一次双端身份验证。** 操作员先为目标 `memberId` 发起绑定邀请。成员在测试群发 `@机器人 绑定 GitHub <login>`，服务从真实回调得到钉钉身份，通过 GitHub API 将声明的 `login` 解析为预期的 `user.id`。服务发放短时、单次验证码，固定邀请、钉钉身份、预期 GitHub ID 和专用验证 Issue。操作员通过已有的私下联系渠道交付验证码，群里只回进度。成员亲自登录 GitHub，在专用 Issue 发一条新的 `绑定 <验证码>` 评论。服务读取 API 返回的真实评论作者 `user.id`，核对位置、时效和是否已用。负责人核对两端原始证据后批准，服务在一笔事务里登记绑定。绑定命令和验证评论走专门处理逻辑。 [GitHub Issue 评论 API](https://docs.github.com/en/rest/issues/comments#list-issue-comments)
- [ ] **把真实事件送到正确任务。** 保存测试群 `conversationId → projectId`，并用任务已关联的仓库和 Issue 编号定位 `taskId`。钉钉消息和 GitHub 评论都先解析到 `memberId`，再校验项目角色。提供任务内可查的进展时间线和原始证据，识别重复投递。约定 `@机器人 进展 <任务号> <内容>` 为拟新增入口，并在 GitHub 使用相应 Issue 的实名评论。任务派发和完成提醒回项目配置的群，单独记录投递结果。
- [ ] **把下一步执行条件做成可查规则。** 项目负责人确认会议纪要中的目标、任务、负责人和依赖后，启用该项目的自动推进。任务 A 由人完成和验收，任务 B 显式获准由 Agent 执行且依赖 A。调度用持久化状态，在 A 人工验收后自动派发 B。允许配置一次到期提醒，按任务和提醒轮次去重。新增待决事项或重分派时保存变更记录，重新检查依赖、人员权限和执行授权。
- [ ] **提供操作员可查的验收证据。** 项目页能查看双端绑定证据、成员角色、任务事件、外部引用、派发原因和工单号。授权变更后立即按新状态检查后续操作。界面或 SQLite 的持久记录可用于重启复验。

首轮用一段手工录入的会议纪要启动。样例「成员甲核对 README 标题和链接，将证据写在 Issue A；确认后 Agent 从验收仓库重新读取并在任务 B 报告」。音频转写可以另开验收轮次。默认 `workspace-write` 下 Agent 自动暂存、提交和发布草稿 PR 曾在 worktree 暂存阶段受阻，若本轮增加代码交付，将自动发 PR 单列验收。 [上轮执行验收报告](../.artifacts/project-acceptance-2026-11-16/report.zh-CN.md)

## 4. 双端身份与自动推进验收

以下各项在第 3 节交付后执行。设备、群消息和 GitHub 评论均使用真实账号。

| 编号 | 人工操作 | 通过标准 |
| --- | --- | --- |
| I1 正常绑定 | 甲、乙各自按第 3 节从钉钉发起、用自己的 GitHub 账号留评，负责人分别批准。 | 每位成员的 `memberId` 都显示两端已验证身份和证据。保存的钉钉 ID 与真实回调一致，GitHub ID 与验证评论作者一致。 |
| I2 冒认与重复 | 在 I1 正式批准前，乙先用自己的 GitHub 账号提交为甲签发的验证码。I1 完成后复用一条已消费评论，再尝试把已绑定账号绑到第二个成员。 | 错误作者、已消费评论和重复绑定都被拒绝。再等一次验证码过期，确认过期码也无法激活绑定。 |
| I3 身份和权限更新 | 暂时撤销乙的项目成员资格，乙在原群报进展并在任务 Issue 留评。再撤销乙的 GitHub 绑定，请乙重新留评。另在隔离测试数据中重放相同 GitHub `user.id`、不同 `login` 的事件。 | 乙的新事件无法改变任务、派发或验收。撤销绑定后，新 GitHub 事件失去已验证身份。历史记录仍可查。测试数据中的改名事件仍解析到原成员。 |
| P1 两端同一人、同一任务 | 甲在钉钉报 A 的进展，再用自己的 GitHub 在 Issue A 留真实证据。负责人在项目页打开 A。 | 看到两条来源不同的事件，均指向甲的 `memberId` 和 A 的 `taskId`，可分别追到钉钉消息与 GitHub 评论。B 仍受依赖约束。 |
| P2 人工开闸和自动派发 | 等到一次调度，确认 B 仍等待。负责人核对证据后验收 A，再等约定的调度间隔。 | 无需手动点「交给 Agent」，B 由系统派发一次，生成自己的工单，结果回 B 并推送到测试群。B 的最终完成仍由负责人确认，GitHub Issue 保持开放。 |
| P3 提醒与重启 | 让另一个等待人工处理的测试任务到期，收到提醒后重启服务，并重投一条已处理事件。 | 同一轮只提醒一次、同一轮执行只派发一次，重启后依然能查到原身份绑定、提醒、任务和工单，重复事件可查且不会再次变更任务。 |
| P4 重新分工 | 恢复乙的项目角色及已验证绑定。新增一条依赖 B 的任务 C，在复盘时把 C 从甲改派给乙并记一项待决事项。负责人解决待决事项后使 C 继续。 | 任务保留前后负责人和决策记录，按当前角色及依赖判断能否推进，通知送给当前负责人。C 的历史事件仍归原发件人。 |

## 5. 验收记录

每项记录「通过／失败／待实现」、操作人、时间和证据。至少留一组 `projectId`、`taskId`、`memberId`、钉钉消息 ID、GitHub 评论链接、工单 ID，以及自动派发前后的状态。I2、I3、P3 也保留拒绝或去重的证据。**T1–T3 通过可确认接入及现有手动流程。I1–I3、P1–P4 全部通过后，才确认真实身份绑定和自动项目推进验收完成。**

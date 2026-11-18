# Super Agent 项目执行验收清单

使用 [longbinlai/super-agent-acceptance](https://github.com/longbinlai/super-agent-acceptance) 验收一条完整链路。先从 GitHub Issue 建立项目任务，再派发给 Agent，回到任务中查看报告和 PR，最后人工验收并放行依赖任务。仓库为私有测试仓库，主分支的 README 是任务 A 的读取样本。

## 准备测试环境

在 Super Agent 源码目录运行下列命令。需要已认证且可用的 GitHub CLI 和 Codex CLI。GitHub CLI 账号应有测试仓库的管理权限，启动程序会读取仓库管理员名单。下面的临时目录同时保存测试 checkout 和本轮项目状态，两个启动模式都使用这个目录。

```sh
pnpm build
export SA_ACCEPTANCE_DIR="$(mktemp -d)"
gh repo clone longbinlai/super-agent-acceptance "$SA_ACCEPTANCE_DIR/repo"
export SUPERAGENT_REPOSITORY="$SA_ACCEPTANCE_DIR/repo"
export SUPERAGENT_GITHUB_REPOSITORY=longbinlai/super-agent-acceptance
export SUPERAGENT_STATE_DIR="$SA_ACCEPTANCE_DIR/state"
export SUPERAGENT_PORT=3089
export SUPERAGENT_GITHUB_AUTH=user
export SUPERAGENT_GITHUB_CLI=gh
export CODEX_BINARY=codex
export CODEX_SANDBOX=workspace-write
export DINGTALK_CLIENT_ID= DINGTALK_CLIENT_SECRET=
```

先执行 `pnpm start:codex --projects-only`，打开 [验收项目页](http://127.0.0.1:3089/orchestrator/projects)。操作表的 A1–A3 在此模式完成。随后按 Ctrl+C 退出，在同一个终端运行 `pnpm start:codex`，刷新页面。若使用自定义 Codex 路径，修改 `CODEX_BINARY` 后启动。

## 验收任务

| 任务 | 来源 | 填入任务说明 | 验收条件 |
| --- | --- | --- | --- |
| A 核对验收仓库 | [Issue #1](https://github.com/longbinlai/super-agent-acceptance/issues/1) | 只读检查当前测试仓库 `main` 上的 README。报告 README 第一行标题及 URL，列出从 Issue 到人工验收的步骤。工作范围只包含读取和汇报。 | 任务页显示带 README 链接的报告，标题和步骤可核对。 |
| B 创建交付记录 PR | [Issue #2](https://github.com/longbinlai/super-agent-acceptance/issues/2) | 读取 Issue #2 的验收说明。新增 `notes/delivery.md`，提交并推送当前工单分支，往测试仓库 `main` 开草稿 PR。在 PR 正文中写 `Refs #2`，报告 PR 编号和链接。交付动作为草稿 PR。 | PR 为草稿，base 为测试仓库的 `main`，只新增一个约定的 Markdown 文件。任务页可打开 PR。 |

## 必过检查

| 编号 | 操作 | 通过标准 |
| --- | --- | --- |
| A1 | 打开本地页，创建项目「执行链路验收」，目标写「验证 Issue 到人工验收」，添加一个项目成员。 | 页首显示「当前在项目管理模式」。项目和成员出现在各自位置。 |
| A2 | 创建任务 A、B，把表中的说明和验收条件分别填入任务，贴上各自的 Issue URL，为 A 指派成员，给 B 勾选依赖 A。 | A、B 各自的「来源」点开是正确 Issue。B 显示「依赖未完成」。 |
| A3 | 在项目管理模式下尝试把 B 改成「进行中」，再停止服务，用同一目录启动完整服务。 | B 的越级状态更新被拒绝。刷新后仍可看到原项目、成员和任务。页首显示「Agent 可接单」，仓库显示 `longbinlai/super-agent-acceptance`。 |
| A4 | 打开 A，点「交给 Agent」并确认。 | A 变为「进行中」，任务下出现一个工单和可记录的工单 ID。回到 B，仍显示「依赖未完成」。 |
| A5 | 等待 A 的报告，按表中的验收条件核对。点击「进入待验收」，然后点「验收通过」。 | 报告出现在 A 的「交付与验收」中。报告到达后、人工确认前，B 仍受阻。A 显示「已完成」后，B 可以派发。 |
| A6 | 打开 B，点「交给 Agent」。收到交付后打开任务页的 PR 链接，核对状态、目标分支和 diff。 | B 拥有独立的工单 ID。任务页展示报告和 PR，PR 符合表中约定。人工验收后，B 显示「已完成」。 |
| A7 | 打开 A 的「关联已有工单」核对 Issue 匹配顺序。另建一个后续任务，在它的工单选择器中选择 A 的工单。 | A 的选择器优先显示与 Issue #1 匹配的工单。后续任务复用相同工单 ID 并显示原报告。 |
| A8 | 停止并重启完整服务，使用同一状态目录。检查项目和 GitHub 页面。 | 成员、依赖、完成状态、工单关联和报告可恢复。Issue #1、#2 仍开放，草稿 PR 仍可查看。 |

如果 A 或 B 报告失败，保留错误和工单 ID，修复环境后重跑对应步骤。完成 A1–A8 后，记录 A、B 的工单 ID、草稿 PR URL，以及 A 验收前后 B 的状态。

## 追加检查

| 编号 | 操作 | 通过标准 |
| --- | --- | --- |
| E1 | 新建任务「人机问答」，说明写「先通过工单报告提出问题『选择中文还是英文？』，等待操作员回复，再以选定语言报告」。派发后等问题出现，点「回复 Agent」填「中文」。 | 问题显示在原任务内。回复进入同一工单，最终报告使用中文。 |
| E2 | E1 正在等待回复时，用另一个浏览器窗口打开同一任务，检查能否再点「交给 Agent」。 | 页面只有一个在途执行工单。另一个窗口刷新后显示同一工单 ID。 |
| E3 | 为一项待办任务创建关联的待决事项，检查派发入口。填写决定结论后再看。 | 待决时任务显示相应阻塞，解决后恢复派发入口。 |
| E4 | 新建一项需要先询问再继续的任务。提出问题后，在任务内点击「停止工单」。 | 工单转为已结束，原报告仍可查看，项目任务仍可由人调整状态。 |
| E5 | 点验收前，在 GitHub 页面记录本次草稿 PR 和两个 Issue 的状态。验收后刷新 GitHub。 | 验收只更新项目任务。PR 的草稿状态与两个 Issue 的开放状态保持一致。 |

## 示例项目约定

草稿 PR 应提交一个新文件 `notes/delivery.md`，内容如下。验收时用它核对编写、推送、创建 PR 和回填链接的链路。

```markdown
# 交付验收

- 状态：待人工验收
- 证据：README.md
```

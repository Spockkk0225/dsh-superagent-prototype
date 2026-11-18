# 看板推进记录与存量迁移

左栏新增「推进记录」，独立于任务看板和全局 Agent 状态。每条记录按 SQLite 提交序号显示来源、时间、原因与 applied/ignored/pending 状态；引用同一事件的 Agent 记录显示判断结果、实际工具调用和真实结果。操作失败显示回滚原因，不将提案当作执行完成。

远端同步、仓库事实与检查预约分别可查看。完整事件资料默认折叠，便于检查来源和因果 ID。列表支持任务筛选及基于 seq 的前后分页，不用时间戳分页以免漏掉同时发生的事件。

内部 `project.changed` 记录实际聚合变更，事件内发生的修改带对应 causeId；直接本地修改只记录发生的事实，不冒充群成员。状态、外部事实与 Agent 决定通过查询投影关联，保留现有单一数据库和事件体系。

## 存量兼容

启动时，对每个已有项目写入一次 `project.history.imported` 基线及持久标记。基线保留原任务状态、工单、负责人和 Issue 关联：

- 未明确 issueRole 的历史关联按 reference 解释，导入不会批量关闭历史 Issue。
- 未配置 deliveryMode 的历史任务继续按 report 交付，不追溯要求旧任务补 PR。
- 旧待验收迁移复用现有静默验收快照恢复入口；不会将缺少原始证据的历史状态包装为新完成事实。
- 已消费的事件、原工单、通知回执和未完成 Effects 均保留；导入不重放历史验收和群消息。
- 基线、标记同事务提交；重启反复恢复不会重复导入。

不需要清库，也不需要重新建 2048 项目。部署前保留 SQLite 一致性备份，关闭服务后用同一 stateDir 加载新构建。浏览器页面和真实群消息仍需人工观察；网络模拟测试不算真实群验收。

## 默认配置与查询

审计事件是内部事实，不提供可关闭或改写的 JSON 行为，以免业务记录丢失。现有默认统一配置 `{"sources":{},"on":{}}` 即可使用。GitHub 三种用户事件各自有默认 JSON 和中文说明。

`GET /orchestrator/api/projects/:id/history?before=<seq>` 返回 entries、next、notifications、synchronization、remote、checks。每页最多 100 条，next 为下一页游标；同一项目的 agent-runs 与 events 查询接口保持兼容。

通知从当前事件或 Agent run 显式携带项目因果标识，并展示 Outbox 的实际 pending/sent/dropped 回执；不以群 ID 猜测归属。sent 只表示发送接口接受，不能证明客户端已读。迁移不会根据旧消息补造这些关联。

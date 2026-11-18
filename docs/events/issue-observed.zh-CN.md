# issue.observed · Issue 远端状态

默认开启，GitHub 来源类别为 `issues`。[默认配置](../../config/events/issue-observed.defaults.json)：

```json
{"on":{"issue.observed":true}}
```

监听数据库中当前项目任务的可选 Issue 关联，使用项目对应仓库，不依赖全局固定仓库。GitHub 适配器读实际 Issue 对象并规范化开放/关闭状态、URL、远端更新时间和当前交付版本。PR 对象即使出现在 Issues API 也不作为 Issue 应用。

新观察仅在关联与版本仍有效、远端时间比已有事实更新时应用；重复数据、旧观察和旧关联保留 ignored 原因。外部关闭或重开 Issue 只改变远端事实，不自动通过/退回项目验收，也不改变任务完成状态。

任务新增字段 `issueRole`：`reference` 为仅参考，`resolve` 为本任务负责解决。旧任务未设置时按 reference 处理。通过机器人为任务新建的 Issue 明确设为 resolve；从外部填入的 Issue 默认 reference，可以由成员在看板或自然语言请求中明确调整。

来源类别与事件开关可分别控制。关闭只影响新事实的应用，历史仍可追溯；重新开启时必须等待更新事实，不伪造历史状态变化。验收后的关闭行为由独立的 [issue.close.requested](issue-close-requested.zh-CN.md) 控制。

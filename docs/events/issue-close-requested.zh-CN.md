# issue.close.requested · 验收后的 Issue 同步

默认开启，来源 `repository`，类别 `issues`。[默认配置](../../config/events/issue-close-requested.defaults.json)：

```json
{"on":{"issue.close.requested":true}}
```

只有一次新的、有效的人工 `review.accepted`，且该任务明确设置 issueRole=resolve、Issue 属于当前项目仓库，才登记本事件及持久化远端动作。默认的 reference、无 Issue、历史已完成状态导入都不会关闭远端对象。关闭动作独立于 autoAdvance；后者控制 Agent 自主跟进，不控制已经授权的验收同步。

同步在事务外调用认证 API：每次先读取远端，如果已关闭直接确认；未关闭才发送 state=closed、state_reason=completed。发请求前重验任务仍完成、验收/交付版本和仓库/Issue 关联均未变化。更改后还在排队的动作取消；远端请求已发送时无法撤回，返回结果照实记录，并标明请求期间的状态差异。

API 结果重新写入有序队列的内部 `issue.sync.result`，看板区分 pending、retrying、failed、cancelled、succeeded。只有实际远端关闭回执才显示成功。网络超时等不确定结果自动退避重试，先读远端，避免重复写；401/403/404/410/422 等权限或对象错误停止自动重试并显示可操作的失败原因。用户核对配置后可在「推进记录」点击「重新核对并同步」，继续同一动作。

相关 API：

- `GET /orchestrator/api/projects/:id/history` 显示动作、尝试次数、原因、远端结果及关联事件。
- `POST /orchestrator/api/projects/:id/synchronization/:operationId/retry` 只接受当前项目、仍具备验收授权的失败/重试中动作。

关闭本事件为 false，新的关闭请求显示 ignored。尚未发送的动作也重验开关。回执属于事实，内部结果事件不受用户开关阻断；不能关闭回执处理来制造成功状态。

迁移不重放历史验收，没有批量补关 Issue。测试包括超时已写入、权限失败后重试、发送前重开、旧版本及不同仓库对象。真实 API 语义见 [GitHub Issue 更新文档](https://docs.github.com/en/rest/issues/issues#update-an-issue)。

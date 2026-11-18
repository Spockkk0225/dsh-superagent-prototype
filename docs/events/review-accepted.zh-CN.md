# review.accepted · 验收通过

默认开启，类别 `reviews`，后台来源 `review`。[默认 JSON](../../config/events/review-accepted.defaults.json)：

```json
{ "on": { "review.accepted": true } }
```

设为 `false` 时通过请求不改变任务状态，事件保留为 ignored。其他事件仍按各自配置运行。通用配置见[项目事件配置](README.zh-CN.md)。

成员引用某次交付并明确反馈通过后，由所选 Agent 调用 `review.decide`，传入实际验收 ID、accepted 和成员的依据。没有通过关键词或固定短语要求。服务端核验成员、项目群和该任务当前负责人；其他成员不能代验收。负责人是任务分工，不增加永久“验收员”角色。未指定负责人时，先明确任务分工，或由本地管理者有据代验收。

看板“验收通过”和群消息共用此事件。本地管理接口代表本机管理者，记录 actorId=null、source=request 和所填依据，不冒充其他成员。看板窗口保存打开时的验收 ID，即使后台出现新版，也不会把点击自动换到新版。

```http
POST /orchestrator/api/projects/:id/tasks/:taskId/reviews/:reviewId
Content-Type: application/json
X-Orchestrator-Request: 1

{"messageId":"唯一请求ID","outcome":"accepted","reason":"按当前条件检查了边界和输出，结果满足要求"}
```

队列按入队顺序检查：任务须仍待验收，验收 ID 和版本须为当前、状态须 pending，依赖和授权须仍有效。有效时将任务设为 done，保存完成时间、操作者、来源、依据和决策时间，并登记群通知。双端几乎同时通过或退回时，第一项有效决策结案，后续项记录已失效；重复请求沿用原结果。

引用旧通知时，消息入口先从真实历史记录解析验收 ID。即使 Agent 获得新快照，也不能用新版替换被引用的旧版，旧回复只会得到说明。引用缺失且任务不明确时，Agent 应先确认目标。

本阶段保留已有依赖及 autoAdvance 行为：关闭时通过验收也不会派发下一任务；开启时现有推进器仍可派发符合条件的任务。本事件没有新增自动授权，也没有加入 GitHub Issue 关闭或 PR 合并逻辑，这些需后续相应事件接入。

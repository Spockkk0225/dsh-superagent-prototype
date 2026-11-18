# review.rejected · 退回交付

默认开启，类别 `reviews`，后台来源 `review`。[默认 JSON](../../config/events/review-rejected.defaults.json)：

```json
{ "on": { "review.rejected": true } }
```

设为 `false` 时新退回请求不改变状态，保留为 ignored。配置与来源开关见[统一配置](README.zh-CN.md)。

负责人可以引用交付通知，用自然语言说明缺少什么或需要修改什么。Agent 判断语义后调用 `review.decide`，outcome 为 rejected，reason 保留实际退回原因。看板提供“退回修改”，要求填原因。两种入口共用同一验收 ID、权限核验和有序队列。

```http
POST /orchestrator/api/projects/:id/tasks/:taskId/reviews/:reviewId
Content-Type: application/json
X-Orchestrator-Request: 1

{"messageId":"唯一请求ID","outcome":"rejected","reason":"缺少无效移动时分数不变的边界验证"}
```

只能退回当前 pending 的验收请求。成功时旧交付标记 rejected，保存操作者、来源、原因和时间，任务返回 in-progress，完成时间清空，群里收到退回结果。旧产物和验收条件快照仍可查看。

退回不会直接重启 Agent 或发新工单。成员明确要求执行时走已有执行工具；后续自主返工由后续模块设计接入。下一次真实工单成功或人工重新提交证据后，创建新交付版本和新验收请求。旧工单报告的补查不能使已退回版本再次进入待验收。

新范围、新负责人、重开和取消也会让旧 pending 请求失效，历史记录显示 superseded。过期或同时到达的另一项决策不作用于后续交付，回复明确原因。现有下游任务已启动时，重开仍受依赖检查保护。

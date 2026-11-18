# review.requested · 请求验收

默认开启，类别 `reviews`，后台来源 `review`。[默认 JSON](../../config/events/review-requested.defaults.json)：

```json
{ "on": { "review.requested": true } }
```

设为 `false` 关闭新验收请求的应用；事件仍保留为 ignored。来源的 enabled/watch 设置沿用[统一配置](README.zh-CN.md)。此事件由后台处理，只接受布尔值，无需模型持续扫描。

Agent 工单的当前成功报告由 `delivery.ready` 提交此事件。人工任务通过看板“提交交付并请求验收”，或者向机器人明确提供结果和产物链接，由 Agent 调用 `delivery.submit`。工具不会据任务描述编造已完成的产物。Agent 任务须等待真实工单成功报告，人工入口不能代替它。

事件应用前核对任务所属项目、身份、群绑定、依赖、当前执行和提交时的交付范围。范围改变或执行未结束时记录拒绝原因。验收快照保存结果摘要、链接、工单和报告时间（如有），以及当时的任务标题、描述、验收条件和负责人。

一个交付版本只有一个有效的待验收请求。首次为第 1 版；新执行、交付范围或分工变化使旧请求失效。退回后提交新证据产生下一版。优先级、截止日期等管理字段变动不会使验收失效。旧交付与决策保留在任务的 `reviews` 数组，`deliveryVersion` 指向当前版本。

状态和通知同一事务提交。存在绑定群时通过 Outbox 通知并使用负责人已绑定账号 @，附上版本、验收短引用、结果和条件；没有群时保留看板记录。短引用用于识别真实验收记录，不是命令。请引用通知反馈，Agent 根据自然语言判断通过或退回。多个引用无法唯一定位时需要明确目标，不能猜测。

本地 API 使用 `X-Orchestrator-Request: 1`：

```http
POST /orchestrator/api/projects/:id/tasks/:taskId/deliveries
Content-Type: application/json

{"messageId":"客户端生成的唯一请求ID","summary":"实际交付与验证结果","links":["https://example.com/result"]}
```

客户端重试沿用相同 messageId 和内容，返回原处理记录。响应 queued 表示已登记，applied 表示已应用，ignored 表示未生效，disabled 表示开关已关闭。当前数据与历史通过原项目详情接口查询。参数中的网页链接只允许 HTTP/HTTPS。

升级时为历史待验收任务建立静默快照；没有历史摘要时明确标记缺失，不批量发群消息。历史已完成任务不重走验收，也不触发外部动作。详见[验收记录](acceptance.zh-CN.md)。

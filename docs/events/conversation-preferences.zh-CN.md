# conversation.preferences.update_requested · 会话沟通偏好

本事件默认开启，来源 communication、类别 preferences。[默认 JSON](../../config/events/conversation-preferences.defaults.json)：

```json
{ "on": { "conversation.preferences.update_requested": true } }
```

设为 false 时请求保留为 ignored，不更新偏好。该开关只接受布尔值，内容偏好单独持久保存，不将自然语言关键词当规则。

成员提出“以后消息简短、突出重点”等要求时，由当前 Agent 判断是单次要求还是持续偏好。持续偏好通过 `conversation.preferences.inspect` 读取，再由 `conversation.preferences.update` 提交修订号和值。事件队列重新核验身份、会话范围及修订后，保存到现有 SQLite 的会话命名空间。Agent 下一轮看到实际保存结果后才能承诺生效。

```json
{
  "format": "markdown",
  "instruction": "先给结论，加粗状态、阻塞及下一步；详细证据放任务详情。"
}
```

偏好按来源与会话 thread 唯一保存，独立于项目；同群更换项目后仍有效，其他群不继承。重启不会丢失。默认沿用 text 以兼容既有通道。单次排版要求只影响当前回复，不修改持久设置。偏好只控制消息呈现，不授予执行、审批或验收权限。

Agent 的每轮项目快照包含当前会话偏好和真实运行能力。`runtime.inspect` 返回当前平台发送方式、格式支持、文档参考和审批限制，不包含凭据。若工具没有外部查阅能力，不能声称查过文档，也不应反问系统已经知道的平台类型。

## 统一输出

普通回复在 Outbox 登记时固化格式。交付和阻塞通知由服务端提供状态、行动、引用与详细证据，再经独立的 `message-compose` 持久动作调用当前 Agent 概括长证据。摘要最多 360 字；原报告与验收快照留在任务详情，不把内部编号、路径和原始日志堆进群。

模型不能改写服务端提供的状态、验收引用或行动。模型不可用时使用明确事实和详情入口，不用截取长日志冒充摘要。偏好在模型思考期间改变会按新偏好重新生成；问题已解决时撤回尚未发送的旧提醒，正在概括的旧消息也不再发送。

群内验收操作由 Agent 最终答复确认，不再另外广播同一份验收结果。网页验收仍产生项目群通知；自动请求验收仍主动 @ 指定负责人。内部工具调用与结果保留在 agent-runs，不再机械地追加“本次实际操作”。接收回执继续提供即时信号。

## 钉钉呈现

钉钉有两种发送路径，均按 format 选择真正的消息类型：有效会话 Webhook 使用 markdown 的 title/text；过期后应用群发送使用 sampleMarkdown 的 JSON 字符串参数。真实 @ 的正文与人员字段同时保留，不能以正文含星号作为已启用 Markdown 的证据。

参考：[钉钉机器人消息类型](https://open.dingtalk.com/document/orgapp/types-of-messages-sent-by-robots)、[自定义机器人接入](https://open.dingtalk.com/document/robots/custom-robot-access)、[DingTalk Channel SDK 契约](https://github.com/DingTalk-Real-AI/dingtalk-channel-sdk-python/blob/main/SPEC.zh-CN.md)。发送接口接受不代表所有客户端视觉效果已经人工核验，仍需在实际群观察标题、加粗和 @。

## 本机管理接口

请求头为 `X-Orchestrator-Request: 1`。接口根据项目当前的群绑定定位会话；未绑定群时只操作该项目的本地请求会话。

- `GET /orchestrator/api/projects/:id/conversation-preferences`：当前值、修订号、操作者和更新时间。
- `PUT /orchestrator/api/projects/:id/conversation-preferences`：`{"requestId":"唯一ID","revision":0,"value":{"format":"markdown","instruction":"简洁并突出结论"}}`。

相同请求 ID、同内容返回原记录；内容不同或修订过期被拒绝。完整服务才能修改，网页接口代表本机管理者，群内工具代表真实成员。

原生审批桥接目前不可用。Codex 适配器将此能力明确提供给项目管理与执行 Agent，并记录由运行时拒绝的操作类型。拒绝不是用户决定，群里回“允许”也不会授权。需要本机操作时应给出可执行的管理者处理说明，不循环请求当前无法兑现的群审批，也不自动放宽沙箱。

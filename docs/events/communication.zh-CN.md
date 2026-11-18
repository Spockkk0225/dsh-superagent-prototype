# 沟通事件参考

本文说明事件行为。配置按注册来源独立维护，来源可以继续扩展；此处的业务分类只用于阅读，不是框架中的固定枚举。默认配置：[dingtalk](../../config/events/dingtalk.defaults.json)、[communication](../../config/events/communication.defaults.json)。

`project.message.received` 可由钉钉或本地请求发布；两者使用同一事件契约，分别通过 `sources.dingtalk` 与 `sources.request` 配置。其他 IM 适配器注册后同样独立生成配置。

## 项目消息驱动 Agent

事件名为 `project.message.received`，类别为 `messages`，默认开启。已绑定项目群中发给机器人的消息，以及本地管理接口提交的消息，都携带原文、引用、发送人和项目标识进入同一入口。无需用特定词语触发更新计划。首次会议建立项目的入口目前仍由已有会议规划模块处理。

## 默认配置

[默认 JSON](../../config/events/dingtalk.defaults.json) 提供内置指导。使用空配置即可采用默认值，也可以只填写：

```json
{
  "sources": {
    "dingtalk": {
      "on": {
        "project.message.received": {
          "enabled": true,
          "description": "项目消息唤起 Agent，结合原文、引用、当前任务及成员信息选择项目工具并回告结果。"
        }
      }
    }
  }
}
```

用自然语言字符串覆盖指导，适用于调整回复和协作方式：

```json
{
  "sources": {
    "dingtalk": {
      "on": {
        "project.message.received": {
          "enabled": true,
          "description": "项目消息唤起 Agent，结合原文、引用、当前任务及成员信息选择项目工具并回告结果。",
          "instruction": "结合引用和现有分工处理请求。回复说明实际变化，以及下一步由谁行动。"
        }
      }
    }
  }
}
```

设为 `false` 关闭处理；关闭后新事件记录为忽略，处理中的请求在提交操作前也会检查开关。已提交的操作保留。来源开关和 `watch` 类别选择沿用[统一配置](README.zh-CN.md)。配置接口支持单独保存一个来源，也可提交整份配置。两种方式都核对当前修订号。

## 如何处理

```mermaid
flowchart TD
  A[钉钉消息 / 本地请求] --> B[有序事件队列：记录并去重]
  B --> C[持久化 Agent 请求并唤醒后台动作]
  C --> D[选中的 Agent 读取原文、引用、项目和工具目录]
  D --> E{返回工具调用或答复}
  E -->|工具调用| F[有序队列：权限、参数和项目版本检查]
  F -->|版本已变化| D
  F -->|当前版本| G[事务内执行整批工具]
  G --> H[实际结果或回滚原因]
  H --> D
  E -->|最终答复| I[保存记录并通过 Outbox 回复原通道]
```

Agent 通过工具完成具体操作，调用目录见[项目工具说明](project-tools.zh-CN.md)。没有预设的意图枚举或关键词分流。创建任务、指派成员与启动执行是独立能力；Agent 根据请求和已有分工组合工具。单纯整理条件和分工无需启动执行。

有序队列只承担持久化和短事务，不等待模型或远端网络。模型调用由现有 `Effects` 唤醒执行；空闲时没有常驻思考的 Agent。模型返回的操作也作为事件入队。它思考期间若项目已变化，旧操作丢弃，再基于新快照判断，连续冲突三次后明确告知用户。每次请求最多六轮工具调用；每轮模型故障最多尝试两次，仍失败会回复原因。

同一来源、同一消息 ID 的重复投递只建立一个处理记录。工具批次内任何一步失败，整个批次的数据库变更和待执行动作一起回滚，失败原因返回 Agent。已经执行的批次不会因重复投递重做。重启恢复未完成动作；已保存的模型决定直接恢复入队。远端 Issue 创建使用原有幂等和丢失响应恢复机制。

服务端在思考前和提交前检查项目成员及群绑定；工具再次检查权限和任务所属项目。模型不能自行绕过依赖检查、执行条件或给其他项目派工。人工验收已通过 `review.decide` 接入同一工具循环，见[交付与验收](delivery.zh-CN.md)。消息中的验收短引用从真实历史记录解析并绑定，重新判断不能擅自改为新版。自主跟进事件共用这套 Agent 工具循环，系统事实与成员消息分别记录，见[自主跟进](follow-up.zh-CN.md)。

## 查询与验收

请求头使用 `X-Orchestrator-Request: 1`，写入接口使用 JSON：

| 接口 | 用途 |
| --- | --- |
| `POST /orchestrator/api/projects/:id/messages` | `{"messageId":"客户端唯一标识","text":"这项先补充验收条件","quoted":"所引用的任务说明"}`，返回请求 ID 和 queued/disabled |
| `GET /orchestrator/api/projects/:id/agent-runs` | 最近 20 次请求的原文、工具调用、实际结果、冲突次数、最终回复和状态 |
| `GET /orchestrator/api/projects/tools` | 当前可执行工具的名称、说明、参数 JSON Schema |
| `GET /orchestrator/api/projects/events?projectId=:id` | 消息及工具决定的处理时间线 |

本地管理接口代表本机管理者，不能提交 `actorId` 冒充群成员。钉钉来源使用真实发送人绑定，引用来自原生回复上下文。请求记录可能含内部讨论和成员标识，沿用项目数据库的访问控制。

回归场景：引用待明确的测试任务，提出“请你帮忙梳理验收通过条件并分派给这项任务的负责人”。应看到实际任务创建或更新、具体条件和成员分工；在没有要求执行时，不产生工单。再明确要求开工时，才调用开工及执行工具。自动测试模拟模型决定以验证队列和工具行为，真实模型验证需另行记录结果。


## conversation.preferences.update_requested · 会话沟通偏好

本事件默认开启，来源 communication、类别 preferences。[默认 JSON](../../config/events/communication.defaults.json)：

```json
{
  "sources": {
    "communication": {
      "on": {
        "conversation.preferences.update_requested": {
          "enabled": true,
          "description": "按成员的明确请求更新当前会话的沟通偏好，独立于项目长期保存。"
        }
      }
    }
  }
}
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

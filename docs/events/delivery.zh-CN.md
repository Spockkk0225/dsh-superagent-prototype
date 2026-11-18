# 交付与验收事件参考

本文说明事件行为。配置按注册来源独立维护，来源可以继续扩展；此处的业务分类只用于阅读，不是框架中的固定枚举。默认配置：[execution](../../config/events/execution.defaults.json)、[review](../../config/events/review.defaults.json)。

## delivery.ready · 工单交付就绪

工单提交 `ready` 报告并以 `completed` 或 `merged` 结束时，系统写入此事件。它核对当前工单后提交 `review.requested`，由共用验收入口保存交付版本及快照、将任务从「进行中」移到「待验收」，通过已有 Outbox 向项目钉钉群通知，使用任务负责人的已绑定账号进行 `@`。没有群时保留看板和工单结果。

默认开启，见 [execution.defaults.json](../../config/events/execution.defaults.json)。统一配置中可以只填写这个选项。

```json
{
  "sources": {
    "execution": {
      "on": {
        "delivery.ready": {
          "enabled": true,
          "description": "当前执行已成功交付，将任务移到待验收并通知验收人。"
        }
      }
    }
  }
}
```

把值改成 `false` 可以关闭此事件发起验收的行为。人工任务可通过交付入口提交结果；Agent 任务须使用有效工单报告发起验收。重新开启后对新事件生效，之前的忽略记录保留。该事件由后台直接处理，配置值使用布尔值。群里的验收反馈交给统一消息 Agent 理解。

内部来源是 `execution`，类别是 `deliveries`。项目和任务从数据库关联读取，用户无需配置工单 ID、仓库、报告字段和队列标识。相同工单结果的重复事件复用原记录。

消费前重新核对工单、成功结果、报告时间和任务当前执行。任务已取消、已进入验收、已经换工单或进入更新一轮执行时，旧事件记为 `ignored` 并带原因。普通任务编辑和旧数据缺少执行时间字段时，继续支持当前任务自己的工单。任务改动和通知入队在同一事务内完成，投递失败由 Outbox 重试。

启动时只对现存的进行中任务做一次交付补查，找回旧版本已完成的工单。已有钉钉通知回执复用旧标识，避免补查重复发送。原项目周期扫描已移除这段状态更新逻辑。

验收使用独立运行时和假消息发送器验证真实工单报告入口，覆盖自动派发关闭时的通知、旧报告、开关、无群项目和已有通知回执的恢复。详见 [逐步验收记录](acceptance.zh-CN.md)。


## review.requested · 请求验收

默认开启，类别 `reviews`，后台来源 `review`。[默认 JSON](../../config/events/review.defaults.json)：

```json
{
  "sources": {
    "review": {
      "on": {
        "review.requested": {
          "enabled": true,
          "description": "记录本版交付和验收条件，并通知任务负责人验收。"
        }
      }
    }
  }
}
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


## review.accepted · 验收通过

默认开启，类别 `reviews`，后台来源 `review`。[默认 JSON](../../config/events/review.defaults.json)：

```json
{
  "sources": {
    "review": {
      "on": {
        "review.accepted": {
          "enabled": true,
          "description": "当前负责人通过本版验收，完成任务并保留验收依据。"
        }
      }
    }
  }
}
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

通过本版验收后，领域操作检查依赖。具备条件的后续任务由 `task.ready` 唤起 Agent，是否可自主行动取决于项目授权。任务明确负责解决关联 Issue 时，验收另行登记关闭同步。 [自主跟进](follow-up.zh-CN.md) · [仓库事件](repository.zh-CN.md)


## review.rejected · 退回交付

默认开启，类别 `reviews`，后台来源 `review`。[默认 JSON](../../config/events/review.defaults.json)：

```json
{
  "sources": {
    "review": {
      "on": {
        "review.rejected": {
          "enabled": true,
          "description": "当前负责人退回本版交付，保留原因并返回进行中。"
        }
      }
    }
  }
}
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

退回不会直接重启 Agent 或发新工单。成员可从任务中明确要求继续执行。下一次真实工单成功或人工重新提交证据后，创建新交付版本和新验收请求。旧工单报告的补查不能使已退回版本再次进入待验收。

新范围、新负责人、重开和取消也会让旧 pending 请求失效，历史记录显示 superseded。过期或同时到达的另一项决策不作用于后续交付，回复明确原因。现有下游任务已启动时，重开仍受依赖检查保护。

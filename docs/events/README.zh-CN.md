# 项目事件配置

Super-Org 按**已注册事件源**组织项目事件。每个来源维护自己的事件类型、数据校验、默认值和说明；来源名称与类别没有固定枚举。GitHub 使用 `sources.github`，未来安装 GitLab 适配器后使用 `sources.gitlab`。两者即使发布同一种通用事件，也可以独立设置。

来源结构与扩展契约见[事件源结构](../source-adapters.zh-CN.md)。所有项目来源共用现有 SQLite 有序事件队列、事务、Effects 和 Outbox。来源负责接入并描述事实，事件处理器负责状态与动作，Agent 根据上下文决定需要哪些已发布工具。授权和版本规则由领域操作统一核对。 [架构设计](../architecture.zh-CN.md)

## 按来源维护一份 JSON

当前各来源的默认文件如下。业务行为参考文档可以覆盖多个来源，配置归属由注册表决定。

| 注册来源 | 默认配置 | 覆盖的事件与说明 |
| --- | --- | --- |
| `github` | [GitHub 默认值](../../config/events/github.defaults.json) | Issue / PR 观察、评论与 Review，[仓库事件](repository.zh-CN.md) |
| `repository` | [仓库同步默认值](../../config/events/repository.defaults.json) | 验收后关闭负责解决的 Issue、关联事实，[仓库事件](repository.zh-CN.md) |
| `dingtalk` | [钉钉默认值](../../config/events/dingtalk.defaults.json) | 群消息驱动 Agent，[沟通事件](communication.zh-CN.md) |
| `request` | [本地请求默认值](../../config/events/request.defaults.json) | 网页与本地消息驱动 Agent，[沟通事件](communication.zh-CN.md) |
| `communication` | [沟通偏好默认值](../../config/events/communication.defaults.json) | 保存格式与风格，[沟通事件](communication.zh-CN.md) |
| `execution` | [执行默认值](../../config/events/execution.defaults.json) | 交付、阻塞与通知，[交付](delivery.zh-CN.md)及[跟进](follow-up.zh-CN.md) |
| `review` | [验收默认值](../../config/events/review.defaults.json) | 提交、通过、退回，[交付与验收](delivery.zh-CN.md) |
| `project` | [项目默认值](../../config/events/project.defaults.json) | 任务就绪与依赖解除，[自主跟进](follow-up.zh-CN.md) |
| `clock` | [时钟默认值](../../config/events/clock.defaults.json) | 一次检查到期，[自主跟进](follow-up.zh-CN.md) |

这些文件对应当前注册表中的面向项目事件，自动测试检查文件与注册默认值一致。飞书当前提供消息和工单能力，待注册项目事件后再生成自己的项目事件模板。新增来源注册后，查询接口立即返回该来源的独立配置模板，不需要修改配置解析器或增加事件名判断。

例如 GitHub 的一项配置：

```json
{
  "sources": {
    "github": {
      "on": {
        "code.change.observed": {
          "enabled": true,
          "description": "核对关联 PR 的合并状态和代码版本，证据齐备后请求人工验收。"
        }
      }
    }
  }
}
```

每种事件的 `description` 可以省略或为空字符串。生成模板时默认填写注册的说明，帮助团队理解具体用途；它是解释文字。`enabled` 控制开关，支持 Agent 决策的事件可通过 `instruction` 设置指导；后台确定性处理器不接受 Agent 指导。说明文字不会被当作执行指令。

来源可使用 `enabled` 整体停用，或用 `watch` 选择该适配器注册的观察类别。具体类别由注册信息提供；更换提供者时使用它自己的类别及事件目录。

## 保存与生效

`GET /orchestrator/api/projects/workflow` 返回：

- `config` / `revision`：SQLite 中当前配置及修订号。
- `sources[]`：已注册来源、该来源配置、观察类别、各事件实际生效值和说明。
- `sources[].defaults`：该来源独立默认 JSON；`defaults`：当前已安装来源的完整默认 JSON。
- `events[]`：通用事件契约与全局兼容层的有效默认值；来源具体有效值以 `sources[].events` 为准。

当前配置只在原来的 SQLite 中维护一份。分来源 JSON 是便于独立维护、导入和备份的文件表示，通过管理 API 保存到数据库。`config/project-workflow.defaults.json` 的空配置采用各来源内置默认值；完整带描述的配置从上述接口获取，会跟随当前注册内容生成。

推荐只保存当前来源，避免覆盖其他模块：

```http
PUT /orchestrator/api/projects/workflow/sources/github
X-Orchestrator-Request: 1
Content-Type: application/json
```

```json
{
  "revision": 1,
  "config": {
    "on": {
      "code.change.observed": {
        "enabled": true,
        "description": "记录代码交付证据。"
      }
    }
  }
}
```

`config` 对应文件内的 `sources.github`。该接口只替换 GitHub 的配置，其他来源及全局配置保留；使用读取到的修订号，并发过期返回 409。整份配置仍可通过 `PUT /orchestrator/api/projects/workflow` 提交 `{"revision":1,"config":{...}}` 替换。

解析规则按字段合并：**注册默认值 → 全局 `on` → 当前 `sources.<source>.on`**。仅修改描述会继承既有开关和指导。来源整体关闭、`watch` 未选中的类别仍然不能执行。历史布尔开关和字符串指导继续可读可写，不需要清库或重放事件。

内部审计、动作回执与协调事件保留在队列中，不提供用户关闭开关。停用的新业务事件仍留时间线并标记 ignored；已处理记录不重放。

## 扩展自己的来源和事件

适配器用 `SourceKind.projectEvents` 注册类型；框架在 `SourceRegistry` 注册时自动安装事件目录。下面是未来 GitLab 适配器中可声明的一种类型，类型名和类别由适配器维护：

```ts
const mergeRequestUpdated: ProjectEventDefinition = {
  type: 'merge_request.updated',
  category: 'merge_requests',
  description: '核对 GitLab 合并请求的真实代码交付事实。',
  schema: MergeRequestPayload,
  defaults: { enabled: true },
  documentation: 'docs/gitlab-events.md',
}
// SourceKind: { kind: 'gitlab', ..., projectEvents: [mergeRequestUpdated] }
```

注册后自动生成以下模板，可独立保存为 `gitlab.defaults.json`：

```json
{
  "sources": {
    "gitlab": {
      "on": {
        "merge_request.updated": {
          "enabled": true,
          "description": "核对 GitLab 合并请求的真实代码交付事实。"
        }
      }
    }
  }
}
```

适配器负责真实 API/回调认证、数据归一化及发布；处理器通过 `ProjectEvents.handle()` 注册。JSON 配置已经安装的能力，安装新的适配器才会获得新的事件源。可导入同一个通用事件契约，也可声明自己的类型；名称相同的通用契约必须复用同一份定义，避免两个插件赋予不同语义。

来源运行时通过绑定的 `SourceContext.projectEvents.publish()` 发布事件。原生 ID 在来源内唯一；同内容重试复用原记录，不同内容返回冲突。事件有数据版本，队列按全局 seq 消费。同步处理器在一个事务内写状态与后续动作，异步 API 或模型调用使用已有 Effects。失败回滚并保留原事件供重试，重启恢复不需要 Agent 持续扫描。

查询和验收入口：

- `GET /orchestrator/api/projects/events`：事件事实与处理状态。
- `GET /orchestrator/api/projects/:id/history`：[推进记录与通知回执](project-history.zh-CN.md)。
- `GET /orchestrator/api/projects/:id/checks`：检查预约与到期状态。
- `GET /orchestrator/api/projects/:id/agent-runs`：实际 Agent 决定与工具结果。
- [阶段验收记录](acceptance.zh-CN.md)、[2048 人工验收清单](../2048-manual-acceptance.zh-CN.md)。

查看具体动作及记录见[项目 Agent 工具](project-tools.zh-CN.md)和[推进记录](project-history.zh-CN.md)。

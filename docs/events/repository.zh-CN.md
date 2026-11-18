# 仓库事件参考

本文说明事件行为。配置按注册来源独立维护，来源可以继续扩展；此处的业务分类只用于阅读，不是框架中的固定枚举。默认配置：[github](../../config/events/github.defaults.json)、[repository](../../config/events/repository.defaults.json)。

`github` 管理真实 GitHub 观察事实，`repository` 管理已授权的验收后同步动作。未来 GitLab 等来源自行注册类型、默认值和说明，不共享 GitHub 的配置。

## code.change.observed · 代码交付事实

默认开启。GitHub 来源类别为 `pull_requests`，规范化定义可由其他仓库适配器复用。[默认配置](../../config/events/github.defaults.json)：

```json
{
  "sources": {
    "github": {
      "on": {
        "code.change.observed": {
          "enabled": true,
          "description": "记录当前代码交付的开放、关闭或合并事实，核对代码版本后检查是否可请求验收。"
        }
      }
    }
  }
}
```

现有 GitHub 监听会额外核对数据库中任务实际关联的 PR。关联来自任务显式 PR 地址，或当前工单已报告并绑定的 PR；不会用相同编号猜测其他仓库的 PR，也不会将任意新 PR 自动当作任务交付。使用现有仓库认证及轮询间隔，仓库新请求接收与项目交付事实是两个独立用途。

规范化事实保存仓库、PR 地址、开放/关闭/合并状态、head SHA、目标分支、合并提交、远端更新时间、当前工单和交付版本。相同观察复用同一事件；更老的观察或已变更的任务/仓库/工单版本不应用。适配器中的共享规范化入口只接收已核验远端结果；当前生产入口为认证 API 轮询，未增加未验证签名的 webhook 接收器。

任务可选择 `deliveryMode=report`（默认）或 `pull-request`。后者必须先关联项目仓库，验收前同时具备：成功的实际交付报告、匹配当前工单/交付的已合并 PR，以及目标分支（如指定）和真实提交证据。两种事实无论谁先到达都只产生一次验收请求。PR 交付快照保留合并证据，不因人工验收版本的建立而丢失。

PR 关闭未合并只记录远端事实，不表示任务已完成。PR 合并也不代替人工验收。网页和 Agent 工具都可配置交付方式、指定 PR（可选）和目标分支（可选）。任务说明要求执行 Agent 报告 PR，并用普通引用 `Refs` 关联 Issue，项目验收后再同步 Issue。

开启源筛选时：

```json
{
  "sources": {
    "github": {
      "enabled": true,
      "watch": [
        "pull_requests",
        "issues"
      ]
    }
  }
}
```

`false` 关闭本事件后，要求 PR 的任务不会用缺失合并证据进入验收。已有关联仍保留。原生 GitHub 评审和工单订阅继续沿用既有规则。

验收：分别让报告先到、合并先到；检查只创建一次验收、交付证据中保存真实提交。再检查未合并关闭、目标分支不符、旧版本和不同仓库的同编号 PR 均不能误推进。完整证据在左栏「推进记录」。


## issue.observed · Issue 远端状态

默认开启，GitHub 来源类别为 `issues`。[默认配置](../../config/events/github.defaults.json)：

```json
{
  "sources": {
    "github": {
      "on": {
        "issue.observed": {
          "enabled": true,
          "description": "记录关联 Issue 的真实远端状态；不代替项目验收。"
        }
      }
    }
  }
}
```

监听数据库中当前项目任务的可选 Issue 关联，使用项目对应仓库，不依赖全局固定仓库。GitHub 适配器读实际 Issue 对象并规范化开放/关闭状态、URL、远端更新时间和当前交付版本。PR 对象即使出现在 Issues API 也不作为 Issue 应用。

新观察仅在关联与版本仍有效、远端时间比已有事实更新时应用；重复数据、旧观察和旧关联保留 ignored 原因。外部关闭或重开 Issue 只改变远端事实，不自动通过/退回项目验收，也不改变任务完成状态。

任务新增字段 `issueRole`：`reference` 为仅参考，`resolve` 为本任务负责解决。旧任务未设置时按 reference 处理。通过机器人为任务新建的 Issue 明确设为 resolve；从外部填入的 Issue 默认 reference，可以由成员在看板或自然语言请求中明确调整。

来源类别与事件开关可分别控制。关闭只影响新事实的应用，历史仍可追溯；重新开启时必须等待更新事实，不伪造历史状态变化。验收后的关闭行为由独立的 [issue.close.requested](repository.zh-CN.md) 控制。


## issue.close.requested · 验收后的 Issue 同步

默认开启，来源 `repository`，类别 `issues`。[默认配置](../../config/events/repository.defaults.json)：

```json
{
  "sources": {
    "repository": {
      "on": {
        "issue.close.requested": {
          "enabled": true,
          "description": "人工验收通过后，关闭本任务明确负责解决的 Issue。历史关联默认仅参考。"
        }
      }
    }
  }
}
```

只有一次新的、有效的人工 `review.accepted`，且该任务明确设置 issueRole=resolve、Issue 属于当前项目仓库，才登记本事件及持久化远端动作。默认的 reference、无 Issue、历史已完成状态导入都不会关闭远端对象。关闭动作独立于 autoAdvance；后者控制 Agent 自主跟进，不控制已经授权的验收同步。

同步在事务外调用认证 API：每次先读取远端，如果已关闭直接确认；未关闭才发送 state=closed、state_reason=completed。发请求前重验任务仍完成、验收/交付版本和仓库/Issue 关联均未变化。更改后还在排队的动作取消；远端请求已发送时无法撤回，返回结果照实记录，并标明请求期间的状态差异。

API 结果重新写入有序队列的内部 `issue.sync.result`，看板区分 pending、retrying、failed、cancelled、succeeded。只有实际远端关闭回执才显示成功。网络超时等不确定结果自动退避重试，先读远端，避免重复写；401/403/404/410/422 等权限或对象错误停止自动重试并显示可操作的失败原因。用户核对配置后可在「推进记录」点击「重新核对并同步」，继续同一动作。

相关 API：

- `GET /orchestrator/api/projects/:id/history` 显示动作、尝试次数、原因、远端结果及关联事件。
- `POST /orchestrator/api/projects/:id/synchronization/:operationId/retry` 只接受当前项目、仍具备验收授权的失败/重试中动作。

关闭本事件为 false，新的关闭请求显示 ignored。尚未发送的动作也重验开关。回执属于事实，内部结果事件不受用户开关阻断；不能关闭回执处理来制造成功状态。

迁移不重放历史验收，没有批量补关 Issue。测试包括超时已写入、权限失败后重试、发送前重开、旧版本及不同仓库对象。真实 API 语义见 [GitHub Issue 更新文档](https://docs.github.com/en/rest/issues/issues#update-an-issue)。

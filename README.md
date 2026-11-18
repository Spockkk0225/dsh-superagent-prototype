# Super-Org

[简体中文](README.zh-CN.md)

Super-Org helps teams turn evolving discussions into project work. Share meeting notes in a project group, confirm the goal and ownership, and let the selected Agent help carry tasks through execution, delivery, and human acceptance. The project board shows what changed, who needs to act, and what actually happened.

A project can start with a discussion and no repository. Tasks can be handled by people or by the Agent. A GitHub Issue is an optional task reference, and a pull request is evidence for a code delivery. The team can revise its goals, dependencies, and assignments as new information arrives.

## How work moves

1. **Agree on actions.** The Agent uses meeting notes to propose concrete tasks, owners, and acceptance criteria. The team confirms the scope and kickoff.
2. **Work through one project state.** The board and project chat use the same project operations. Work assigned to the Agent gets a ticket that records execution, questions, and delivery.
3. **React to events.** A ready task, a blocked ticket, a scheduled check, or feedback on a linked PR can wake the Agent with the current context. Project settings and permissions govern the actions it can take.
4. **Accept the delivery.** A person accepts or returns the current delivery. Acceptance can unblock the next task and close a linked Issue when the task is explicitly responsible for resolving it.

The system records facts, Agent decisions, tool results, and delivery receipts in SQLite. GitHub, DingTalk, Feishu, and local requests follow a common source contract. GitHub and DingTalk support the project workflows described here. Feishu retains its message and ticket integration. The headless service currently uses Codex for planning and execution.

## Quick start

Requires Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0`.

```sh
git clone https://github.com/neug-ai/super-org.git
cd super-org
pnpm install --frozen-lockfile
pnpm build
pnpm start:codex --projects-only
```

Open the [project workspace](http://127.0.0.1:3082/orchestrator/projects). This mode supports local project and member management without external accounts. For Agent execution, group chat, or repository integration, follow the deployment guide. [Deploy Super-Org](docs/deployment.zh-CN.md)

## Documentation

The [documentation index](docs/README.md) also lists the event reference and verification notes.

| I want to… | Read |
| --- | --- |
| Run a project with my team | [Project collaboration](docs/project-guide.zh-CN.md) |
| Configure the Agent, DingTalk, GitHub, or migrate data | [Deployment and operations](docs/deployment.zh-CN.md) |
| Understand the project model and event lifecycle | [Architecture](docs/architecture.zh-CN.md) |
| Configure events or add a source | [Event configuration](docs/events/README.zh-CN.md) · [Source adapters](docs/source-adapters.zh-CN.md) |
| Verify the workflow on a real project | [2048 acceptance walkthrough](docs/2048-manual-acceptance.zh-CN.md) |

Run `pnpm check` for type checking, tests, and a build.

## Credits

Super-Org builds on DeepSeek’s execution and source infrastructure. The upstream repository maintains its original DSH design and setup documentation. [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)

Distributed under the [MIT License](LICENSE).

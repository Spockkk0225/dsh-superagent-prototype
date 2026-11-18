# Codex CLI and DingTalk

This entry boots the existing `src/app/runtime.ts`. It uses the original Store, Engine, Policy, Effects, DshExecutor, MasterAssessor, Sessions, prompts, role tools, report relays and Outbox. The Codex host adapter replaces session transport and host events. DingTalk is a Source kind. There is no second orchestration implementation.

Worker reports still go through `orchestrator_report → reportRelay → main Session`. The main Session decides whether to continue, ask for human action, answer a question or deliver a result through `orchestrator_reply`. Ordinary progress stays internal. A blocked/failed report without a question still reaches the main Session.

The entry also starts the existing GitHub polling loop after DingTalk connects and stops it on shutdown. Polling uses the original cursors, deduplication and policy gates; unchanged polls do not invoke the model. The GitHub Source settings control the interval (60 seconds by default) and repository observation switches; starting polling does not enable those switches or add group broadcasts.

Optional DingTalk AI cards display a source receipt before model processing and append agent confirmations and results in the same card. Followups use the client's native quoted reply plus a robot mention, or an explicit task ID. See `cards/README.md`, publish the supplied [template](../cards/dingtalk-superagent.json), and set `DINGTALK_CARD_TEMPLATE_ID` to enable this mode; text mode remains the default.

## Install and start

Requires Node 22.19+, a Codex CLI with app-server dynamic tools, and the original GitHub setup: an authenticated `gh` executable with push access to the configured repository. The desktop application does not need to run. This preserves the original repository/account checks.

```sh
pnpm install --frozen-lockfile
npm run typecheck
npm test
npm run build
```

Set the installation variables **before the first start**; see [.env.template](../.env.template). Credentials may remain in the existing env file:

```sh
SUPERAGENT_STATE_DIR="$PWD/state-codex" \
CODEX_BINARY=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
CODEX_MODEL=gpt-6.1-sol \
CODEX_SANDBOX=read-only \
node lib/codex-cli.js --env-file /absolute/path/to/dingtalk.env
```

The bundled CLI above was available on the test machine; another compatible Codex executable can be used. Stop any older listener for this same DingTalk robot before starting this entry.

Wait for `ready`, then @ the robot with a small read-only request. Acceptance is an acknowledgement; the original main Session delivers a subsequent ready result or necessary human action. Ctrl+C stops the service. `CODEX_SANDBOX=workspace-write` enables Worker file changes in its ticket worktree. Both sandboxes permit network access so the existing GitHub workflow can run; read-only applies to Worker file operations, while the service still persists state, prepares worktrees and sends messages.

To explicitly run main and Worker session commands directly on the host, set `CODEX_SANDBOX=danger-full-access` and restart the service after rebuilding. This disables their filesystem/network sandbox and uses `approvalPolicy=never`; commands run with the service user's host permissions, including access to its existing CLI credentials. The admission router remains read-only. Existing persisted Codex threads receive the selected mode when resumed; no state deletion is required.

## Start on another computer

1. Install the required Node.js/pnpm versions, Git, an authenticated GitHub CLI with push access, and a compatible authenticated Codex CLI. Clone this adapted repository and the target repository onto the new computer.
2. In this adapted repository, run `pnpm install --frozen-lockfile` and `npm run build`. Copy `.env.template` to `.env` (ignored by Git), then fill in the DingTalk application credentials and the new computer's absolute repository, state and Codex executable paths. Set `CODEX_SANDBOX=danger-full-access` for the explicitly selected host-execution mode, or choose a sandbox as described above.
3. Stop the old service before connecting the same DingTalk robot on the new computer. Start with `npm run start:codex -- --env-file .env`, wait for `ready`, then mention the robot in its group.

These steps start a fresh installation. Runtime state, credentials, ticket worktrees and Codex conversation history are not included in Git. Continuing old tickets requires a separate coordinated migration of the state database, worktrees and Codex history, with their saved paths accounted for; copying just the database is insufficient. An existing state directory also retains its saved installation settings, including the old prepare command's repository path.

## Settings and state

### Project management

In the configured project group, a project member can mention the robot with `项目会议纪要` followed by a newline and the minutes. The robot puts agreed actions on the board and replies with the changes. When an action needs clarification, the robot asks one specific question. Mention the robot with `会议反馈：…` or reply to the minutes to supply the missing detail and resume planning. Project members can also use `更新计划` or the project Decisions page to request an update. A member can confirm kickoff in the group, and an operator can set the same project status on the board.

When `DINGTALK_OPEN_CONVERSATION_ID` names a group with no saved project, a registered member can submit the first minutes after the team agrees what project to start. Include a `项目名称：…` line. If the team has picked an existing GitHub repository, include one `GitHub 仓库：owner/repo` line or its GitHub URL. Omit that line when the repository is undecided; it can be set later. The service creates a project awaiting kickoff, uses the member directory to resolve named assignees and reviewers for that first meeting, and then uses the ordinary planning workflow.

The project's optional GitHub repository and DingTalk group are stored in SQLite. Edit those fields in the project workspace. Each dispatched task uses the repository saved at dispatch and gets its own checkout. A project without a repository gets an isolated local workspace. When GitHub repository streams are enabled, linked repositories join the poller automatically. Repositories shared by several projects are polled once. New project repository events use repository-qualified thread identities, with independent cursors and health. These observations are recorded and can reach subscribed tickets. New work still comes from the existing project workflow and the configured GitHub source's admission rules.

Task details let a member copy the title, description, acceptance criteria and a stable task reference. A project member can quote a task message and ask the DingTalk robot to create an Issue in ordinary language, or mention the task by name. When several tasks are plausible, the robot asks which one. Creation uses the project's linked repository and records the resulting Issue URL on the task. An existing Issue URL can also be recorded manually. Tasks can be managed with or without a linked Issue.

After kickoff, a member can ask the robot to start an Agent task by replying to a task message or naming the task. The command uses the same operation as **Run task** on the board, which creates an execution ticket and sets the task to **In progress** together. A member can also explicitly confirm kickoff and request dispatch in one message. Combined kickoff and dispatch commit together, and task dependencies and pending decisions have to be resolved. A request to start only a task still requires kickoff.

A successfully ended ticket with a ready report publishes the durable `delivery.ready` event. Its handler moves the current task into review and queues a notice in the linked DingTalk group, including for manually dispatched tasks. **Automatic progress** controls dispatch of ready Agent tasks and group notices for owners of newly unblocked human tasks. Mark a task complete after review to release its dependents. See `docs/events/README.zh-CN.md` for the JSON API, default values, and current implementation stages.

Open **Agent Status** from the workspace sidebar to see the shared runtime, DingTalk connection, GitHub authentication and repository polling. The page is available before any projects exist. Use **Local Agents** there to scan the machine and see the robot Agent. Codex currently handles meeting planning, orchestration, and coding work. Other detected CLIs appear in the inventory until their full runtime is integrated. Each project shows its repository and task execution records in its own workspace.

Open `http://127.0.0.1:3082/orchestrator/projects` for the project workspace. The full Codex service and the DSH panel expose the same project API and state. To use the standalone project workspace without any source credentials, run `pnpm build` followed by `pnpm start:codex --projects-only`. Both modes use `SUPERAGENT_STATE_DIR` and its exclusive lock. Stop one mode before starting the other with the same state directory.

Project writes use the existing loopback management API and `X-Orchestrator-Request: 1`. `GET /projects` lists the workspaces, `POST /projects` creates one, and `GET /projects/:id` returns its board. Submit a change to `POST /projects/:id/changes` using the current project revision and a change such as `{"kind":"task","value":{"title":"Collect evidence"}}`. The API returns 409 for a stale revision. Member records are available at `/members` and project membership is managed through project changes.

Issue links belong to tasks and use public GitHub URL syntax. The full service can look up issue titles in the configured repository. A project allows one newly linked task per canonical Issue URL. The task workspace shows its issue, linked execution ticket, worker reports, questions, and PRs. The ticket chooser lists recent tickets in the shared database and prioritizes matching issue URLs. An operator can dispatch a task, send a follow-up, or stop its locally launched ticket when the full service is running. Dispatch uses the original request source gate and transactionally binds the new ticket to the project task. Acceptance of the project task remains an operator action.

Full Codex startup supports the project workspace with both DingTalk environment fields unset. Provide the checkout, authenticated GitHub CLI, and Codex CLI as usual. The operator submits via the local request channel, which records its messages in the existing outbox. The project page displays the persisted execution state directly.

After building, run `pnpm import:mission-control /path/to/mission-control/data /path/to/state` against an existing, stopped Super Agent state directory. Copy a consistent snapshot of the legacy data directory before importing. The command writes planning records in one transaction, skips projects already imported from that workspace, and reports the imported counts. Agent roles from old task assignments become descriptive text. Goals flatten into milestones, and a first top-level goal supplies the current objective. Claude execution state, field operations and inbox messages stay in the source directory.

### Local request delivery

Scripts can submit operator-authored instructions through the existing loopback-only HTTP server. The request body contains only `prompt`; each successful call creates an independent request and returns its `trigger_id`. No scheduler runs inside the agent.

```bash
curl --fail-with-body http://127.0.0.1:3082/orchestrator/api/requests \
  -H 'X-Orchestrator-Request: 1' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Investigate CI failures on main from the past day and summarize their causes."}'
```

Use the configured web-server port if it differs from 3082. The endpoint retains the management API's loopback, Host, Origin and custom-header checks; it adds no public listener or remote authentication. Local scripts act as the local operator: the independent `request` Source defaults to allowing its `local` actor, and ordinary policy and main-agent routing still apply. Disabling that Source stops intake; its allowed list can be restricted in Policy.

Set `DINGTALK_GITHUB_NOTIFY_CONVERSATION_ID` to the default reply group and keep the DingTalk Source enabled. Requests fail if this output is missing. With the existing DingTalk card template configured, intake creates the same pending card as a group mention; initial agent confirmation, worker card binding, explicit final replies and missing-reply reminders use the existing card lifecycle. The HTTP response is only a receipt, not the agent's confirmation or final reply. Manual scripts and external cron jobs use the same endpoint. Repeating a POST creates a new request.

### GitHub App polling and DingTalk notifications

App mode discovers assignments to the agent, individual PR review requests, and mentions in repository comments without the user notifications API or the repository-wide observe switches. Assignment and review-request actors still pass the existing static allowed list, populated from repository admin users at each Codex startup. Review requests have independent event threads; a robot-created PR bound to a ticket keeps its existing subscriptions, including unmentioned comments, reviews and closure after a ready report. PR CI is not polled or dispatched; workers may inspect checks on demand but never wait for them.

App mode polls the checks and statuses on the current head of **main**. Once a completed snapshot is stable across two polls, the configured DingTalk group receives a card for the set difference from the last reported snapshot on that SHA: new check IDs and status contexts only. Previously reported checks are excluded from the task and its failure count, even if their results change. Nightly checks and reruns with new check IDs on that head can produce another task. Scheduled runs on superseded commits are outside this monitor.

The adapter wraps automated events in a group task and retains the original GitHub event, actor and URL. With explicit group admission enabled, a standalone CI task starts a worker to report a successful result or investigate a failure. Acceptance and the final result update its original card. An event on an eligible existing PR thread goes to its subscribed worker. Repeated delivery of the same event ID reuses the stored request.

Human GitHub mentions, assignments and review requests retain GitHub sender checks and their source reply route. Unmentioned PR comments and reviews are received only on a PR opened by the task. Workers report the available result without waiting for remote CI.

Worker cards bind at actual message delivery, using the worker's model/inbox/background execution state. A busy worker reuses its current open round's card; an idle worker's next external message starts a new card even if an older card was never closed. Multiple messages delivered while the worker executes share its round, including messages collected in one polling round. Each worker delivery ID has a durable, immutable card binding included as `reply_card` in the delivered message; a retry never allocates another card. The same trigger delivered to different workers binds independently for each worker. Initial confirmations are deduplicated by card/round, not globally by source trigger. Worker reports capture `reply_card` before a later round can replace the active pointer; the main agent passes its exact `card_id` to `orchestrator_reply`, retaining ordinary purpose/readiness checks. Requests awaiting main-agent routing have a trigger-specific card, adopted by the selected worker when first delivered. The transport is constructed before startup recovery to make those bindings available on resume. There is no FIFO card-matching queue, and legacy waiting-card queues are no longer read.

Every bound card requires an initial agent confirmation and an explicit final reply, for human requests and system events alike, including ignored, duplicate, no-action, failed and cancelled outcomes. The automatic waiting receipt is not the agent confirmation. The receiving agent sends it: the main session for work delivered to the main agent, or the worker for direct worker delivery. Additional events in an executing round reuse the existing confirmation; a new round needs a new one. This message rule takes precedence over silence policies. The human-only `orchestrator_ack` gate remains unchanged; the shared `orchestrator_card_reply` tool provides `list`, `acknowledge` and `reply` actions for any bound card, and workers can access only their own task's cards. Pending card IDs and whether an initial confirmation is required are included in session instructions. Confirmation IDs are durable and deduplicated, and final card replies are refused until an initial confirmation has been queued. Normal result/answer/attention permissions still apply, and the card tool must not bypass them. Once agents and delivery queues are idle, the service sends the main session one durable reminder for a still-open current card; it does not synthesize a result or repeatedly wake the session. A queued final reply closes the processing round; transport delivery retains the original card ID and existing retry behavior. Historical cards without the new bindings are not backfilled.

Set `DINGTALK_GITHUB_NOTIFY_CONVERSATION_ID` in the actual env file to select the acknowledgement and summary destination for GitHub-triggered work. Leaving it unset keeps the original GitHub reply destination. Intake retains the GitHub source, actor, text, PR/Issue metadata and URL for the worker, while binding the existing task reply channel to the configured group. The worker performs GitHub operations with gh, reports internally, and the main agent delivers a summary to DingTalk. For human GitHub mentions, explicit initial confirmations and final replies are also queued to the original GitHub comment conversation or inline review thread. Both destinations have durable receipts, deterministic deduplication IDs and independent delivery retries; withdrawing an unsent reply withdraws its unsent mirrors too. Same-round mentions in one conversation do not create duplicate copies of the same reply. Service waiting receipts and system CI events are not mirrored. A round that also receives private IM follow-ups suppresses automatic GitHub mirroring to avoid publishing that context. There is no separate notification scheduler or result scan, and existing replies are not backfilled. Workers must not separately copy the same acknowledgement or summary with gh. When cards are enabled, the initial confirmation and final result update the same bound card; with cards disabled, replies use text. Messages with a ticket ID include a source label such as `#77fb51f5cabc · GitHub Issue Assign`. The robot must belong to the group and have the relevant card or group-message send permissions.

GitHub mention mirrors use one comment per card/processing round and target conversation. The initial confirmation creates it; later replies edit that same comment with cumulative content separated by horizontal rules. A stable hidden card marker locates the comment, and an increasing snapshot revision prevents an older retry from overwriting newer results. The bot identity prefix appears once. Inline review-thread replies use the corresponding review-comment edit endpoint. Each worker round has its own comment, and existing comments from the previous per-message scheme are not automatically merged or edited.

### GitHub App identity

Install the same GitHub App on the upstream and your fork. The watched upstream needs Contents read and Pull requests/Issues write permissions; a fork used for code pushes needs Contents write. Grant Checks and Actions read permissions for CI inspection. Metadata read access is implicit. Download an App private key onto the service machine; keep the PEM file outside the checkout and restrict its file permissions to the service user.

For a new state directory, set `SUPERAGENT_GITHUB_AUTH=app`, `SUPERAGENT_GITHUB_APP_ID`, `SUPERAGENT_GITHUB_PRIVATE_KEY_PATH` and `SUPERAGENT_GITHUB_INSTALLATIONS` before the first start. The last variable is a JSON array of repository-to-installation mappings as shown below. `SUPERAGENT_GITHUB_CLI` still names the real `gh` executable. Both installations use the same `neug-agent[bot]` identity, with different repository access tokens. The old `SUPERAGENT_GITHUB_INSTALLATION_ID` remains supported for a single watched repository; use either the single ID or mappings.

For an existing installation, environment variables do not replace saved Source settings. Read `GET /orchestrator/api/settings`, keep the current GitHub block's configuration and revision, then save it with `PUT /orchestrator/api/settings/source:github` and the `x-orchestrator-request: 1` header. Add this object to the existing `value.config`:

```json
{
  "app": {
    "appId": "123456",
    "installations": [
      { "repository": "alibaba/neug", "installationId": "12345678" },
      { "repository": "your-login/neug", "installationId": "87654321" }
    ],
    "privateKeyPath": "/absolute/path/to/neug-agent.pem"
  }
}
```

Keep `repository`, `cli` and observation settings in that configuration. The `cli` must remain the real GitHub CLI, not a generated `stateDir/github-app/.../gh-app` wrapper. Saving validates the App installation and requests a service restart. To return to personal authentication, remove `app` and save again.

The service validates every configured repository and installation. Tokens are cached separately per repository and installation and refreshed five minutes before expiry. Each invocation selects credentials using the REST repository path, `--repo`/`-R`, a repository URL, or an explicit GraphQL repository; otherwise it uses `GH_REPO`, the checkout's `origin`, then the watched repository when no origin exists. Use explicit targets for cross-fork work, for example `gh pr create --repo alibaba/neug --head your-login:branch` or `gh pr comment 123 --repo alibaba/neug`. One GraphQL request cannot span multiple repository targets; issue separate requests. Unknown repositories fail rather than falling back to another installation or personal login.

Git's credential helper uses the remote repository path (`credential.useHttpPath=true`) to choose the fork or upstream token. Push to your fork remote and create/comment on PRs against the upstream explicitly. The worker receives the authorized repository list as `DSH_SUPERAGENT_GITHUB_REPOSITORIES`; it still watches only the configured Source repository. An App-authored PR whose head is in an authorized fork can bind to the task when its branch matches the task name. Git commits retain the existing explicit author policy; authenticating pushes as an App does not rewrite commit authors.

App installations have no personal notification inbox. App mode polls repository Issue/PR and comment streams instead to discover mentions, and reads reviews on changed PRs and subscribed threads. Existing observation switches, policy gates, cursors and deduplication still apply; enabling App authentication does not enable proactive work or group broadcasts. Polling uses the original initial-baseline behavior rather than replaying repository history.

For macOS CLI credentials stored in Keychain, keep the sandbox and use Codex's native execution rules for the intended commands. Install [codex-readonly.rules](../codex-readonly.rules) as `~/.codex/rules/superagent-readonly.rules` and restart the service. It permits only `gh pr list/view/checks` to run with host permissions; it neither copies tokens nor changes login state. Every subsequent Worker inherits the same native rules. Other tools can use the same operator-managed rule mechanism; they do not require separate credential-injection code. The adapter uses `on-request` with user review, and declines unresolved approval prompts in headless mode instead of auto-granting them. Model subagents remain disabled.

An authentication failure inside a sandbox does not prove the host login expired. Test the configured native command rule before asking the user to log in again. `workspace-write` alone does not grant macOS Keychain access.

The first start seeds the original Settings schema: GitHub repository/CLI, the prepare command creating a ticket worktree, and DingTalk admission row `group.unlistedAddressed=explicit`. This allows every received group mention without a user/group whitelist. Later starts keep the original settings history; installation settings are managed through the original settings API, rather than overwritten from environment variables.

The original loopback management API is served at `http://127.0.0.1:3082/orchestrator/api/`; `SUPERAGENT_PORT` changes the port. Its original same-origin/header checks remain. This does not provide the DSH desktop/web UI shell.

The database is `state-codex/orchestrator.sqlite`. Codex thread IDs, durable inboxes and session events use that Store's KV, while ticket/assignment/outbox data use the original tables. Earlier experimental `standalone/state` data and worktrees are retained on disk but are not imported or executed by this entry. Reissue an old experimental request as a new request after switching.

## First-version boundaries

- Only group @ messages enter the Source; private messages and ordinary group messages remain outside scope. All message types are admitted: plain text, rich text, image, audio, video, file and unknown types. Rich text is projected in its original order, and supplied audio transcription/file names are retained. Binary attachments currently produce explicit unparsed-content markers; their native body/references are retained in Source KV, but are not automatically downloaded or interpreted.
- Follow up with `@robot #<12-character-ticket-id> ...`. In AI card mode, the client's native quoted reply can recover the task when the callback includes the robot's task-bearing summary or card text; mention the robot and send normally. Verify desktop and mobile behavior as described in `cards/README.md`; add the task ID explicitly if the client omits that information. References associate only within their originating group.
- No subagents: Codex multi-agent features are disabled, and no subagent service/tools are exposed.
- Built-in Codex coding tools use the configured sandbox. Original orchestrator tools keep their original schemas and handlers.
- Native command events feed the original worker-slot/background-work tracking. Codex's terminal cleanup API operates on a whole thread, so stopping one native background job cleans that thread's background terminals together.
- The DingTalk session webhook is used while valid; after expiry, replies use the application group-send API, which requires the robot's group-message send permission.
- DingTalk has no guaranteed exactly-once send transaction with SQLite: a crash after the platform accepts a reply but before its receipt commits can duplicate that reply.

For a real-model smoke test without sending a DingTalk message or touching a repository:

```sh
CODEX_SMOKE_BINARY=/path/to/codex CODEX_MODEL=gpt-6.1-sol \
  node_modules/.bin/vitest run tests/codex-harness.spec.ts -t 'real read-only'
```

This uses an isolated temporary Runtime, mocks only account setup and the outgoing DingTalk channel, and exercises the real Worker report, main Session and reply tools.

To verify host GitHub authentication through native rules in two fresh read-only Worker sessions (no robot messages or repository changes), set `CODEX_GH_SMOKE_BINARY=/path/to/codex` and run `node_modules/.bin/vitest run tests/codex-rpc.spec.ts -t 'two fresh'`. This test verifies actual command events and exit codes, not an assistant's claim of success.

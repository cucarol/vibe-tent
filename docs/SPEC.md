# Tent Specification

Tent / 帷幄 is a local control plane for durable user-agent collaboration. It
stores project intent, context, relationships, work packages, execution state,
review, and delivery without replacing the user's editor or Agent UI.

The Local Service is the authority for mounted workspaces and mutations. The
Desktop app, CLI, and optional plugins are clients of that same contract.

## 1. Workspace And System Root

A Tent belongs to one project workspace:

```text
workspace/
  AGENTS.md          # project-wide Agent instructions (optional)
  .tent/             # Tent system root, ignored by workspace Git
    index.md          # structural marker
    types.json
    tags.json
    roles.json
    temp/             # operational Task/Delivery pipeline
    attachments/
```

The workspace stores real project files and Git history. `.tent/` stores Tent
facts and does not use its own Git repository. Workspace identity comes from
the mounted workspace path, never from a Node field or type setting.

Runtime discovery requires `.tent/index.md`. The retired `.tent/RULES.md` is
not read at runtime. A one-shot importer may recognize and discard it when
migrating a v0.1 external Tent root.

## 2. Nodes

A Node is a folder plus a same-named Markdown identity note:

```text
Release plan/
  Release plan.md
```

A folder without a same-named note is a transparent group. `temp/` and
`attachments/` are system areas, not Nodes.

Minimal Node frontmatter:

```yaml
id: cx-7k2f9q
type: goal
tags: [release]
mode: archived
```

Durable Node facts are:

- stable `cx-` identity;
- name and parent hierarchy;
- Markdown body;
- primary and optional secondary type;
- tags and explicit semantic relations;
- archive state;
- annotations;
- Output provenance fields where applicable.

Paths may change; ids do not. Controlled rename and move mutations use the
stable id plus stale-path checks. Duplicate ids fail loud unless a copied
subtree is explicitly adopted as a fork and receives fresh ids.

Node collaboration progress is never persisted as generic `owner`, `status`,
or `acceptedBy` fields. It is projected from Task, Session, and Delivery.

## 3. Type, Tags, And Archive

Primary type is a fixed product vocabulary:

```text
goal | prompt | output
```

These words are stable Tent terms and are not localized. They describe the
Node's main semantic role:

- `goal`: a result or direction to achieve;
- `prompt`: instructions, context, questions, decisions, or working material;
- `output`: a result or pointer produced from work.

Secondary type is optional. Built-ins are `reference` and `asset`; users may
register additional stable identifiers. Secondary type is a semantic modifier,
not a progress field. Tags are independent reusable facets for retrieval and
cross-cutting classification.

`.tent/types.json` stores type identity and tier only. Color, description,
read/write policy, and coordination flags are presentation or retired concerns
and are not Core type semantics.

`mode: archived` freezes a Node subtree and acts as reversible soft deletion.
Archived or invalid Nodes reject ordinary content and structure mutations.
There is no general `read-only` Node mode and no type-based R/W gate.

## 4. Roles And Agents

A Role is a durable responsibility to the user. Its registry definition has a
stable Role id, name/display name, optional prompt, user-facing delivery policy,
and a roster of logical Agent ids.

An AgentDefinition is a stable logical worker identity. An AgentProfile is
machine-local launch resolution (provider, model, credentials, command, and
runtime options). A Role roster authorizes Agent ids, not Profiles.

Role and Session are different:

- a Role survives Session replacement;
- a Session is one execution instance, managed or external;
- compatible downstream Sessions may be reused by the Role;
- persisted Nodes, Tasks, Deliveries, checkpoint, and Git are the recovery
  authority when a Session cannot continue.

Two composable Skills define Agent behavior:

- `tent-role`: durable Role responsibility, roster use, downstream review, and
  user-facing delivery;
- `tent-task`: the execution protocol for every concrete Tent Task.

A Role executing a Task uses both. A one-shot or managed downstream executor
uses `tent-task` only.

## 5. Task And Context Card

A Task is one work package and one review unit. It is not a Node and does not
own a Node exclusively. Multiple Tasks may reference the same Node.

Dispatch persists:

- exact `parentActor` and `reviewer` authority;
- assignee (`role`, logical `agentId`, or direct AgentProfile path);
- objective, acceptance criteria, prompt delta, and referenced entities in a
  Context Card;
- optional Git WorkspaceLane;
- context compatibility generation and task delta digest.

Node references live authoritatively in `Task.contextCard.refs.nodes[]`; ids are
authoritative and paths are refreshable hints. Dispatch drafts are UI state and
become Tasks only on confirmed dispatch.

The stable managed prompt prefix contains the Task protocol, project
instructions, Role prompt where applicable, and compatible Agent context.
Dynamic Task state and TaskInput are appended as a tail. Exact compatibility
generation is required before a managed Session may reuse a cached prefix.

Task states and transitions are owned by Core. Clients must use Service
commands and consume projections rather than deriving lifecycle from files.

## 6. Sessions And Runtime

The Service owns managed ACP Session launch, binding, replacement, input
injection, and terminal projection. External Sessions explicitly enter/claim
and leave through the same persisted Task contract.

A Session may execute more than one compatible Task, but a Task remains the
delivery boundary. Replacing a Session must preserve the same Task and
worktree, rehydrate from persisted context, and never require envelope edits.

Provider/model/key configuration belongs to machine-local AgentProfiles or the
Agent's native tooling. Tent does not become a general CLI configuration
manager. Skill and MCP availability may be reported, but Tent does not silently
rewrite every Agent's native configuration.

ACP stdio is a bounded adapter boundary. Tent rejects an oversized JSON-RPC
frame before parsing it, bounds per-turn assistant report bytes and update /
segment counts, and bounds outbound bootstrap/request frames. A deliverable
assistant report that crosses the limit fails loud with `ACP_OUTPUT_LIMIT`,
stops the provider, and cannot emit `prompt_complete`, a ready Delivery, or a
delivered outcome. Diagnostic tails are independently truncated and redacted;
diagnostic truncation is never used to turn an oversized report into a Delivery.

## 7. Delivery And Review

A Delivery is an executor's formal result for one Task. It is separate from the
Task, Session, and any Output Node. It contains a human summary plus optional
commits, checks, and artifact references.

The executor submits Delivery to the exact persisted reviewer. Downstream Task
Agents always use review-to-parent and cannot self-accept.

Role-to-user delivery policy is one of:

- `review`: user accepts or rejects;
- `bypass`: Service may complete without user review under the persisted policy;
- `agent-decide`: the accountable Role decides whether user review is needed.

Reject may resume the same Task with review feedback. Accept may integrate
declared commits and then atomically update Task/Delivery state. Integration is
fail-loud, never pushes, and does not write generic status back to Nodes.

A managed Delivery is published only after the producing turn and workspace
lane have settled. An Agent report is not sufficient while the same turn can
still write or commit.

## 8. User And Agent Interaction

The Service persists interaction types separately:

- TaskInput for user/parent feedback to a Task executor;
- UserAsk for an Agent question requiring a user answer;
- A2A approval for controlled Agent-to-Agent launch;
- tool approval where a provider requires it;
- Delivery review.

`interaction.listPending` is a read-only aggregate projection. Resolution must
return to the owning domain command; there is no generic "resolve pending"
mutation.

Annotations belong to Node text. They become Agent work only when the user
explicitly converts or sends them as Task context/input.

## 9. Git Lanes

Durable Role lane:

```text
branch:   tent-role/<role>
worktree: <workspace>-worktrees/<role>
```

Managed Task Agent lane:

```text
branch:   tent-task/<task-id>
worktree: <workspace>-worktrees/task-<task-id>
```

Role lanes are durable. Task lanes are temporary and enter exact pending
reclaim only after terminal Task state, Session settle, clean worktree,
unambiguous ownership, and required integration. Reclaim never deletes commits,
branches, Task records, or Role lanes and never performs historical mass-prune.

Delivery commit ancestry is checked against the Task's dispatch-time base.
Ordinary executors may not merge parent history into their lane to bypass
review.

## 10. Mutation And Projection

All in-workspace mutations go through the Local Service and MutationBus. The
CLI, Desktop, and plugins do not directly edit `.tent` operational state.

Core fails loud on duplicate identity, stale paths/etags, archived mutation,
invalid registries, authority mismatch, dirty or ambiguous Git lanes, and
integration conflicts.

Events are invalidation signals, not a second fact store. Clients re-query the
relevant projection after an event. Transport health and projection health are
distinct; clients must bound queries, expose retryable errors, and avoid
presenting stale local view state as authoritative graph data.

## 11. Public CLI

Primary collaboration commands attach to the Local Service:

```text
tent status
tent tree
tent roles
tent task list|get|dispatch|claim|deliver|accept|reject|cancel|send-input|...
tent role-init <role>
tent role-checkpoint set|show|clear
tent agent status|enter|leave
tent skill-install [--target ...] [--force]
```

One-shot migration and external-root maintenance commands are explicitly
separate from the normal in-workspace mutation path. Retired public commands
are removed rather than kept as aliases.

## 12. Migration And Conformance

V0.2 migration is one-shot:

- `bx-` ids become `cx-`;
- `note` becomes `prompt` and `artifact` becomes `output`;
- legacy owner/status, type R/W/chrome, coordination, and read-only mode are
  removed;
- old external roots are copied into `<workspace>/.tent` without deleting the
  source;
- retired `RULES.md` is not copied; project rules live in workspace
  `AGENTS.md` and `.tent/index.md` becomes the structural marker.

There is no permanent dual-read or dual-write compatibility layer.

OKF validation:

```text
npm run okf:check
npm run okf:check:strict
```

## 13. Product Boundary

Tent may provide Canvas, Outline, Focus, Search, Pending, and settings surfaces,
but the presentation is not the Core model. Canvas placement is local view
state; dragging a card does not reparent a Node. Tent does not become an IDE,
workspace file explorer, or replacement Agent chat router.

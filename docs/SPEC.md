# Tent Specification

Tent / 帷幄 is a local control plane for durable user-agent collaboration. It
stores project intent, context, relationships, work packages, execution state,
review, and delivery without replacing the user's editor or Agent UI.

The Local Service is the authority for mounted workspaces and mutations. The
Desktop and CLI are clients of that same contract.

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

Runtime discovery requires `.tent/index.md`. Project instructions live in the
workspace `AGENTS.md`; `.tent/RULES.md` is not a runtime contract.

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

## 4. Roles, Connections, And Sessions

A Role is a durable responsibility to the user. Its registry definition has a
stable Role id, name/display name, optional prompt, and user-facing delivery
policy. A Role is not a provider configuration or an ACL.

Settings owns machine-local Agent Connections. A Connection has a stable
`connectionId` and resolves provider, model, endpoint, credential reference,
command, and non-secret launch metadata. It is not Task responsibility or identity.
Credentials remain in the machine-local service data area and never enter
workspace Nodes, Tasks, Sessions, or Git.

A durable Role takes ownership of its own work directly:

```text
tent task claim --work-node <nodeId> [--work-node <nodeId> ...] \
  [--context-node <nodeId> ...] --prompt <text>|-
```

This creates and immediately claims one Role Task. It has no target and is not
downstream assignment. Tent inherits its persisted parent/reviewer
responsibility from an explicit current Task or the verified current Role
execution context; a Role root falls back to the user.

Dispatch is downstream assignment only and has two public targets:

- `role:<roleId>` creates a queued handoff to a durable Role;
- `connection:<connectionId>` reserves a Session with an immutable non-secret
  Connection snapshot, creates the formal Task already bound to that exact
  Session, then starts the provider outside the lifecycle mutation.

A temporary ACP Session remains execution state of its exact Task. Durable
responsibility, review authority, and Node ownership remain with the Role and
Task chain.

Role and Session are different:

- a Role remains durable across its execution contexts;
- a temporary managed ACP Session is one Task execution instance;
- that Session may resume only when the same provider conversation is
  still recoverable and Core proves compatibility;
- persisted Nodes, Tasks, Deliveries, checkpoint, and Git are the recovery
  authority when a Session cannot continue.

Two composable Skills define executor behavior:

- `tent-role`: durable Role responsibility, Node context, downstream review,
  and user-facing delivery;
- `tent-task`: the execution protocol for every concrete Tent Task.

A Role executing a Task uses both. A one-shot or managed downstream executor
uses `tent-task` only.

## 5. Task And Context Card

A Task is one work package and one review unit. It is not a Node. Its exact
`workNodeIds[]` are acquired atomically; `contextNodeIds[]` are shared read-only
context. While the Task is active, another Task cannot acquire the same work
Node. Parent and child Nodes do not imply subtree locks.

Dispatch persists:

- exact `parentActor` and `reviewer` authority;
- optional durable `roleId` responsibility and/or exact executing `sessionId`;
- the immutable raw prompt in the Task body;
- optional structured objective, acceptance criteria, scope, decisions, and
  strict Artifact references in Context Card v2;
- optional Git WorkspaceLane;
- optional execution provenance written only after a Session computes it.

Work and context Node references live authoritatively in separate Context Card
v2 buckets; ids are authoritative and paths are refreshable hints. Dispatch
drafts are UI state and become Tasks only on confirmed dispatch.

The stable managed prompt prefix contains the Task protocol, project
instructions, Role prompt where applicable, and compatible Agent context.
Dynamic Task state and TaskInput are appended as a tail. Exact compatibility
generation is required before a managed Session may reuse a cached prefix.

Task states and transitions are owned by Core. Clients must use Service
commands and consume projections rather than deriving lifecycle from files.

## 6. Sessions And Runtime

The Service owns temporary managed ACP Session launch, binding, replacement,
input injection, and terminal projection.

A Task remains the Delivery boundary. A temporary ACP Session belongs to its
exact Task. Resume reconnects that same recoverable provider conversation,
while explicit replacement preserves the Task and worktree without envelope
edits.

Provider/model/endpoint/credential configuration belongs to machine-local
Agent Connections or the provider's native tooling. Tent does not silently
rewrite every Agent's native configuration. A Connection contains launch facts
only; it is not Session identity and does not define provider-owned Session
configuration.

ACP initialize capabilities and authentication method ids, plus the complete
`configOptions` returned by session new/load/resume and later
`config_option_update` notifications, are authoritative for that exact Session.
Tent preserves a bounded, non-secret audit snapshot on the Session record,
including flat or grouped select options and advertised boolean options.
Unknown option types/categories are ignored safely and missing options do not
invent defaults. Tent currently observes these options; it does not mutate them
through `session/set_config_option`.

ACP stdio is a bounded adapter boundary. Tent rejects an oversized JSON-RPC
frame before parsing it, bounds per-turn assistant report bytes and message
segments, and bounds outbound bootstrap/request frames. There is no global
count limit on real content, thought, tool-state, status-state, or configuration
progress. A consecutive storm of control updates that changes no observable
state fails loud, while diagnostic update fan-out is sampled and aggregated.
A deliverable assistant report that crosses the limit fails loud with
`ACP_OUTPUT_LIMIT`,
stops the provider, and cannot emit `prompt_complete`, a ready Delivery, or a
delivered outcome. Diagnostic tails are independently truncated and redacted;
diagnostic truncation is never used to turn an oversized report into a Delivery.

## 7. Delivery And Review

A Delivery is an executor's formal result for one Task. It is separate from the
Task, Session, and any Output Node. It contains a human summary plus optional
commits, checks, and artifact references.

The executor submits Delivery to the exact persisted reviewer. Downstream Task
Agents always use review-to-parent and cannot self-accept.

Every Task freezes one `acceptMode` at creation:

- `review-required`: the frozen reviewer accepts or rejects;
- `auto-accept`: Service creates a durable ready Delivery, then mechanically
  integrates and accepts under Core;
- `agent-decide`: the executor Session explicitly chooses integration or review.

Reject may resume the same Task with review feedback. Accept may integrate
declared commits and then atomically update Task/Delivery state. Integration is
fail-loud, never pushes, and does not write generic status back to Nodes.

A managed Delivery is published only after the producing turn and workspace
lane have settled. A non-empty natural ACP final report defaults to a Delivery;
an optional valid `blocked` or `needs-input` control outcome parks the Task
instead. An empty report never invents success, and malformed outcome syntax
never discards an otherwise valid report. Every non-empty final report is first
preserved as a durable draft, including a control report that parks the Task.

## 8. User And Agent Interaction

The Service persists interaction types separately:

- TaskInput for user/parent feedback to a Task executor;
- DecisionRequest for an exact requester Session question to a frozen user or
  Role authority; the response becomes deterministic exact-Task TaskInput;
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

Delivery commit ancestry is checked against the Task lane's capture-once base,
recorded when that execution lane first binds. Ordinary executors may not merge
parent history into their lane to bypass review.

## 10. Mutation And Projection

All in-workspace mutations go through the Local Service and MutationBus. The
CLI and Desktop do not directly edit `.tent` operational state.

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
tent role list|show|config
tent task list|get|dispatch|claim|deliver|accept|reject|cancel|send-input|...
tent task request-decision <taskPath> --question <text>|- [--options id=label,...]
tent task decision list|get|respond|escalate ...
tent task dispatch --target role:<roleId>|connection:<connectionId> \
  --work-node <nodeId> [--context-node <nodeId> ...] ...
tent role-init <role>
tent role-checkpoint set|show|clear
tent skill-install [--target ...] [--force]
```

Retired public commands are removed rather than kept as aliases. Public Task
dispatch accepts repeated `--work-node` and `--context-node` references and
`role:*|connection:*` targets.

## 12. Conformance

The public contract has one Node model, one Agent Connection launch selector,
and one dispatch grammar. A private workspace that predates this contract must
be canonicalized explicitly and audibly before use; Tent does not publish a
permanent migration API, dual-read, or dual-write compatibility layer.

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

# Grok ACP Provider Contract

Grok is one managed ACP adapter behind the Local Service runtime. Users select a
machine Agent Connection; Tasks and Skills do not contain provider credentials or
construct provider command lines.

## 1. Agent Connection

A Grok Connection may resolve:

- provider adapter id;
- model;
- API and authentication endpoints;
- optional Launch Secret reference for the headless bridge;
- command, args, isolated provider home, and safe environment entries;
- timeout and capability metadata.

The public selector is `connection:<connectionId>`. The Connection id is
non-secret and stable on one machine. Connection contents are machine configuration, not Node content,
Role membership, or collaboration authorization.

No key, token, OAuth blob, resume token, or full provider config is written to
the workspace, Task, Delivery, Node, Git history, or public event payload.

## 2. Launch isolation

Service snapshots the Connection into the Session and builds a private
launch plan. The Grok child receives a minimal inherited environment plus exact
Connection values and reserved Core keys. Reserved keys win over Connection input.

Provider home/config is isolated from unrelated host state when the Connection asks
for it. Working directory is the persisted Task lane, not the Service data
directory. The owning absolute Service data-dir is forwarded so child resume
and registry access do not resolve relative paths against a Task worktree.

## 3. ACP protocol

The adapter communicates over newline-delimited JSON-RPC and requires the
compatible protocol handshake. Local Service protocol and provider ACP
protocol are separate boundaries; a legacy Desktop/CLI endpoint is rejected
before Task mutation.

The adapter supports the provider operations exposed by its capabilities:

```text
start | resume/reattach | prompt | cancel/stop | runtime probe
```

Capability projection is factual. Missing resume or tool support is reported as
degradation rather than silently emulated.

## 4. Managed Task flow

```text
task dispatch --target connection:<connectionId> --work-node <nodeId> ...
  -> Service validates exact Node occupation and Task authority
  -> claims the Task and prepares its lane
  -> reserves one Session with an immutable Connection snapshot
  -> creates and claims the Task already bound to that Session
  -> starts the provider outside the lifecycle mutation
  -> assembles official bootstrap + Context Card tail
  -> prompts the provider
  -> preserves every non-empty final report before outcome handling
  -> publishes Delivery after all settle gates
```

The provider does not run Tent CLI claim/deliver commands. It cannot accept its
own Delivery or mutate Nodes directly.

## 5. Bootstrap and prompt

The official Service bootstrap contains stable project/Skill/Role context and a
dynamic Task tail. Caller text may append dynamic instructions but cannot
replace the stable contract.

The provider receives exact Node refs and the Context Card, not an automatic
paste of every related Node or prior conversation. Stable facts belong in Nodes;
incremental TaskInput and review feedback are appended through Service.

## 6. Resume and replacement

Resume or reattach must preserve the same recoverable Grok conversation for the
exact bound Task. Tent uses the Task's bound Session, immutable non-secret Connection
snapshot, provider token, native load support, and recorded lane. A changed
context generation sends the full current stable prefix; it does not replace
the conversation or select another Session.

If that conversation cannot be recovered, it is not presented as the same
Session. Explicit `task.replaceSession` may start fresh execution for the same
eligible Task and uses the common start/bind lifecycle CAS. A new work contract
requires a new Task.

## 7. TaskInput and questions

Managed TaskInput uses the Service FIFO and exact Task-bound Session. Retryable
rows are injected at most once per attempt. `uncertain` means delivery may have
happened and is never injected again; it remains a Delivery blocker until an
authorized acknowledgement.

A provider question that requires authority uses DecisionRequest and parks the
Task. The adapter does not turn arbitrary final prose ending in a question into
an implicit user request.

## 8. Final report semantics

The last natural non-empty assistant report is deliverable by default. A valid
optional leading `outcome: blocked` or `outcome: needs-input` parks the Task.
`outcome: delivered` remains accepted but is unnecessary. Missing or malformed
control text is preserved as report content; blank output never creates a
Delivery.

Service persists every non-empty final report before outcome handling or
publication. A control outcome may park but does not discard its full body. If
a later gate fails, retry reuses that draft and never re-prompts Grok merely to
reconstruct the same answer.

## 9. Bounded transport

The Grok adapter enforces:

- an inbound JSON-RPC frame limit before `JSON.parse`;
- assistant report byte, update, and segment limits;
- bootstrap and serialized outbound request limits;
- bounded stderr, stdout-tail, runtime-event, RPC-error, and ring diagnostics.

Limit failures use stable `ACP_OUTPUT_LIMIT` or `ACP_REQUEST_LIMIT`, stop the
child, and produce no false `prompt_complete`, Delivery, or delivered outcome.
Limits are large enough for the supported image request envelope but do not
permit unbounded text or frame accumulation.

## 10. Redaction

Known secret values are harvested from Connection launch environment, reserved Core
environment, and explicit diagnostic secret inputs. One redaction-aware bounded
primitive is used for strings and raw buffers.

Redaction handles UTF-8 boundaries, adjacent chunks, overlapping secret
occurrences, and a secret crossing the diagnostic cut. Truncation never converts
a credential into a visible prefix or suffix.

## 11. Failure and recovery

Provider start, prompt, transport, or unexpected-exit failure is mapped through
Service to the exact Task and Session. Eligible pre-Delivery failure parks the
Task at `session_unavailable`, preserving Node occupation, worktree, TaskInput,
DecisionRequest, and report draft for explicit recovery.

Start/replace binding races use the exact Task lifecycle snapshot/CAS. A
terminal transition may win; Service stops the unbound Session and records
`TASK_SESSION_BIND_CAS_FAILED` without publishing false Task or Delivery facts.

Service restart reconciles persisted Task/Session bindings. It does not guess
from a process id, task cwd, or remembered provider token, and it never starts a
replacement prompt in the background.

## 12. Testing expectations

Provider acceptance evidence should include:

- isolated data-dir launch and protocol handshake;
- real managed start/prompt/final report/Delivery flow;
- resume and explicit replacement races;
- TaskInput injection and uncertainty behavior;
- frame/report/request limit boundaries;
- secret redaction across chunk and byte boundaries;
- child stop plus continued Service health after failure.

Tests record process exit code and authoritative runner pass/fail counts. Tailed
or truncated output is not proof.

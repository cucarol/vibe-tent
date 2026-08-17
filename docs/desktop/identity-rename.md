# Canonical identities

Protocol 10 uses one name for each current identity.

| Fact | Canonical id | Authority |
| --- | --- | --- |
| Node | `cx-…` | Node frontmatter and graph projection |
| Role | `rl-…` | Role registry |
| Task | `tk-…` | TaskRecord |
| TaskResult | `rs-…` | TaskResultRecord referenced by `Task.currentResultId` |
| Session | `ss-…` | Session registry; Task execution uses `executionSessionId` |
| Agent Connection | arbitrary stable non-secret `connectionId` (for example `grok-acp-default`) | machine-local Connection catalog |
| TaskInput | `ti-…` | TaskInput store |
| DecisionRequest | `dr-…` | Decision store |
| Proposal | `pp-…` | Proposal store |

RPC parameters use these exact names: `taskId`, `resultId`, `requestId`,
`executionSessionId`, and `connectionId`. No alternative public names are read or
projected.

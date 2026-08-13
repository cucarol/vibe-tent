# Temporary managed ACP Session boundaries

Service starts a managed Session only through an Agent Connection. Durable
responsibility remains on Task requester/assignee; Connection is launch config.

| Boundary | Contract |
| --- | --- |
| Start | bind exact Task, Session, and immutable Connection snapshot before provider launch |
| Resume | same Session, snapshot, provider token, and provider context |
| Replace | explicit fresh Session for the same eligible Task |
| Submit | preserve one durable report draft, then submit one exact TaskResult candidate |
| Stop | report success only after the actual child exits |

After restart or compaction, re-read Task and Session. Never use remembered pid,
live Connection edits, or caller-supplied provider token as continuity authority.
Failed continuity parks the Task through existing waiting/status detail and keeps
TaskInput, DecisionRequest, context, and worktree.

Hard byte/frame/report limits and secret redaction remain mandatory. A truncated
or failed provider response never becomes a TaskResult. Context Card provides
facts; TaskRecord, exact binding, Node occupation, and WorkspaceLane provide
authority.

# Grok ACP provider

Grok is an ACP adapter reached only through an Agent Connection. It is not a
Role, reviewer, or direct Tent mutation authority.

The Connection snapshot contains canonical command/args and endpoint settings.
Required endpoint values are materialized before launch; secrets remain in the
child environment. Start, prompt, stop, and native resume use the common ACP
limits, redaction, permission, replay, and exit-confirmation contracts.

```text
Task + Connection
  -> exact Session binding
  -> ACP prompt
  -> natural non-empty report
  -> durable report draft
  -> task.submit
  -> ready TaskResult
```

The provider never runs Tent CLI lifecycle commands, reviews its own result, or
mutates Nodes. TaskInput is injected at most once; DecisionRequest handles user
choice. Provider failure keeps Task/context/worktree and exits through existing
waiting/failed status detail.

`npm run test:grok-e2e` is the opt-in live gate. Ordinary CI uses fake ACP
servers and contains no provider credentials.

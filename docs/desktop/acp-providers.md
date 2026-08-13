# ACP provider contract

All ACP adapters implement one runtime contract.

## Launch

Agent Connection persists a canonical command, complete args, cwd policy,
non-secret env names, skills, MCP descriptors, and optional endpoint. Session
captures that snapshot once. Start/resume execute the exact snapshot; provider
defaults are materialized at Connection creation rather than injected later.

Secrets enter only the child process. Streaming diagnostics are bounded and
redacted before persistence or projection.

The Agent or provider owns login, OAuth, subscriptions, and account lifecycle.
Tent only launches configured command, args, env, and endpoint; it does not
implement account switching or pools, nor token refresh. Launch Secret injection
remains a machine launch-boundary concern.

## Protocol behavior

- request and stdout frames have hard byte limits;
- assistant report and diagnostic tails are UTF-8-safe and bounded;
- permission requests use the host approval path;
- `session/load` replay stays quarantined until the required quiet window;
- `session/resume` restores the recorded provider context without replaying it
  as a new report;
- stop is truthful only after child exit is confirmed.

During `session/prompt`, contiguous agent-message chunks form one segment and
non-message updates close it. The last non-empty segment is the report; an
uninterrupted stream uses its full body. Service submits that report as a
TaskResult after settle gates. Provider ids and transport details never enter
Node, Task, TaskResult, or renderer projections.

## Verification

- adapter unit tests cover launch argv, redaction, limits, replay, and stop truth;
- `npm run test:grok-e2e` covers Grok execution and native continuity;
- `npm run test:foreground-e2e` covers mainstream ACP provider continuity.

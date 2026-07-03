# Output Record Cascade Completion

## Purpose

Completing a claimed box should also complete the direct output records created
under that box for the delivery. This removes repetitive user stamping without
turning status into an inherited tree property.

## Selected Behavior

Cascade completion is enabled by default for all three acceptance paths:

- `tent complete <boxId>`
- `tent stamp <boxId>`
- Obsidian's report confirmation action

The CLI accepts `--no-cascade` on `complete` and `stamp`. The Obsidian action
uses the default behavior and does not add another confirmation control.

## Matching Rules

A child is a cascade candidate only when all of these are true:

1. it is a direct child of the accepted box;
2. the base returned by `splitType(child.type)` is exactly `output`;
3. it is neither archived nor invalid; and
4. it has no owner.

Compound types such as `output-reference` match. Prompt children, custom base
types, deeper descendants, archived boxes, and invalid boxes do not match.
Already-done output children are idempotent no-ops.

An otherwise matching output child with an owner aborts the complete operation.
Tent must not silently clear another claim.

## Core API

Completion behavior belongs in core so CLI and Obsidian cannot diverge.

`completeClaim` receives an options object:

```ts
interface CompleteClaimOptions {
  cascadeOutputs?: boolean;
  integrate?: () => Promise<void>;
}
```

`AcceptReportOptions` gains the same `cascadeOutputs?: boolean` switch. Both
paths call one private helper that validates candidates and marks them done.
The default is `true`; callers opt out explicitly with `false`.

`stamp` forwards the option to `completeClaim`. Existing callers that omit
options retain the new default behavior.

## Mutation Order

Within one Tent mutation lock:

1. load and validate the accepted box;
2. collect and prevalidate direct output candidates;
3. integrate workspace commits, when present;
4. mark candidate output records done;
5. mark the accepted box done and clear its direct owner;
6. remove the accepted report, when present.

Git integration therefore happens before any Tent state mutation. Candidate
validation also happens before writes. The filesystem adapter does not provide
multi-file rollback for unexpected I/O failure, so the design avoids
predictable partial writes but does not claim a stronger transaction than the
current adapter can provide.

## Existing Records

Completion remains idempotent. Running `tent stamp <already-done-parent>` again
may be used to complete previously accumulated direct output records. No data
migration command is required.

## CLI

`complete` and `stamp` parse `--no-cascade` as a boolean flag and pass
`cascadeOutputs: false` into core. Help text documents the switch. Success
output does not enumerate child ids; the resulting tree is authoritative.

## UI

The Obsidian report-confirmation path keeps calling `acceptReport` without an
override, so it receives default cascading. No new UI control or modal is
introduced.

## Tests

Core tests cover:

- direct `output` and `output-*` children become done;
- non-output children and nested output descendants remain unchanged;
- already-done records remain done;
- archived and invalid output children are skipped;
- an owned output child rejects the whole operation before writes;
- integration failure leaves parent and output status unchanged.

CLI tests cover default cascade and `--no-cascade` for both `complete` and
`stamp`. Existing report integration tests continue to prove report cleanup and
workspace failure ordering.

## Non-Goals

- recursive descendant completion;
- status inheritance;
- report schema changes or explicit output-id lists;
- migration of arbitrary historical records;
- a new Obsidian confirmation prompt.

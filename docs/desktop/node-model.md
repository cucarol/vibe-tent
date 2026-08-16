# Node model

A Node is durable workspace knowledge, not operational execution state.

## Canonical shape

Each Node has a stable `cx-` id, Markdown body, hierarchy, tags, relations,
mode, and one optional arbitrary `type` string. Type may be omitted or cleared;
unknown and hyphenated values stay exact and do not trigger composite inference.

Graph is the sole identity/title/type/mode projection. Canvas composes Node
facts visually but is not an authority. Task responsibility, Session execution,
TaskResult review, and Inbox actionability come from their own records.

## What belongs in a Node

Promote only facts that remain useful across Tasks or Sessions: durable
decisions, constraints, accepted outcomes, and pointers to real artifacts.
Ordinary host conversation and native sub-collaboration stay in the host
conversation unless the parent explicitly records formal Tent work; they do not
create a Tent entity.

A Task and its TaskResult are already durable work records. After a result is
accepted, an explicit authorized action may update an existing relevant writable
Node or derive an Output Node. If no relevant Node exists, report to the requester;
never create a process-only Node.

An Output Node is still a Node. It may hold the exact accepted `resultId` as
provenance. Artifact references live on TaskResult and are projected through
that result identity rather than copied into Node frontmatter.

## Mutations

Node create/write/move/rename/type/tags/archive/restore/proposal apply are
explicit user-authorized mutations with etag/path checks. Setting type to null
removes the field. Task submit/review never edits a Node. After acceptance,
`task.bindOutput` is the separate explicit provenance action for an existing
Output Node.

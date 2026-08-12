# Desktop Contract · Node Model

This document defines durable Node content and structure. Task occupation and
Delivery review are operational projections described in
[task-api.md](task-api.md); they are not Node frontmatter.

## 1. Node identity and layout

A Node is a folder plus a same-named Markdown identity note:

```text
Release plan/
  Release plan.md
  Child context/
    Child context.md
```

A folder without a same-named note is a transparent group. System folders such
as `temp/` and `attachments/` are excluded from the Node tree.

Minimal frontmatter:

```yaml
---
id: cx-7k2f9q
type: goal
tags: [release]
---
```

`cx-` identity is stable across rename and move. Paths are display and lookup
hints; they are never a second identity. Duplicate ids fail loud.

## 2. Durable fields

Node-owned facts are limited to:

- stable id, name, parent hierarchy, and Markdown body;
- primary type and optional secondary type;
- tags and explicit semantic relations;
- archive mode;
- annotations and attachment references;
- Output provenance fields where applicable.

Execution progress, Task responsibility, reviewer, Session, Delivery status, and generic
workflow state do not belong in Node frontmatter. Desktop derives those from
Task, Session, and Delivery projections.

## 3. Types and tags

Primary type is one of:

```text
goal | prompt | output
```

- `goal` describes a desired result or direction.
- `prompt` stores instructions, questions, context, decisions, or working
  material.
- `output` stores an accepted result or durable pointer to one.

Secondary type is optional and user-extensible. Tags are independent reusable
facets. Neither type nor tag grants read/write authority or encodes progress.

## 4. Body and stable knowledge

The body is durable project knowledge, not a transcript. A Role promotes
confirmed decisions, facts, open questions, provenance, and accepted outcomes
from Task/Delivery evidence into the nearest relevant Node.

Tent never automatically stores an entire ACP conversation in a Node. Delivery
acceptance does not by itself rewrite Node content; the accountable Role or user
performs an explicit etag-checked Node mutation.

## 5. Tree semantics

Parent/child hierarchy expresses context and ownership of knowledge, not lock
inheritance. A Task occupying a parent does not automatically occupy children,
and a child Task does not occupy its ancestors.

Relations and links may extend read context. They do not acquire additional
write occupation unless those Node ids are explicitly included in the Task.

Rename and move use stable ids plus current-path/etag checks. Moving a subtree
updates paths while preserving ids and content. The operation fails if its
source or target impact contains an active Task or if it would create an
invalid cycle.

## 6. Exact Task occupation

Context Card v2 `workNodeIds[]` is the authoritative occupied Node selection;
`contextNodeIds[]` is shared read-only context. Dispatch acquires the full work
set atomically:

- one active Task may occupy an exact Node;
- failure on any requested Node creates no Task, manifest, lane, or partial
  occupation;
- sibling and parent/child Nodes may be worked independently;
- `queued`, `running`, `waiting`, and `delivered` Tasks remain active;
- `accepted`, terminal `rejected`, `interrupted`, and `failed` release
  occupation.

Occupation is derived from Task envelopes. There is no lock table or duplicated
Node owner/status field.

## 7. Archive and delete

`mode: archived` is reversible soft deletion for a Node subtree. Archived Nodes
reject ordinary content and structure writes. Restore re-enables them after
the same structural and occupation checks.

Permanent delete is allowed only for an archived subtree and remains subject to
active Task, path, attachment, and provenance guards. Clients never delete a
Node merely because a Task ended.

## 8. Content mutation

Public Node mutations go through Local Service:

```text
node.list | node.get | node.create | node.write
node.move | node.archive | node.restore
node.tags | node.relations | node.annotations
```

Writes use an etag or equivalent current-revision check. Stale writes fail
loud; Service does not merge two bodies heuristically. Raw document changes
observed by the watcher are reloaded and projected through the same Node
validation rules.

## 9. Collaboration projection

`workspace.collaboration` exposes the user's actionable Inbox with an optional
selected Node collaboration. When no Node is selected, `selectedNode` is null;
the Inbox remains readable. Graph remains the sole source
for Node name, type, mode, and hierarchy. Parent responsibility, Role or
Connection execution, ready Delivery summary, and pending user Decision are
joined from their existing authorities; no collaboration field is copied into
Node files. Session identity/liveness and filesystem Task paths are not product
projection fields.

Protocol 7 removed legacy `node.collaboration(s)` after Desktop batch J consumed
the projection; protocol 8 retains no alias or fallback read surface.

## 10. Events

Document invalidation uses:

```text
node.changed
node.removed
```

Payloads contain stable Node id and safe path/reason metadata.
Consumers re-read the Node or collaboration projection after the event.

## 11. Attachments and Output provenance

Attachments live under `.tent/attachments/` and are addressed by safe relative
references. Imports preserve original bytes and return a Markdown reference;
they do not execute or trust file content.

An Output Node may record accepted Delivery provenance and artifact references.
Provenance points to immutable Task/Delivery/Git evidence. It never substitutes
for Delivery review or makes a Task operational record part of the Node tree.

## 12. Non-goals

The Node model does not provide:

- generic owner or progress fields;
- type-based read/write permissions;
- implicit subtree occupation;
- automatic chat archival;
- a second workspace repository;
- a separate workflow object hidden behind another public name.

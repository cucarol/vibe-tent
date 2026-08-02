# Identity, Rename, And Structural Move

This document defines stable identity and structural mutations for current
public objects. It does not define a migration or alternate lookup grammar.

## 1. Identity map

| Object | Stable identity | Mutable presentation | Path / operational key |
| --- | --- | --- | --- |
| Node | `cx-…` | folder stem and optional title | folder + same-named Markdown note |
| Role | `rl-…` | display name, prompt, description, color | operational Role name |
| Task | `tk-…` | none | Task envelope path |
| Session | `ss-…` | safe runtime projection | machine registry row |
| Delivery | `dl-…` | review note/summary | Delivery record path |
| Settings route | machine `routeId` | display metadata | machine Settings only |

Do not invent ids merely for visual uniformity. A Settings route is machine
configuration, not a collaboration identity or Role.

## 2. Role identity

A Role has an immutable `roleId`, an operational name used by persisted Task
and lane references, and mutable display metadata. Public resolution accepts
the stable id or exact operational name and never resolves by display label.

Changing only display metadata does not rename the Role lane, Task paths, or
historical records. Renaming the operational name would require a separate
atomic contract covering `temp/<role>/`, open Task references, branch/worktree
labels, and cached projections; it is not silently performed by metadata update.

Role metadata does not select providers. Managed execution uses a machine
Settings `routeId` at Task dispatch.

## 3. Node rename

`docs.rename` changes one Node's folder stem while preserving its `cx-` id and
entire subtree.

1. Resolve the source by stable id and require the current path/etag.
2. Reject an existing destination or invalid name.
3. Before mutation, scan the exact source subtree for active direct Task refs.
4. If any active Task directly references a Node inside that subtree, fail with
   no writes. Occupation outside the changed subtree does not block rename.
5. Move the folder and same-named identity note together.
6. Preserve descendant ids, attachments, relations, and id-keyed order facts.
7. Rewrite only links whose target resolves unambiguously to an affected path.
8. Emit one `node.changed` invalidation with stable id, old path, and new
   path.
9. On post-move failure, restore touched notes and the tree from the operation's
   exact snapshot.

There is no force flag that overwrites active work or a second public event
stream.

## 4. Node move and reparent

`docs.move` moves one Node subtree or reorders siblings. The moved Node,
destination parent, and optional sibling are stable ids; `newParentId: null`
means the Node root.

- same-parent reorder changes id-keyed order only;
- reparent moves the folder subtree and rewrites unambiguous path-based links;
- cycles, destination name collisions, archived/invalid targets, system paths,
  and stale expected paths fail before writes;
- a failed post-move rewrite rolls back notes, tree, and order.

### Occupation guard

A Task may reference multiple exact Nodes, but each exact Node may belong to at
most one active Task. Parent, child, and sibling Nodes remain independently
usable.

Move checks only the subtrees that the operation changes:

- any active direct Task ref inside the moved source subtree blocks the move;
- any active direct Task ref inside the destination subtree affected by the
  insertion blocks the move;
- occupation elsewhere, including an ancestor outside those affected
  subtrees, does not block;
- checking parent ancestry is not a substitute for scanning active direct refs
  in the actual impact set.

The same affected-subtree rule applies to rename, archive, restore, and delete.
Facts come from active Task envelopes; Node files never carry duplicated owner
or progress fields.

## 5. Archive and delete

Archive is reversible soft deletion of one Node subtree. Delete is allowed only
for an already archived subtree. Both operations fail atomically when the exact
affected subtree contains an active direct Task ref.

Ending one Task never deletes or archives its Nodes. Terminal Task state only
releases occupation.

## 6. Concurrency and rollback

Structural mutations run through Local Service and the workspace MutationBus.
Each operation re-reads stable identity, expected path/etag, destination, and
active Task refs at its write boundary.

Rollback restores only bytes and paths written by that operation. It never
resets unrelated Git state, overwrites a later valid mutation, or converts a
partial failure into success.

## 7. Required coverage

- rename preserves Node id, children, attachments, order, and valid links;
- same-parent reorder avoids filesystem movement;
- reparent across depth preserves outbound relative links;
- stale path, cycle, collision, invalid/archive, and system-path failures write
  nothing;
- multiple exact Node refs are checked as one active Task;
- parent/child/sibling Tasks can run independently;
- active refs inside the affected source or destination subtree block;
- active refs outside the affected subtree do not block;
- rollback restores the exact pre-operation tree and content;
- one invalidation event is emitted after successful mutation.

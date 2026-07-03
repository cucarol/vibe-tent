# Collapsed Triage Count Design

## Problem

Each tree row currently counts only proposals and ready reports whose target is
that exact box. Collapsing a parent hides child rows and therefore hides their
triage badges as well.

## Behavior

- An expanded row shows only its own triage count.
- A collapsed row shows its own count plus every hidden descendant's count.
- The collapsed badge tooltip says that the total includes child boxes.
- Expanding the row restores per-box badges, avoiding duplicate visible counts.
- Proposal and ready-report semantics remain unchanged.

## Implementation

Add a small pure UI-model helper that receives a box, its collapsed state, and a
direct-count callback. The helper returns the direct count when expanded and a
recursive subtree sum when collapsed. `drawNode` uses that value for the
existing badge; no new state, persistence, or cache is introduced.

## Verification

Unit tests cover expanded, collapsed, nested, and zero-count trees. The plugin
build and full project check must remain green.

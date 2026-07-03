# Upstream Draft: CommonMark Angle-Bracket Link Destinations

Target repository:
[`GoogleCloudPlatform/knowledge-catalog`](https://github.com/GoogleCloudPlatform/knowledge-catalog)

Audited upstream revision: `d44368c15e38e7c92481c5992e4f9b5b421a801d`

## Issue draft

### Title

`okf viewer: support CommonMark angle-bracket link destinations`

### Body

The OKF specification says concepts may use standard Markdown links, including
relative links. CommonMark permits a link destination to be enclosed in angle
brackets; that form is needed when the destination contains spaces:

```markdown
[Space concept](<space concept.md>)
```

The viewer's current link extractor in
`okf/src/reference_agent/viewer/generator.py` uses `_LINK_RE` to capture only a
whitespace-free destination ending in `.md`. As a result, the example above is
rendered as a link by a Markdown renderer but is not emitted as a graph edge.

Suggested behavior:

- recognize bare and angle-bracket internal `.md` destinations;
- remove the surrounding angle brackets before path resolution;
- preserve current handling of relative paths, bundle-root paths, fragments,
  duplicates, and paths escaping the bundle;
- add a viewer regression test using a real filename containing a space.

This surfaced while implementing Tent, an Obsidian-based OKF consumer. Tent
currently carries a local equivalent fix in its vendored JavaScript conformance
oracle.

Related: [PR #125](https://github.com/GoogleCloudPlatform/knowledge-catalog/pull/125)
adds a Python `validate` command, but its documented scope does not include
cross-link parsing.

## Pull-request draft

### Title

`fix(okf): parse angle-bracket Markdown link destinations`

### Summary

- extend the viewer link extractor to recognize `<...>` destinations;
- normalize the captured destination before resolving it;
- cover a relative `.md` target whose filename contains a space.

### Test plan

Add a fixture containing:

```text
source.md -> [Space concept](<space concept.md>)
space concept.md
```

Generate the visualization and assert that the graph contains the directed edge
from `source` to `space concept`. Run the complete OKF test suite with
`pytest`.

### Scope note

This change fixes graph extraction only. It does not broaden the pending
conformance command in PR #125, whose current scope intentionally excludes
cross-link validation.

## Tent-side scan observation

Tent's `temp/` directory is an operational pipeline, not an OKF knowledge
subtree. On the active development Tent, the vendored validator reported 31
warnings when scanning the entire root; 22 came from `temp/`. A mirror excluding
only root `temp/` produced 9 warnings. Tent should therefore filter `temp/` in
its `scripts/okf-check.mjs` wrapper rather than add a Tent-specific exclusion to
the vendored validator.


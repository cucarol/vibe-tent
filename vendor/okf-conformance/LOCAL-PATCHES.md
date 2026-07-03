# Local Patches

This file records intentional differences between Tent's vendored OKF
conformance bundle and its upstream source. Keep each entry until the
equivalent behavior is available upstream and the vendor snapshot has been
refreshed.

## 0116946: CommonMark angle-bracket link destinations

**Status:** active

**Files:**

- `validator/okf-validate.mjs`
- `validator/okf-graph.mjs`

Tent accepts an internal Markdown link such as:

```markdown
[Space concept](<space concept.md>)
```

The angle brackets are part of CommonMark's link-destination syntax and allow
spaces in a destination. The original regular expression captured only a
whitespace-free destination, so it either missed this link or resolved the
literal brackets as part of the filename. Commit `0116946` captures either a
bare destination or an angle-bracket destination, removes the brackets before
resolution, and adds a regression test.

### Source provenance

The conformance subtree entered Tent in release commit `e8fe92d`; that import
did not record an upstream repository and commit. The presumed project,
`GoogleCloudPlatform/knowledge-catalog`, currently has no
`CONFORMANCE.md`, `okf-validate.mjs`, or `okf-graph.mjs` on `main`, and those
paths do not appear in its reachable Git history. Its current implementation is
Python-based. This provenance gap must be resolved before treating a future
vendor refresh as a mechanical upstream sync.

The same parsing limitation does exist in the current upstream Python viewer at
`okf/src/reference_agent/viewer/generator.py`. A proposed issue and pull-request
description live in
`docs/upstream/okf-commonmark-link-destination.md`. Upstream pull request
[#125](https://github.com/GoogleCloudPlatform/knowledge-catalog/pull/125)
adds a Python conformance command, but it does not validate cross-links and is
not the source of these JavaScript files.

### Removal

Remove this entry only after:

1. the JavaScript conformance bundle's actual source provenance is recorded;
2. that source accepts CommonMark angle-bracket destinations with a regression
   test; and
3. Tent refreshes the complete vendor snapshot from that source.


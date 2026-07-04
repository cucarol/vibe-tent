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

Upstream: **WitsCode's OKF Conformance suite** — <https://witscode.com/okf-conformance>.
Licensed MIT, Copyright (c) 2026 WitsCode (see `LICENSE` in this directory).
The `CONFORMANCE.md` / `okf-validate.mjs` / `okf-graph.mjs` bundle here is a
vendored snapshot of that suite.

The snapshot entered Tent in release commit `e8fe92d`, which imported the whole
repository in a single commit and therefore did **not** record an exact upstream
commit or tag. The source project is nonetheless identified: the file voice
(the "two oracles" model, the `okf-validate` / `okf graph` tools, and the
"conformance buys interoperability, not correctness" framing) matches WitsCode's
published suite. A future mechanical refresh still needs an exact upstream
ref pinned from WitsCode; until then treat refreshes as manual re-vendoring.

Note: this bundle is **not** from `GoogleCloudPlatform/knowledge-catalog`. That
project's OKF reference implementation is Python-based and its viewer at
`okf/src/reference_agent/viewer/generator.py` has the same CommonMark
angle-bracket parsing limitation; a proposed upstream fix lives in
`docs/upstream/okf-commonmark-link-destination.md`. Its PR
[#125](https://github.com/GoogleCloudPlatform/knowledge-catalog/pull/125)
adds a Python conformance command but does not validate cross-links and is not
the source of these JavaScript files.

### Removal

Remove this entry only after:

1. an exact upstream ref (commit or tag) is pinned from WitsCode's suite;
2. that source accepts CommonMark angle-bracket destinations with a regression
   test; and
3. Tent refreshes the complete vendor snapshot from that source.


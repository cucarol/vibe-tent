/**
 * Shared ACP final-report contract unit tests (no process spawn).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sealAssistantMessageSegment,
  selectFinalAssistantReport,
} from "../src/adapters/acp/assistant-report.js";

test("selectFinalAssistantReport returns last non-empty segment", () => {
  assert.equal(
    selectFinalAssistantReport([
      "I'll plan first…",
      "FINAL_REPORT",
    ]),
    "FINAL_REPORT"
  );
  assert.equal(
    selectFinalAssistantReport(["only one stream of chunks"]),
    "only one stream of chunks"
  );
  assert.equal(selectFinalAssistantReport(["  mid  ", "  ", "  last  "]), "last");
  assert.equal(selectFinalAssistantReport(["", "   "]), "");
  assert.equal(selectFinalAssistantReport([]), "");
});

test("sealAssistantMessageSegment drops empty buffers and appends non-empty", () => {
  const a = sealAssistantMessageSegment([], "hello");
  assert.deepEqual(a.segments, ["hello"]);
  assert.equal(a.current, "");

  const b = sealAssistantMessageSegment(["hello"], "   ");
  assert.deepEqual(b.segments, ["hello"]);
  assert.equal(b.current, "");

  const c = sealAssistantMessageSegment(["hello"], "world");
  assert.deepEqual(c.segments, ["hello", "world"]);
  assert.equal(c.current, "");
});

test("multi-segment simulation: intermediate + tools + final → last only", () => {
  let segments: string[] = [];
  let current = "";

  // Intermediate narration (contiguous chunks).
  current += "I'll ";
  current += "inspect first…";
  // tool_call seals the open segment.
  ({ segments, current } = sealAssistantMessageSegment(segments, current));
  assert.deepEqual(segments, ["I'll inspect first…"]);
  assert.equal(current, "");

  // Final report after tools (streamed chunks).
  current += "FINAL_";
  current += "RESULT";
  ({ segments, current } = sealAssistantMessageSegment(segments, current));
  assert.equal(current, "");
  assert.equal(selectFinalAssistantReport(segments), "FINAL_DELIVERY");
  assert.doesNotMatch(selectFinalAssistantReport(segments), /inspect/);
});

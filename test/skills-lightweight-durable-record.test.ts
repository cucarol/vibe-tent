import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

test("Role and Task Skills keep the lightweight durable-work contract", async () => {
  const [role, task, taskCli] = await Promise.all([
    source("skills/tent-role/SKILL.md"),
    source("skills/tent-task/SKILL.md"),
    source("skills/tent-task/references/task-cli.md"),
  ]);

  for (const text of [role, task, taskCli]) {
    const normalized = text.replace(/\s+/g, " ");
    assert.match(
      normalized,
      /Task and (?:its )?TaskResult report (?:are|is) the default durable/i
    );
    assert.match(normalized, /across Tasks or Sessions/i);
    assert.match(normalized, /existing relevant writable Node/i);
    assert.match(normalized, /parent or user/i);
    assert.match(normalized, /never create a process-only Node/i);
  }

  for (const text of [task, taskCli]) {
    const normalized = text.replace(/\s+/g, " ");
    assert.match(normalized, /no outcome wrapper/i);
    assert.match(
      normalized,
      /only (?:those two controls|`blocked` and `needs-input`) park/i
    );
    assert.doesNotMatch(normalized, /`outcome: delivered` remains accepted/i);
  }
});

#!/usr/bin/env node

// src/cli/seed.ts
import * as fs2 from "node:fs/promises";
import * as path from "node:path";

// src/fs/node-fs.ts
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
var NodeFs = class {
  constructor(root) {
    this.root = root;
  }
  abs(p) {
    return nodePath.join(this.root, p);
  }
  async listDir(dir) {
    const entries = await fs.readdir(this.abs(dir), { withFileTypes: true });
    return entries.filter((e) => !e.name.startsWith(".git")).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  }
  async readFile(path2) {
    return fs.readFile(this.abs(path2), "utf8");
  }
  async writeFile(path2, content) {
    await fs.mkdir(nodePath.dirname(this.abs(path2)), { recursive: true });
    await fs.writeFile(this.abs(path2), content, "utf8");
  }
  async exists(path2) {
    try {
      await fs.access(this.abs(path2));
      return true;
    } catch {
      return false;
    }
  }
  async mkdir(path2) {
    await fs.mkdir(this.abs(path2), { recursive: true });
  }
  async move(from, to) {
    await fs.mkdir(nodePath.dirname(this.abs(to)), { recursive: true });
    await fs.rename(this.abs(from), this.abs(to));
  }
  async remove(path2) {
    await fs.rm(this.abs(path2), { recursive: true, force: true });
  }
  async withLock(path2, action) {
    const lockPath = this.abs(path2);
    await fs.mkdir(nodePath.dirname(lockPath), { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        handle = await fs.open(lockPath, "wx");
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const stale = await isStaleLock(lockPath);
        if (!stale || attempt > 0) throw new Error("Tent \u6B63\u5728\u6267\u884C\u53E6\u4E00\u4E2A\u5199\u64CD\u4F5C,\u8BF7\u7A0D\u540E\u91CD\u8BD5");
        await fs.rm(lockPath, { force: true });
      }
    }
    if (!handle) throw new Error("\u65E0\u6CD5\u83B7\u53D6 Tent mutation lock");
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: (/* @__PURE__ */ new Date()).toISOString() }), "utf8");
      return await action();
    } finally {
      await handle.close();
      await fs.rm(lockPath, { force: true });
    }
  }
};
function isAlreadyExists(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
async function isStaleLock(path2) {
  try {
    const stat2 = await fs.stat(path2);
    return Date.now() - stat2.mtimeMs > 12e4;
  } catch {
    return true;
  }
}

// src/core/frontmatter.ts
var FENCE = "---";
var BOX_FRONTMATTER_KEY_ORDER = ["id", "type", "tags"];
function serializeFrontmatter(data, body, keyOrder = []) {
  const keys = orderedKeys(data, keyOrder);
  const lines = [FENCE];
  for (const k of keys) {
    const val = data[k];
    if (val === void 0) continue;
    lines.push(`${k}: ${emit(val)}`);
  }
  lines.push(FENCE);
  const out = lines.join("\n");
  return body ? out + "\n" + body : out + "\n";
}
function orderedKeys(data, keyOrder) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const k of keyOrder) {
    if (k in data && !seen.has(k)) {
      result.push(k);
      seen.add(k);
    }
  }
  for (const k of Object.keys(data)) {
    if (!seen.has(k)) {
      result.push(k);
      seen.add(k);
    }
  }
  return result;
}
function emit(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return "[" + v.map((item) => emit(item)).join(", ") + "]";
  }
  const s = String(v);
  if (/[:,#\[\]]/.test(s) || s !== s.trim() || s === "") return JSON.stringify(s);
  return s;
}

// src/core/typeRegistry.ts
var TYPE_REGISTRY_PATH = ".tent/types.json";
var DEFAULT_TYPE_REGISTRY = {
  goal: {
    readable: true,
    writable: false,
    color: "blue",
    tier: "base",
    description: "\u5B9A\u4E49\u76EE\u6807\u3001\u610F\u56FE\u4E0E\u9A8C\u6536\u65B9\u5411"
  },
  prompt: {
    readable: true,
    writable: true,
    color: "purple",
    tier: "base",
    description: "\u63D0\u4F9B\u4EFB\u52A1\u8BF4\u660E\u4E0E\u5DE5\u4F5C\u4E0A\u4E0B\u6587"
  },
  output: {
    readable: true,
    writable: true,
    color: "cyan",
    tier: "base",
    description: "\u6620\u5C04\u771F\u5B9E\u4EA4\u4ED8\u7269\u4E0E workspace"
  },
  open: {
    readable: true,
    writable: true,
    color: "green",
    tier: "modifier",
    description: "\u4ECD\u5728\u63A8\u8FDB\u3001\u53EF\u7EE7\u7EED\u5904\u7406"
  },
  reference: {
    readable: true,
    color: "blue",
    tier: "modifier",
    description: "\u4F5C\u4E3A\u80CC\u666F\u8D44\u6599\u4F9B\u67E5\u9605\u4E0E\u5F15\u7528"
  },
  asset: {
    writable: true,
    color: "purple",
    tier: "modifier",
    description: "\u4F5C\u4E3A\u5B9E\u9645\u4EA7\u7269\u6216\u53EF\u590D\u7528\u8D44\u6E90"
  },
  sealed: {
    readable: false,
    writable: false,
    color: "red",
    tier: "modifier",
    description: "\u5DF2\u5C01\u5B58\uFF0C\u4E0D\u518D\u53C2\u4E0E\u540E\u7EED\u5904\u7406"
  }
};

// src/core/skillRoleRegistry.ts
var ROLES_REGISTRY_PATH = ".tent/roles.json";

// src/core/tree.ts
function boxNotePath(boxPath) {
  return join2(boxPath, baseName(boxPath) + ".md");
}
function join2(...parts) {
  return parts.filter((p) => p !== "").join("/");
}
function baseName(path2) {
  const i = path2.lastIndexOf("/");
  return i === -1 ? path2 : path2.slice(i + 1);
}

// src/core/tags.ts
var TAGS_REGISTRY_PATH = ".tent/tags.json";

// src/core/id.ts
var ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function makeBoxId(rand = Math.random, len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return "bx-" + s;
}
function makeUniqueBoxId(existing, rand = Math.random) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = makeBoxId(rand);
    if (!existing.has(id)) return id;
  }
  return makeBoxId(rand, 10);
}

// src/core/scaffold.ts
async function scaffoldTent(fs3, options) {
  const name = options.name.trim();
  if (!name) throw new Error("\u5E10\u540D\u4E0D\u80FD\u4E3A\u7A7A");
  if (!options.rules.trim()) throw new Error("RULES.md \u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A");
  const usedIds = /* @__PURE__ */ new Set();
  for (const box of options.boxes ?? []) {
    const boxName = box.name.trim();
    if (!boxName || boxName.includes("/") || boxName.includes("\\")) {
      throw new Error(`\u65E0\u6548\u6846\u540D: ${box.name}`);
    }
    const type = box.kind?.trim() || box.type.trim();
    if (!type) throw new Error(`\u6846\u300C${boxName}\u300D\u7F3A\u4E00\u7EA7 type`);
    const id = box.id?.trim() || makeUniqueBoxId(usedIds);
    usedIds.add(id);
    const frontmatter = { id, type };
    await writeBox(fs3, boxName, frontmatter, box.body ?? `# ${boxName}
`);
  }
  await fs3.mkdir("temp");
  await fs3.mkdir(".tent");
  await fs3.writeFile(TYPE_REGISTRY_PATH, JSON.stringify(options.typeRegistry ?? DEFAULT_TYPE_REGISTRY, null, 2) + "\n");
  await fs3.writeFile(ROLES_REGISTRY_PATH, JSON.stringify(options.rolesRegistry ?? { roles: [] }, null, 2) + "\n");
  await fs3.writeFile(TAGS_REGISTRY_PATH, JSON.stringify({ tags: [] }, null, 2) + "\n");
  await fs3.writeFile("RULES.md", options.rules);
}
async function writeBox(fs3, path2, frontmatter, body) {
  await fs3.mkdir(path2);
  await fs3.writeFile(boxNotePath(path2), serializeFrontmatter(frontmatter, `
${body}
`, BOX_FRONTMATTER_KEY_ORDER));
}

// src/cli/seed.ts
var target = process.argv[2];
if (!target) {
  console.error("\u7528\u6CD5: tent-seed <\u76EE\u6807\u5E10\u8DEF\u5F84>");
  process.exit(1);
}
async function main() {
  const tentFs = new NodeFs(target);
  await fs2.mkdir(target, { recursive: true });
  const tentName = path.basename(path.resolve(target));
  const rules = `# ${tentName} \xB7 \u9879\u76EE\u7EA6\u5B9A

> \u8FD9\u9876\u5E10\u7684\u672C\u5730\u89C4\u77E9(global rule):\u968F\u4FBF\u6539\u3002
> \u673A\u5236\u89C4\u8303\u4E0D\u5728\u8FD9(\u89C1 Tent \u4ED3\u5E93 docs/SPEC.md);agent \u7684\u64CD\u4F5C\u534F\u8BAE\u5728 tent-role skill\u3002

- \u4EA7\u51FA workspace:<\u586B\u771F\u5B9E\u4EE3\u7801\u4ED3\u8DEF\u5F84>
- \u63D0\u4EA4 / \u547D\u540D\u7EA6\u5B9A:<\u586B>
`;
  await scaffoldTent(tentFs, {
    name: tentName,
    rules,
    boxes: [
      { name: "goal", type: "goal", id: "bx-goalz", body: `# ${tentName} \xB7 goal

user \u610F\u5FD7\u4E0E\u76EE\u6807\u3002` },
      { name: "prompt", type: "prompt", id: "bx-promptz", body: `# ${tentName} \xB7 prompt

\u7ED9 agent \u7684\u4EFB\u52A1\u8BF4\u660E\u4E0E\u4E0A\u4E0B\u6587\u3002` },
      { name: "output", type: "output", id: "bx-outz", body: `# ${tentName} \xB7 output

\u771F\u5B9E\u4EA7\u51FA\u4E0E\u4EE3\u7801 workspace \u7684\u6307\u9488\u3002` }
    ]
  });
  await addDemoContent(target);
  console.log("\u2713 \u6F14\u793A\u5E10\u5DF2\u751F\u6210:", target);
}
async function addDemoContent(root) {
  const box = async (relativePath, frontmatter, body = "") => {
    const dir = path.join(root, relativePath);
    await fs2.mkdir(dir, { recursive: true });
    const folderName = path.basename(dir);
    await fs2.writeFile(path.join(dir, `${folderName}.md`), `---
${frontmatter}
---

${body}
`, "utf8");
  };
  const file = async (relativePath, content) => {
    const targetPath = path.join(root, relativePath);
    await fs2.mkdir(path.dirname(targetPath), { recursive: true });
    await fs2.writeFile(targetPath, content, "utf8");
  };
  await box(
    "goal/\u6316\u4E00\u4E2A\u65B0alpha",
    "id: bx-g1\ntype: goal\nstatus: doing",
    "# \u6316\u4E00\u4E2A\u65B0\u4FE1\u53F7\n\n\u5728\u76EE\u6807\u7814\u7A76\u5E73\u53F0\u4E0A\u627E\u4E00\u4E2A\u80FD\u901A\u8FC7\u9A8C\u6536\u7684\u65B0\u4FE1\u53F7\u8868\u8FBE\u5F0F\u3002"
  );
  await box(
    "goal/\u6316\u4E00\u4E2A\u65B0alpha/\u627E\u6570\u636E\u5B57\u6BB5",
    "id: bx-g1a\ntype: goal\nstatus: done",
    "# \u627E\u6570\u636E\u5B57\u6BB5\n\n\u9009\u5B9A\u4E00\u7EC4\u6709\u4FE1\u53F7\u7684 datafields\u3002"
  );
  await box(
    "goal/\u6316\u4E00\u4E2A\u65B0alpha/\u5199\u8868\u8FBE\u5F0F",
    "id: bx-g1b\ntype: goal\nstatus: doing\nowner: executor",
    "# \u5199\u8868\u8FBE\u5F0F\n\n\u57FA\u4E8E\u9009\u5B9A\u5B57\u6BB5\u5199 alpha \u8868\u8FBE\u5F0F,\u8DD1\u6A21\u62DF\u3002"
  );
  await box(
    "goal/\u6316\u4E00\u4E2A\u65B0alpha/\u8FC7\u76F8\u5173\u6027\u68C0\u67E5",
    "id: bx-g1c\ntype: goal\nstatus: todo",
    "# \u8FC7\u76F8\u5173\u6027\u68C0\u67E5\n\n\u786E\u4FDD\u4E0E\u5DF2\u6709 alpha \u4F4E\u76F8\u5173,\u53EF\u63D0\u4EA4\u3002"
  );
  await box(
    "prompt/\u8868\u8FBE\u5F0F\u4EFB\u52A1\u4E66",
    "id: bx-p1\ntype: prompt",
    "# \u8868\u8FBE\u5F0F\u4EFB\u52A1\u4E66\n\n\u7528 rank/zscore \u7EC4\u5408\u9009\u5B9A\u5B57\u6BB5,\u76EE\u6807 Sharpe > 1.25,fitness > 1\u3002\u5148\u5C0F\u6279\u91CF\u8BD5,\u518D\u6269\u3002"
  );
  await box(
    "prompt/\u8868\u8FBE\u5F0F\u4EFB\u52A1\u4E66/\u8349\u7A3F",
    "id: bx-p1d\ntype: prompt\nwritable: true",
    "# \u8349\u7A3F\n\n(agent \u53EF\u5199\u7684\u8868\u8FBE\u5F0F\u8349\u7A3F\u533A)"
  );
  await box(
    "prompt/\u5B57\u6BB5\u8C03\u7814\u4EFB\u52A1\u4E66",
    "id: bx-p2\ntype: prompt",
    "# \u5B57\u6BB5\u8C03\u7814\u4EFB\u52A1\u4E66\n\n\u5728 fundamental \u6570\u636E\u96C6\u91CC\u7B5B\u51FA\u8986\u76D6\u7387 > 0.8 \u7684\u5B57\u6BB5\u3002"
  );
  await box(
    "prompt/\u53C2\u8003-\u65E7alpha\u6E05\u5355",
    "id: bx-a1\ntype: asset",
    "# \u65E7 alpha \u6E05\u5355\n\n(\u53C2\u7167\u8D44\u6599,\u9ED8\u8BA4\u4E0D\u53EF\u8BFB\u3002\u60F3\u8BFB\u8D70 proposal \u7FFB\u53EF\u8BFB\u3002)"
  );
  await box(
    "output/alpha\u4ED3\u5E93\u6307\u9488",
    "id: bx-o1\ntype: output",
    "# \u4EE3\u7801\u4ED3\u5E93\u6307\u9488\n\nworkspace: C:/path/to/alpha-workspace\nref: a1b2c3d\n\n\u771F\u5B9E\u4EE3\u7801\u4F4D\u4E8E\u9879\u76EE workspace\u3002\u672C\u6846\u53EA\u8BB0\u5F55\u6307\u9488,\u4EA7\u51FA\u5E94\u4FDD\u7559\u5728\u4EE3\u7801\u4ED3\u5E93\u7684 git \u5386\u53F2\u4E2D\u3002"
  );
  await file(
    "temp/planner/proposals/giscus.md",
    `---
type: proposal
target: bx-g1c
status: open
from: planner
---

## \u4E3A\u4EC0\u4E48

\u76F8\u5173\u6027\u68C0\u67E5\u8FD9\u4E00\u679D\u53EF\u4EE5\u66F4\u65E9\u505A,\u5EFA\u8BAE\u63D0\u524D\u5230\u5199\u8868\u8FBE\u5F0F\u4E4B\u524D\u5E76\u884C\u3002

## \u5177\u4F53\u6539\u52A8

\u628A\u300C\u8FC7\u76F8\u5173\u6027\u68C0\u67E5\u300D\u4ECE todo \u63D0\u5230 doing,\u548C\u300C\u5199\u8868\u8FBE\u5F0F\u300D\u5E76\u5217\u63A8\u8FDB\u3002
`
  );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

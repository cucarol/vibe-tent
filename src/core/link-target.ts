// Shared path-target normalization for Node links / rename rewrite.
// Lives in Core so renameOps does not import markdown (keeps build:core rootDir closed).

/** Decode %XX sequences when well-formed; leave raw on failure. */
function safePercentDecode(value: string): string {
  try {
    if (!/%[0-9A-Fa-f]{2}/.test(value)) return value;
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Normalize a link destination for Node resolution / path rewrite.
 * Strips angle brackets, query/fragment, optional `.md`, and resolves `./` `../`
 * against the authoring note path when present.
 */
export function normalizeTarget(raw: string, fromNotePath?: string): string {
  let t = raw.trim().replace(/\\/g, "/");
  if (t.startsWith("<") && t.endsWith(">")) t = t.slice(1, -1).trim();
  t = safePercentDecode(t);
  t = (t.split("#")[0]?.split("?")[0] ?? t).trim();

  if ((t.startsWith("./") || t.startsWith("../")) && fromNotePath) {
    const base = fromNotePath.replace(/\\/g, "/").split("/").slice(0, -1);
    for (const part of t.split("/")) {
      if (part === "." || part === "") continue;
      if (part === "..") base.pop();
      else base.push(part);
    }
    t = base.join("/");
  }
  return t.replace(/\.md$/i, "");
}

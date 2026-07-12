// Minimal optimistic concurrency token for docs.readForEdit / docs.write.

import { createHash } from "node:crypto";

export function contentEtag(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 24);
}

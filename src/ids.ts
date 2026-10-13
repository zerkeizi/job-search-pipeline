import { createHash } from "node:crypto";

/** Stable short id from the given parts. */
export function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 12);
}

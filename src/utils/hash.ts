import { createHash } from "node:crypto";

export function sha1(input: string | Buffer): string {
  return createHash("sha1").update(input).digest("hex");
}

export function shortHash(input: string | Buffer): string {
  return sha1(input).slice(0, 12);
}

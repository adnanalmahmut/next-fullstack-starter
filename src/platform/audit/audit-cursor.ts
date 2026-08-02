import * as z from "zod";

import { ValidationError } from "@/shared/errors/application-error";

import { isCanonicalUuid } from "./audit-identifier";

/**
 * The position a page of audit records resumes from.
 *
 * Keyset, not offset. An audit trail is append-only and is read newest first, so
 * an offset page is wrong by construction: rows arrive at the head while a
 * reader is paging, every subsequent offset shifts, and the reader sees a record
 * twice or not at all. A cursor names the last row that was actually returned,
 * so the next page starts exactly after it no matter how many rows arrived in
 * between.
 *
 * It carries a timestamp and an identifier and nothing else. Both are already in
 * the row the reader was just shown, so the cursor discloses nothing new — no
 * filter, no actor, no permission, no offset a caller could inflate into an
 * unbounded scan.
 *
 * The encoding is opaque but not secret: it is base64url of a small JSON object.
 * Opaque because the shape is this platform's to change, and a client that
 * learned to build one would be depending on an internal detail. Not secret
 * because it protects nothing — every value in it was in the previous response.
 */
export type AuditCursor = Readonly<{
  occurredAt: Date;
  id: string;
}>;

/**
 * A generous ceiling for a value that is normally about 100 characters.
 *
 * The point is not to guess the exact length; it is that an attacker cannot make
 * the process decode a megabyte of base64 before the validation runs.
 */
export const MAX_AUDIT_CURSOR_LENGTH = 256;

const cursorPayloadSchema = z
  .object({
    occurredAt: z.iso.datetime(),
    id: z.string().refine(isCanonicalUuid),
  })
  .strict();

export function encodeAuditCursor(cursor: AuditCursor): string {
  const payload = JSON.stringify({
    occurredAt: cursor.occurredAt.toISOString(),
    id: cursor.id,
  });

  return Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Reads a cursor a client sent back.
 *
 * Everything about the value is client-controlled, so every step can fail and
 * every failure is the same answer: a validation error naming nothing. A
 * malformed cursor is not an interesting event and must not become a stack
 * trace, a JSON parse error, or an `Invalid Date` that silently pages from the
 * beginning of time.
 */
export function decodeAuditCursor(value: unknown): AuditCursor {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_AUDIT_CURSOR_LENGTH
  ) {
    throw new ValidationError("The audit cursor is not acceptable.");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new ValidationError("The audit cursor is not acceptable.");
  }

  const result = cursorPayloadSchema.safeParse(parsed);

  if (!result.success) {
    throw new ValidationError("The audit cursor is not acceptable.");
  }

  const occurredAt = new Date(result.data.occurredAt);

  if (Number.isNaN(occurredAt.getTime())) {
    throw new ValidationError("The audit cursor is not acceptable.");
  }

  return { occurredAt, id: result.data.id };
}

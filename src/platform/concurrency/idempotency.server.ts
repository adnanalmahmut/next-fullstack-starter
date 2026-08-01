import "server-only";

import { randomBytes } from "node:crypto";

import type * as z from "zod";

import {
  CONTROL_MODULE,
  CONTROL_OUTCOME,
  toControlLogFields,
  type ControlOutcome,
} from "@/platform/observability/control-log-fields";
import { getRequestLogger } from "@/platform/observability/logger.server";
import {
  buildRedisKey,
  getRedisKeyScope,
  isValidRedisKeySegment,
  opaqueKeySegment,
  REDIS_NAMESPACE,
} from "@/platform/redis/index.server";

import { CONCURRENCY_LOG_EVENT, CONCURRENCY_OPERATION } from "./log-event";
import {
  accessRedis,
  REDIS_ACCESS_STATUS,
  runRedisScript,
} from "./redis-access.server";

/**
 * Redis-backed idempotency, as a lifecycle rather than a lookup.
 *
 * A lookup that is separate from its completion is the classic way to build an
 * idempotency store that does not work: the first request checks, finds nothing,
 * runs, and only then records — leaving a window in which a retry finds nothing
 * either and runs the operation a second time. So the reservation and the
 * completion are one lifecycle here. `begin` claims the key *before* the use
 * case runs, `complete` publishes the result, and `abort` releases the claim
 * when the use case failed before committing.
 *
 * The limits of this are worth stating plainly, because getting them wrong is
 * expensive:
 *
 * **This is not atomic with a PostgreSQL mutation.** Redis and PostgreSQL are
 * two systems and there is no transaction across them. A crash between the
 * database commit and `complete` leaves a record in `processing` until its TTL
 * expires; a retry within that window is refused with a conflict, and a retry
 * after it runs the operation again. For a financial or otherwise
 * non-repeatable operation the idempotency record belongs in PostgreSQL, inside
 * the same transaction as the mutation, where the two either both happen or
 * neither does. This module is for making an HTTP retry cheap and safe for
 * operations that can tolerate that window — not for guaranteeing exactly-once.
 */

/**
 * Claims the key, or reports what already holds it.
 *
 * `SET NX PX` is the whole of the mutual exclusion: exactly one concurrent
 * caller can create the key, and every other one falls through to read what the
 * winner wrote. Doing the read in the same script means a caller can never
 * observe the gap between "the claim failed" and "here is why".
 */
const BEGIN_SCRIPT = `
local claimed = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', tonumber(ARGV[2]))
if claimed then
  return {'acquired'}
end
return {'existing', redis.call('GET', KEYS[1])}
`;

/**
 * Publishes the result, but only for the caller that made the claim.
 *
 * The owner token check is what stops a slow request from overwriting the record
 * of the request that replaced it after its lease expired. Without it, a request
 * that stalled past the processing TTL could return at any moment and publish a
 * stale result over a newer one.
 *
 * `pcall` around the decode means a corrupt record is refused rather than
 * throwing a Lua error: an unreadable record cannot prove ownership, so the
 * completion is simply not the owner's to make.
 */
const COMPLETE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 'missing'
end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or record.owner ~= ARGV[1] then
  return 'lost'
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
return 'completed'
`;

/**
 * Releases the claim after a failure, again only for its owner.
 *
 * The record is removed rather than marked failed. A failed attempt left behind
 * would refuse the retry it exists to enable, and the caller already received a
 * failure it can act on.
 */
const ABORT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 'missing'
end
local ok, record = pcall(cjson.decode, raw)
if not ok or type(record) ~= 'table' or record.owner ~= ARGV[1] then
  return 'lost'
end
redis.call('UNLINK', KEYS[1])
return 'aborted'
`;

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * The characters an `Idempotency-Key` may contain.
 *
 * Deliberately narrow. The value is client-supplied, it is hashed rather than
 * stored, and nothing is gained by accepting shapes that only make a malformed
 * header harder to notice.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

export const MIN_IDEMPOTENCY_PROCESSING_TTL_MS = 1_000;
export const MAX_IDEMPOTENCY_PROCESSING_TTL_MS = 10 * 60 * 1_000;
export const DEFAULT_IDEMPOTENCY_PROCESSING_TTL_MS = 60_000;

export const MIN_IDEMPOTENCY_COMPLETED_TTL_MS = 1_000;
export const MAX_IDEMPOTENCY_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_IDEMPOTENCY_COMPLETED_TTL_MS = 24 * 60 * 60 * 1_000;

/** A stored result larger than this is not worth replaying; the record is not written. */
export const MAX_IDEMPOTENCY_PAYLOAD_BYTES = 128 * 1024;

const RECORD_VERSION = 1;

const OWNER_TOKEN_BYTES = 16;

export const IDEMPOTENCY_STATE = {
  PROCESSING: "processing",
  COMPLETED: "completed",
} as const;

export type IdempotencyState =
  (typeof IDEMPOTENCY_STATE)[keyof typeof IDEMPOTENCY_STATE];

/**
 * What identifies one idempotent attempt.
 *
 * The scope is deliberately narrow. The same key from the same caller on a
 * different route is a different operation, and the same key from a different
 * caller must never reach another caller's stored result — replaying a response
 * across actors would be a data leak, not a convenience.
 */
export type IdempotencyScope = Readonly<{
  routeName: string;
  /** The API version, so a v2 retry never replays a v1 result. */
  apiVersion: string;
  /** The authorized actor's id, or an explicit subject for a public route. */
  subject: string;
  /** The client's `Idempotency-Key`, raw. Hashed before it becomes a key. */
  idempotencyKey: string;
}>;

export const IDEMPOTENCY_BEGIN_STATUS = {
  ACQUIRED: "acquired",
  REPLAY: "replay",
  CONFLICT: "conflict",
  DISABLED: "disabled",
  UNAVAILABLE: "unavailable",
} as const;

export type IdempotencyBeginStatus =
  (typeof IDEMPOTENCY_BEGIN_STATUS)[keyof typeof IDEMPOTENCY_BEGIN_STATUS];

/** The claim a successful `begin` hands back, and `complete`/`abort` require. */
export type IdempotencyHandle = Readonly<{
  key: string;
  owner: string;
  completedTtlMs: number;
}>;

export type IdempotencyBeginResult<TOutput> =
  | Readonly<{
      status: typeof IDEMPOTENCY_BEGIN_STATUS.ACQUIRED;
      handle: IdempotencyHandle;
    }>
  | Readonly<{
      status: typeof IDEMPOTENCY_BEGIN_STATUS.REPLAY;
      output: TOutput;
    }>
  | Readonly<{ status: typeof IDEMPOTENCY_BEGIN_STATUS.CONFLICT }>
  | Readonly<{ status: typeof IDEMPOTENCY_BEGIN_STATUS.DISABLED }>
  | Readonly<{ status: typeof IDEMPOTENCY_BEGIN_STATUS.UNAVAILABLE }>;

export const IDEMPOTENCY_SETTLE_STATUS = {
  SETTLED: "settled",
  /** The claim was gone or belonged to someone else. Nothing was written. */
  LOST: "lost",
  UNAVAILABLE: "unavailable",
} as const;

export type IdempotencySettleStatus =
  (typeof IDEMPOTENCY_SETTLE_STATUS)[keyof typeof IDEMPOTENCY_SETTLE_STATUS];

export type IdempotencyBeginOptions = Readonly<{
  scope: IdempotencyScope;
  /**
   * A digest of the request this attempt represents.
   *
   * The same key with a different fingerprint is a conflict, not a replay: it
   * means the client reused a key for a different request, and answering with
   * the first request's result would be answering a question nobody asked.
   */
  fingerprint: string;
  processingTtlMs?: number;
  completedTtlMs?: number;
}>;

type StoredRecord = Readonly<{
  v: number;
  state: IdempotencyState;
  fingerprint: string;
  owner?: string;
  output?: unknown;
}>;

export function isValidIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_IDEMPOTENCY_KEY_LENGTH &&
    value.length <= MAX_IDEMPOTENCY_KEY_LENGTH &&
    IDEMPOTENCY_KEY_PATTERN.test(value)
  );
}

function assertScope(scope: IdempotencyScope): void {
  if (
    !isValidRedisKeySegment(scope.routeName) ||
    !isValidRedisKeySegment(scope.apiVersion)
  ) {
    throw new Error("The idempotency scope is not acceptable.");
  }

  if (typeof scope.subject !== "string" || scope.subject.length === 0) {
    throw new Error("The idempotency subject is not acceptable.");
  }

  if (!isValidIdempotencyKey(scope.idempotencyKey)) {
    throw new Error("The idempotency key is not acceptable.");
  }
}

function assertTtl(value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error("The idempotency TTL is not acceptable.");
  }
}

/** The key one attempt occupies. Every part that could identify a person is hashed. */
export function idempotencyKeyFor(scope: IdempotencyScope): string {
  return buildRedisKey(
    getRedisKeyScope(),
    REDIS_NAMESPACE.IDEMPOTENCY,
    scope.apiVersion,
    scope.routeName,
    opaqueKeySegment(scope.subject),
    opaqueKeySegment(scope.idempotencyKey),
  );
}

/**
 * A deterministic digest of what the caller asked for.
 *
 * Built from the validated input rather than the raw body: two byte-different
 * bodies that parse to the same request are the same request, and a caller
 * should not be refused for reformatting its JSON. The digest is never logged
 * and never stored in readable form.
 */
export function idempotencyFingerprint(input: {
  method: string;
  routeName: string;
  params?: unknown;
  query?: unknown;
  body?: unknown;
  actorId?: string | null;
}): string {
  // A fixed key order, so the digest depends on the values and not on the order
  // the object happened to be built in.
  const canonical = JSON.stringify([
    input.method,
    input.routeName,
    input.params ?? null,
    input.query ?? null,
    input.body ?? null,
    input.actorId ?? null,
  ]);

  return opaqueKeySegment(canonical);
}

function log(event: string, outcome?: ControlOutcome): void {
  const fields = toControlLogFields({
    module: CONTROL_MODULE.CONCURRENCY,
    operation: CONCURRENCY_OPERATION.IDEMPOTENCY,
    ...(outcome === undefined ? {} : { outcome }),
  });

  if (event === CONCURRENCY_LOG_EVENT.IDEMPOTENCY_UNAVAILABLE) {
    getRequestLogger().warn(fields, event);

    return;
  }

  getRequestLogger().debug(fields, event);
}

function decodeRecord(raw: unknown): StoredRecord | null {
  if (typeof raw !== "string") {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as StoredRecord;

  if (
    record.v !== RECORD_VERSION ||
    typeof record.fingerprint !== "string" ||
    (record.state !== IDEMPOTENCY_STATE.PROCESSING &&
      record.state !== IDEMPOTENCY_STATE.COMPLETED)
  ) {
    return null;
  }

  return record;
}

/**
 * Claims the key for this attempt.
 *
 * Every answer other than `acquired` means the use case must not run. A
 * `conflict` covers three distinct situations that all have the same correct
 * response — an attempt still in flight, a completed attempt for a different
 * request, and a record too damaged to interpret — because in all three the
 * server cannot honestly produce the result the client asked for.
 */
export async function beginIdempotency<TOutput>(
  options: IdempotencyBeginOptions & {
    /** Validates a stored result before it is replayed as this route's output. */
    outputSchema: z.ZodType<TOutput>;
  },
): Promise<IdempotencyBeginResult<TOutput>> {
  const processingTtlMs =
    options.processingTtlMs ?? DEFAULT_IDEMPOTENCY_PROCESSING_TTL_MS;
  const completedTtlMs =
    options.completedTtlMs ?? DEFAULT_IDEMPOTENCY_COMPLETED_TTL_MS;

  assertScope(options.scope);
  assertTtl(
    processingTtlMs,
    MIN_IDEMPOTENCY_PROCESSING_TTL_MS,
    MAX_IDEMPOTENCY_PROCESSING_TTL_MS,
  );
  assertTtl(
    completedTtlMs,
    MIN_IDEMPOTENCY_COMPLETED_TTL_MS,
    MAX_IDEMPOTENCY_COMPLETED_TTL_MS,
  );

  if (
    typeof options.fingerprint !== "string" ||
    options.fingerprint.length === 0
  ) {
    throw new Error("The idempotency fingerprint is not acceptable.");
  }

  const access = await accessRedis();

  if (access.status === REDIS_ACCESS_STATUS.DISABLED) {
    log(
      CONCURRENCY_LOG_EVENT.IDEMPOTENCY_UNAVAILABLE,
      CONTROL_OUTCOME.DISABLED,
    );

    return { status: IDEMPOTENCY_BEGIN_STATUS.DISABLED };
  }

  if (access.status === REDIS_ACCESS_STATUS.UNAVAILABLE) {
    log(
      CONCURRENCY_LOG_EVENT.IDEMPOTENCY_UNAVAILABLE,
      CONTROL_OUTCOME.UNAVAILABLE,
    );

    return { status: IDEMPOTENCY_BEGIN_STATUS.UNAVAILABLE };
  }

  const key = idempotencyKeyFor(options.scope);
  const owner = randomBytes(OWNER_TOKEN_BYTES).toString("hex");

  const claim: StoredRecord = {
    v: RECORD_VERSION,
    state: IDEMPOTENCY_STATE.PROCESSING,
    fingerprint: options.fingerprint,
    owner,
  };

  let reply: unknown;

  try {
    reply = await runRedisScript(
      access.client,
      BEGIN_SCRIPT,
      [key],
      [JSON.stringify(claim), String(processingTtlMs)],
    );
  } catch {
    log(
      CONCURRENCY_LOG_EVENT.IDEMPOTENCY_UNAVAILABLE,
      CONTROL_OUTCOME.UNAVAILABLE,
    );

    return { status: IDEMPOTENCY_BEGIN_STATUS.UNAVAILABLE };
  }

  if (!Array.isArray(reply) || reply.length === 0) {
    log(
      CONCURRENCY_LOG_EVENT.IDEMPOTENCY_UNAVAILABLE,
      CONTROL_OUTCOME.UNAVAILABLE,
    );

    return { status: IDEMPOTENCY_BEGIN_STATUS.UNAVAILABLE };
  }

  if (reply[0] === "acquired") {
    log(CONCURRENCY_LOG_EVENT.IDEMPOTENCY_ACQUIRED);

    return {
      status: IDEMPOTENCY_BEGIN_STATUS.ACQUIRED,
      handle: { key, owner, completedTtlMs },
    };
  }

  const existing = decodeRecord(reply[1]);

  if (!existing || existing.fingerprint !== options.fingerprint) {
    log(CONCURRENCY_LOG_EVENT.IDEMPOTENCY_CONFLICT);

    return { status: IDEMPOTENCY_BEGIN_STATUS.CONFLICT };
  }

  if (existing.state === IDEMPOTENCY_STATE.PROCESSING) {
    log(CONCURRENCY_LOG_EVENT.IDEMPOTENCY_CONFLICT);

    return { status: IDEMPOTENCY_BEGIN_STATUS.CONFLICT };
  }

  const output = options.outputSchema.safeParse(existing.output);

  if (!output.success) {
    // The stored shape no longer satisfies this deploy's contract. Replaying it
    // would hand the client a value the route promises it will never return.
    log(CONCURRENCY_LOG_EVENT.IDEMPOTENCY_CONFLICT, CONTROL_OUTCOME.CORRUPT);

    return { status: IDEMPOTENCY_BEGIN_STATUS.CONFLICT };
  }

  log(CONCURRENCY_LOG_EVENT.IDEMPOTENCY_REPLAYED);

  return { status: IDEMPOTENCY_BEGIN_STATUS.REPLAY, output: output.data };
}

async function settle(
  handle: IdempotencyHandle,
  script: string,
  args: readonly string[],
  event: string,
): Promise<IdempotencySettleStatus> {
  const access = await accessRedis();

  if (access.status !== REDIS_ACCESS_STATUS.READY) {
    log(
      CONCURRENCY_LOG_EVENT.IDEMPOTENCY_UNAVAILABLE,
      access.status === REDIS_ACCESS_STATUS.DISABLED
        ? CONTROL_OUTCOME.DISABLED
        : CONTROL_OUTCOME.UNAVAILABLE,
    );

    return IDEMPOTENCY_SETTLE_STATUS.UNAVAILABLE;
  }

  let reply: unknown;

  try {
    reply = await runRedisScript(access.client, script, [handle.key], args);
  } catch {
    log(
      CONCURRENCY_LOG_EVENT.IDEMPOTENCY_UNAVAILABLE,
      CONTROL_OUTCOME.UNAVAILABLE,
    );

    return IDEMPOTENCY_SETTLE_STATUS.UNAVAILABLE;
  }

  if (reply !== "completed" && reply !== "aborted") {
    log(
      CONCURRENCY_LOG_EVENT.IDEMPOTENCY_UNAVAILABLE,
      CONTROL_OUTCOME.DEGRADED,
    );

    return IDEMPOTENCY_SETTLE_STATUS.LOST;
  }

  log(event);

  return IDEMPOTENCY_SETTLE_STATUS.SETTLED;
}

/**
 * Publishes the result of a claimed attempt.
 *
 * Called after the use case has committed, so a failure here cannot undo
 * anything: it only means a later retry will run the operation again instead of
 * replaying. That is recorded and never turned into a failed response.
 */
export async function completeIdempotency(
  handle: IdempotencyHandle,
  fingerprint: string,
  output: unknown,
): Promise<IdempotencySettleStatus> {
  const record: StoredRecord = {
    v: RECORD_VERSION,
    state: IDEMPOTENCY_STATE.COMPLETED,
    fingerprint,
    output,
  };

  let payload: string;

  try {
    payload = JSON.stringify(record);
  } catch {
    log(CONCURRENCY_LOG_EVENT.IDEMPOTENCY_UNAVAILABLE, CONTROL_OUTCOME.CORRUPT);

    return IDEMPOTENCY_SETTLE_STATUS.LOST;
  }

  if (Buffer.byteLength(payload, "utf8") > MAX_IDEMPOTENCY_PAYLOAD_BYTES) {
    // Better to lose the replay than to store an unbounded response in shared
    // memory. The claim is left to expire on its own.
    log(
      CONCURRENCY_LOG_EVENT.IDEMPOTENCY_UNAVAILABLE,
      CONTROL_OUTCOME.OVERSIZED,
    );

    return IDEMPOTENCY_SETTLE_STATUS.LOST;
  }

  return settle(
    handle,
    COMPLETE_SCRIPT,
    [handle.owner, payload, String(handle.completedTtlMs)],
    CONCURRENCY_LOG_EVENT.IDEMPOTENCY_COMPLETED,
  );
}

/**
 * Releases a claim whose use case failed before committing.
 *
 * The retry that follows should be allowed to run, so the record is removed
 * rather than kept. If the release itself fails, the claim expires on its own
 * processing TTL.
 */
export async function abortIdempotency(
  handle: IdempotencyHandle,
): Promise<IdempotencySettleStatus> {
  return settle(
    handle,
    ABORT_SCRIPT,
    [handle.owner],
    CONCURRENCY_LOG_EVENT.IDEMPOTENCY_ABORTED,
  );
}

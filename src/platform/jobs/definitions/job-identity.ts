/**
 * What a job is called, and which shape of it this is.
 *
 * A name and a version together are the only thing a worker has to decide
 * whether it understands a message that was written days ago by a different
 * release. Both halves are validated here, in one place, so a name cannot be
 * invented at a call site and a version cannot be a string that happens to look
 * like a number.
 */
export const MAX_JOB_NAME_LENGTH = 64;

/**
 * `module.operation`, lowercase, dot separated.
 *
 * The dot is required: a bare word would let two areas each own a `cleanup`.
 * Uppercase and whitespace are refused because the name becomes part of a Redis
 * key and of every log line.
 */
const jobNamePattern = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;

export const MIN_JOB_VERSION = 1;

/**
 * An upper bound exists so a corrupt row cannot claim version 10^9 and be
 * treated as a plausible future release rather than as garbage.
 */
export const MAX_JOB_VERSION = 1_000;

export function isValidJobName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_JOB_NAME_LENGTH &&
    jobNamePattern.test(value)
  );
}

export function isValidJobVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_JOB_VERSION &&
    value <= MAX_JOB_VERSION
  );
}

/**
 * The full identity of one job shape: `<name>.v<version>`.
 *
 * This is what BullMQ sees as the job's name, so a version bump is visible in
 * the queue, in the failed set, and in a dashboard without anyone having to open
 * the payload.
 */
export function jobIdentity(name: string, version: number): string {
  if (!isValidJobName(name)) {
    throw new Error("The job name is not acceptable.");
  }

  if (!isValidJobVersion(version)) {
    throw new Error("The job version is not acceptable.");
  }

  return `${name}.v${version}`;
}

/**
 * Reads an identity back apart, or answers `null`.
 *
 * `null` rather than a throw: the caller is normally looking at a value that
 * arrived from Redis, and an unparseable identity is a message to dead-letter,
 * not an exception to propagate.
 */
export function parseJobIdentity(
  value: unknown,
): Readonly<{ name: string; version: number }> | null {
  if (typeof value !== "string") {
    return null;
  }

  const separator = value.lastIndexOf(".v");

  if (separator <= 0) {
    return null;
  }

  const name = value.slice(0, separator);
  const versionText = value.slice(separator + 2);

  if (!/^[1-9][0-9]*$/.test(versionText)) {
    return null;
  }

  const version = Number(versionText);

  if (!isValidJobName(name) || !isValidJobVersion(version)) {
    return null;
  }

  return { name, version };
}

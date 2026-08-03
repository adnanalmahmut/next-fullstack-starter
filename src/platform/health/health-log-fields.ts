import type { HealthCode } from "./health-code";
import type {
  DependencyStatus,
  HealthProcess,
  ReadinessStatus,
  WorkerReadinessStatus,
} from "./health-status";

/**
 * The complete allowlist of fields a health log line may carry.
 *
 * A health line is written at exactly the moment somebody wants to know why, so
 * it is the most tempting place in the system to print the connection string
 * that failed, the host that refused, the bucket that was missing, or the
 * exception that came back. Every one of those is durable, is shipped off the
 * box, and outlives the incident that produced it.
 *
 * So the set is closed, the closure is applied here rather than at each call
 * site, and anything outside it is dropped rather than trusted to be harmless. A
 * line may carry which process wrote it, a status, a stable code, a per-
 * dependency status, and a duration. It may never carry a URL, a host, a port, a
 * queue prefix, a bucket, an endpoint, a credential, a payload, an exception
 * message, or a stack trace — there is nowhere in the type to put one.
 */
export type HealthLogFields = Readonly<{
  process?: HealthProcess;
  status?: ReadinessStatus | WorkerReadinessStatus;
  code?: HealthCode;
  databaseStatus?: DependencyStatus;
  redisStatus?: DependencyStatus;
  storageStatus?: DependencyStatus;
  queueStatus?: DependencyStatus;
  durationMs?: number;
}>;

export type HealthLogInput = Readonly<{
  process?: HealthProcess | undefined;
  status?: ReadinessStatus | WorkerReadinessStatus | undefined;
  code?: HealthCode | undefined;
  databaseStatus?: DependencyStatus | undefined;
  redisStatus?: DependencyStatus | undefined;
  storageStatus?: DependencyStatus | undefined;
  queueStatus?: DependencyStatus | undefined;
  durationMs?: number | undefined;
}>;

/**
 * The field names a line may carry, in one list.
 *
 * Exported so a contract test can assert that the allowlist and the documented
 * set are the same list rather than two lists that happen to agree today.
 */
export const HEALTH_LOG_FIELD_NAMES = [
  "process",
  "status",
  "code",
  "databaseStatus",
  "redisStatus",
  "storageStatus",
  "queueStatus",
  "durationMs",
] as const;

/**
 * Builds the payload for a health event.
 *
 * Absent values are omitted rather than serialized as `null`, so a line never
 * claims to know the state of a dependency it did not check — which matters
 * here, because a misconfigured worker deliberately checks nothing.
 */
export function toHealthLogFields(input: HealthLogInput): HealthLogFields {
  const source = input as Record<string, unknown>;
  const fields: Record<string, unknown> = {};

  for (const name of HEALTH_LOG_FIELD_NAMES) {
    const value = source[name];

    if (value !== undefined) {
      fields[name] = value;
    }
  }

  return fields as HealthLogFields;
}

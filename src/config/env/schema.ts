import { z } from "zod";

export const appEnvironmentSchema = z.enum([
  "development",
  "test",
  "staging",
  "production",
]);

export const databaseUrlSchema = z.url({
  protocol: /^postgres(?:ql)?$/,
});

export const databaseEnvironmentSchema = z
  .object({
    DATABASE_URL: databaseUrlSchema,
  })
  .strict();

/**
 * Better Auth signs and encrypts with this value. A short secret weakens every
 * derived signature, so the minimum length is enforced at startup rather than
 * trusted to deployment discipline.
 */
export const authSecretSchema = z.string().min(32);

export const serverEnvironmentSchema = z
  .object({
    APP_ENV: appEnvironmentSchema,
    NODE_ENV: z.enum(["development", "test", "production"]),
    BETTER_AUTH_SECRET: authSecretSchema,
  })
  .strict();

export const publicEnvironmentSchema = z
  .object({
    NEXT_PUBLIC_APP_URL: z.url({
      protocol: /^https?$/,
    }),
  })
  .strict();

/**
 * Redis configuration.
 *
 * Redis is optional. It is deliberately declared apart from
 * `serverEnvironmentSchema` and is never read at startup: the application must
 * boot, build, and pass its whole suite with no Redis variable set at all, so a
 * missing `REDIS_URL` cannot be allowed to fail validation the way a missing
 * `DATABASE_URL` does.
 *
 * `REDIS_URL` becomes required only once `REDIS_ENABLED` is `true`. There is no
 * default URL and no fallback to `localhost`: an enabled Redis with no address
 * is a configuration mistake, not something to guess at.
 */
export const redisUrlSchema = z.url({
  protocol: /^rediss?$/,
});

/**
 * The default key prefix. Every key the application writes begins with it, so a
 * shared Redis instance can be told apart from another tenant of the same
 * server without relying on database numbers.
 */
export const DEFAULT_REDIS_KEY_PREFIX = "next-fullstack-starter";

export const DEFAULT_REDIS_CONNECT_TIMEOUT_MS = 5_000;
export const MIN_REDIS_CONNECT_TIMEOUT_MS = 100;
export const MAX_REDIS_CONNECT_TIMEOUT_MS = 30_000;

/**
 * A prefix is part of every key, so it is held to the same shape as a key
 * segment: no separator, no whitespace, no wildcard.
 */
export const redisKeyPrefixSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const redisFlagSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const redisTestIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const redisEnvironmentSchema = z
  .object({
    REDIS_ENABLED: redisFlagSchema.default(false),
    REDIS_URL: redisUrlSchema.optional(),
    REDIS_KEY_PREFIX: redisKeyPrefixSchema.default(DEFAULT_REDIS_KEY_PREFIX),
    REDIS_CONNECT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(MIN_REDIS_CONNECT_TIMEOUT_MS)
      .max(MAX_REDIS_CONNECT_TIMEOUT_MS)
      .default(DEFAULT_REDIS_CONNECT_TIMEOUT_MS),
    REDIS_TEST_RUN_ID: redisTestIdentifierSchema.optional(),
    REDIS_TEST_WORKER_ID: redisTestIdentifierSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.REDIS_ENABLED && value.REDIS_URL === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["REDIS_URL"],
        message: "REDIS_URL is required when REDIS_ENABLED is true.",
      });
    }
  });

/**
 * Background jobs configuration.
 *
 * Jobs are optional in the same way Redis is, and for the same reason: the
 * application must build, boot, and pass its whole suite with no queue, no
 * worker, and no `JOBS_REDIS_URL`. This block is therefore declared apart from
 * `serverEnvironmentSchema` and read lazily.
 *
 * It deliberately does not reuse the Redis helpers above. The two areas are
 * removable independently — a project can delete `src/platform/redis` and keep
 * jobs, or the reverse — and a shared helper would make each deletion a change
 * to the other's schema.
 *
 * There are two distinct levels here, and the distinction is the whole contract:
 *
 * - `JOBS_ENABLED` turns the *outbox* on. Writing an outbox row is a plain
 *   database insert inside the caller's transaction, so it needs no Redis, no
 *   queue, and no worker.
 * - `JOBS_REDIS_URL` is needed only to build a queue, a worker, or the
 *   dispatcher. It is validated here but never required here, because the web
 *   application can — and should be able to — keep recording work while Redis
 *   and the worker are down.
 */
export const jobsRedisUrlSchema = z.url({
  protocol: /^rediss?$/,
});

/**
 * The BullMQ key prefix.
 *
 * BullMQ manages its own key layout underneath this prefix, so it is kept apart
 * from `REDIS_KEY_PREFIX`: the two must be free to point at different servers,
 * and a queue must never land inside the cache's key space.
 */
export const DEFAULT_JOBS_QUEUE_PREFIX = "next-fullstack-starter-jobs";

export const DEFAULT_JOBS_WORKER_CONCURRENCY = 5;
export const MIN_JOBS_WORKER_CONCURRENCY = 1;
export const MAX_JOBS_WORKER_CONCURRENCY = 64;

export const DEFAULT_JOBS_WORKER_SHUTDOWN_TIMEOUT_MS = 30_000;
export const MIN_JOBS_WORKER_SHUTDOWN_TIMEOUT_MS = 1_000;
export const MAX_JOBS_WORKER_SHUTDOWN_TIMEOUT_MS = 300_000;

export const DEFAULT_OUTBOX_BATCH_SIZE = 25;
export const MIN_OUTBOX_BATCH_SIZE = 1;
export const MAX_OUTBOX_BATCH_SIZE = 500;

export const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 1_000;
export const MIN_OUTBOX_POLL_INTERVAL_MS = 50;
export const MAX_OUTBOX_POLL_INTERVAL_MS = 60_000;

export const DEFAULT_OUTBOX_LEASE_MS = 30_000;
export const MIN_OUTBOX_LEASE_MS = 1_000;
export const MAX_OUTBOX_LEASE_MS = 600_000;

export const DEFAULT_OUTBOX_MAX_PUBLISH_ATTEMPTS = 10;
export const MIN_OUTBOX_MAX_PUBLISH_ATTEMPTS = 1;
export const MAX_OUTBOX_MAX_PUBLISH_ATTEMPTS = 50;

export const DEFAULT_OUTBOX_BACKOFF_BASE_MS = 1_000;
export const MIN_OUTBOX_BACKOFF_BASE_MS = 50;
export const MAX_OUTBOX_BACKOFF_BASE_MS = 60_000;

/** A prefix becomes part of every queue key, so it is held to a key's shape. */
export const jobsQueuePrefixSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const jobsFlagSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const jobsTestIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const boundedInteger = (minimum: number, maximum: number, fallback: number) =>
  z.coerce.number().int().min(minimum).max(maximum).default(fallback);

export const jobsEnvironmentSchema = z
  .object({
    JOBS_ENABLED: jobsFlagSchema.default(false),
    JOBS_REDIS_URL: jobsRedisUrlSchema.optional(),
    JOBS_QUEUE_PREFIX: jobsQueuePrefixSchema.default(DEFAULT_JOBS_QUEUE_PREFIX),
    JOBS_WORKER_CONCURRENCY: boundedInteger(
      MIN_JOBS_WORKER_CONCURRENCY,
      MAX_JOBS_WORKER_CONCURRENCY,
      DEFAULT_JOBS_WORKER_CONCURRENCY,
    ),
    JOBS_WORKER_SHUTDOWN_TIMEOUT_MS: boundedInteger(
      MIN_JOBS_WORKER_SHUTDOWN_TIMEOUT_MS,
      MAX_JOBS_WORKER_SHUTDOWN_TIMEOUT_MS,
      DEFAULT_JOBS_WORKER_SHUTDOWN_TIMEOUT_MS,
    ),
    OUTBOX_BATCH_SIZE: boundedInteger(
      MIN_OUTBOX_BATCH_SIZE,
      MAX_OUTBOX_BATCH_SIZE,
      DEFAULT_OUTBOX_BATCH_SIZE,
    ),
    OUTBOX_POLL_INTERVAL_MS: boundedInteger(
      MIN_OUTBOX_POLL_INTERVAL_MS,
      MAX_OUTBOX_POLL_INTERVAL_MS,
      DEFAULT_OUTBOX_POLL_INTERVAL_MS,
    ),
    OUTBOX_LEASE_MS: boundedInteger(
      MIN_OUTBOX_LEASE_MS,
      MAX_OUTBOX_LEASE_MS,
      DEFAULT_OUTBOX_LEASE_MS,
    ),
    OUTBOX_MAX_PUBLISH_ATTEMPTS: boundedInteger(
      MIN_OUTBOX_MAX_PUBLISH_ATTEMPTS,
      MAX_OUTBOX_MAX_PUBLISH_ATTEMPTS,
      DEFAULT_OUTBOX_MAX_PUBLISH_ATTEMPTS,
    ),
    OUTBOX_BACKOFF_BASE_MS: boundedInteger(
      MIN_OUTBOX_BACKOFF_BASE_MS,
      MAX_OUTBOX_BACKOFF_BASE_MS,
      DEFAULT_OUTBOX_BACKOFF_BASE_MS,
    ),
    JOBS_TEST_RUN_ID: jobsTestIdentifierSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The lease has to outlast a publish attempt for the claim to mean
    // anything: a lease shorter than the poll interval would let a second
    // dispatcher claim a row the first one is still publishing.
    if (value.OUTBOX_LEASE_MS <= value.OUTBOX_POLL_INTERVAL_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["OUTBOX_LEASE_MS"],
        message:
          "OUTBOX_LEASE_MS must be greater than OUTBOX_POLL_INTERVAL_MS.",
      });
    }
  });

/**
 * Object storage configuration.
 *
 * Storage is optional in exactly the way Redis and jobs are: the application
 * must build, boot, and pass its whole suite with no bucket, no endpoint, and no
 * credentials. This block is therefore declared apart from
 * `serverEnvironmentSchema` and read lazily, and it deliberately shares no
 * helper with the two above — each area has to stay deletable on its own.
 *
 * `STORAGE_ENABLED` is the only variable with a meaning while storage is off.
 * Once it is on, a region and a bucket become required, because an enabled
 * storage with nowhere to put an object is a configuration mistake rather than
 * something to guess at. There is no default endpoint: not `localhost`, not
 * `minio`, not an AWS host. Omitting the endpoint selects AWS S3's own regional
 * endpoint through the SDK, which is the only default that is a real decision.
 */
export const storageEndpointSchema = z.url({
  // `http` is accepted because a development MinIO on the loopback interface
  // has no certificate. A deployed provider is expected to be `https`, and the
  // endpoint is never logged either way.
  protocol: /^https?$/,
});

/**
 * The default key prefix. Every key the application writes begins with it, so
 * one bucket can hold two applications without either one able to name the
 * other's objects.
 */
export const DEFAULT_STORAGE_KEY_PREFIX = "next-fullstack-starter";

export const DEFAULT_STORAGE_CONNECT_TIMEOUT_MS = 5_000;
export const MIN_STORAGE_CONNECT_TIMEOUT_MS = 100;
export const MAX_STORAGE_CONNECT_TIMEOUT_MS = 30_000;

export const DEFAULT_STORAGE_REQUEST_TIMEOUT_MS = 15_000;
export const MIN_STORAGE_REQUEST_TIMEOUT_MS = 100;
export const MAX_STORAGE_REQUEST_TIMEOUT_MS = 120_000;

export const DEFAULT_STORAGE_UPLOAD_URL_TTL_SECONDS = 900;
export const MIN_STORAGE_UPLOAD_URL_TTL_SECONDS = 30;
/** The S3 signature-v4 ceiling for a presigned URL is seven days. */
export const MAX_STORAGE_UPLOAD_URL_TTL_SECONDS = 604_800;

export const DEFAULT_STORAGE_DOWNLOAD_URL_TTL_SECONDS = 300;
export const MIN_STORAGE_DOWNLOAD_URL_TTL_SECONDS = 30;
export const MAX_STORAGE_DOWNLOAD_URL_TTL_SECONDS = 604_800;

export const DEFAULT_STORAGE_UPLOAD_INTENT_TTL_SECONDS = 900;
export const MIN_STORAGE_UPLOAD_INTENT_TTL_SECONDS = 60;
export const MAX_STORAGE_UPLOAD_INTENT_TTL_SECONDS = 86_400;

export const DEFAULT_STORAGE_FINALIZE_LEASE_MS = 30_000;
export const MIN_STORAGE_FINALIZE_LEASE_MS = 1_000;
export const MAX_STORAGE_FINALIZE_LEASE_MS = 600_000;

/** 25 MiB. */
export const DEFAULT_STORAGE_MAX_UPLOAD_BYTES = 26_214_400;
export const MIN_STORAGE_MAX_UPLOAD_BYTES = 1;
/**
 * 5 GiB, the largest object a single `PutObject` or presigned POST can carry.
 * Anything above it would need a multipart upload, which this platform does not
 * implement, so accepting a larger ceiling would only produce uploads that
 * always fail at the provider.
 */
export const MAX_STORAGE_MAX_UPLOAD_BYTES = 5_368_709_120;

/**
 * A prefix is the first segment of every key, so it is held to a key segment's
 * shape: no separator, no whitespace, no traversal.
 */
export const storageKeyPrefixSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const storageFlagSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

/**
 * A bucket name, held to the S3 naming rules that every compatible provider
 * shares: lowercase, dotted or hyphenated, 3 to 63 characters.
 */
export const storageBucketSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/);

export const storageRegionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

/** Bounded and shaped, because it becomes a path segment of every test key. */
const storageTestIdentifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const storageCredentialSchema = z.string().min(1).max(512);

const boundedStorageInteger = (
  minimum: number,
  maximum: number,
  fallback: number,
) => z.coerce.number().int().min(minimum).max(maximum).default(fallback);

export const storageEnvironmentSchema = z
  .object({
    STORAGE_ENABLED: storageFlagSchema.default(false),

    STORAGE_ENDPOINT: storageEndpointSchema.optional(),
    STORAGE_REGION: storageRegionSchema.optional(),
    STORAGE_BUCKET: storageBucketSchema.optional(),

    STORAGE_ACCESS_KEY_ID: storageCredentialSchema.optional(),
    STORAGE_SECRET_ACCESS_KEY: storageCredentialSchema.optional(),
    STORAGE_SESSION_TOKEN: storageCredentialSchema.optional(),

    STORAGE_FORCE_PATH_STYLE: storageFlagSchema.default(false),
    STORAGE_KEY_PREFIX: storageKeyPrefixSchema.default(
      DEFAULT_STORAGE_KEY_PREFIX,
    ),

    STORAGE_CONNECT_TIMEOUT_MS: boundedStorageInteger(
      MIN_STORAGE_CONNECT_TIMEOUT_MS,
      MAX_STORAGE_CONNECT_TIMEOUT_MS,
      DEFAULT_STORAGE_CONNECT_TIMEOUT_MS,
    ),
    STORAGE_REQUEST_TIMEOUT_MS: boundedStorageInteger(
      MIN_STORAGE_REQUEST_TIMEOUT_MS,
      MAX_STORAGE_REQUEST_TIMEOUT_MS,
      DEFAULT_STORAGE_REQUEST_TIMEOUT_MS,
    ),

    STORAGE_UPLOAD_URL_TTL_SECONDS: boundedStorageInteger(
      MIN_STORAGE_UPLOAD_URL_TTL_SECONDS,
      MAX_STORAGE_UPLOAD_URL_TTL_SECONDS,
      DEFAULT_STORAGE_UPLOAD_URL_TTL_SECONDS,
    ),
    STORAGE_DOWNLOAD_URL_TTL_SECONDS: boundedStorageInteger(
      MIN_STORAGE_DOWNLOAD_URL_TTL_SECONDS,
      MAX_STORAGE_DOWNLOAD_URL_TTL_SECONDS,
      DEFAULT_STORAGE_DOWNLOAD_URL_TTL_SECONDS,
    ),
    STORAGE_UPLOAD_INTENT_TTL_SECONDS: boundedStorageInteger(
      MIN_STORAGE_UPLOAD_INTENT_TTL_SECONDS,
      MAX_STORAGE_UPLOAD_INTENT_TTL_SECONDS,
      DEFAULT_STORAGE_UPLOAD_INTENT_TTL_SECONDS,
    ),
    STORAGE_FINALIZE_LEASE_MS: boundedStorageInteger(
      MIN_STORAGE_FINALIZE_LEASE_MS,
      MAX_STORAGE_FINALIZE_LEASE_MS,
      DEFAULT_STORAGE_FINALIZE_LEASE_MS,
    ),

    STORAGE_MAX_UPLOAD_BYTES: boundedStorageInteger(
      MIN_STORAGE_MAX_UPLOAD_BYTES,
      MAX_STORAGE_MAX_UPLOAD_BYTES,
      DEFAULT_STORAGE_MAX_UPLOAD_BYTES,
    ),

    STORAGE_TEST_RUN_ID: storageTestIdentifierSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.STORAGE_ENABLED) {
      // The endpoint is deliberately absent from this list. Omitting it selects
      // AWS S3's own regional endpoint, which is a valid deployment; MinIO and
      // R2 need one, and their absence shows up as a connection failure at the
      // first call rather than as a silent fallback to somewhere local.
      if (value.STORAGE_REGION === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["STORAGE_REGION"],
          message: "STORAGE_REGION is required when STORAGE_ENABLED is true.",
        });
      }

      if (value.STORAGE_BUCKET === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["STORAGE_BUCKET"],
          message: "STORAGE_BUCKET is required when STORAGE_ENABLED is true.",
        });
      }
    }

    // Half a credential pair is never a working configuration, and it is a
    // dangerous one to guess at: falling back to the AWS default credential
    // chain because the secret was missing would silently sign requests as
    // whichever identity the host happens to carry.
    const hasAccessKeyId = value.STORAGE_ACCESS_KEY_ID !== undefined;
    const hasSecretAccessKey = value.STORAGE_SECRET_ACCESS_KEY !== undefined;

    if (hasAccessKeyId !== hasSecretAccessKey) {
      ctx.addIssue({
        code: "custom",
        path: [
          hasAccessKeyId
            ? "STORAGE_SECRET_ACCESS_KEY"
            : "STORAGE_ACCESS_KEY_ID",
        ],
        message:
          "STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY must be set together or left out together.",
      });
    }

    // A session token is the third part of a temporary credential; on its own
    // there is nothing for it to be a session of.
    if (value.STORAGE_SESSION_TOKEN !== undefined && !hasAccessKeyId) {
      ctx.addIssue({
        code: "custom",
        path: ["STORAGE_SESSION_TOKEN"],
        message:
          "STORAGE_SESSION_TOKEN requires STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY.",
      });
    }

    // A presigned upload that outlives the intent it belongs to is a form the
    // client can still submit after the server has stopped expecting it: the
    // bytes would land in staging with nothing left to promote them.
    if (
      value.STORAGE_UPLOAD_URL_TTL_SECONDS >
      value.STORAGE_UPLOAD_INTENT_TTL_SECONDS
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["STORAGE_UPLOAD_URL_TTL_SECONDS"],
        message:
          "STORAGE_UPLOAD_URL_TTL_SECONDS must not exceed STORAGE_UPLOAD_INTENT_TTL_SECONDS.",
      });
    }

    // The lease exists to let a second finalization attempt take over from one
    // that died. A lease that outlived the intent would leave nothing to take
    // over: the intent would already be expired by the time it was reclaimable.
    if (
      value.STORAGE_FINALIZE_LEASE_MS >=
      value.STORAGE_UPLOAD_INTENT_TTL_SECONDS * 1_000
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["STORAGE_FINALIZE_LEASE_MS"],
        message:
          "STORAGE_FINALIZE_LEASE_MS must be shorter than STORAGE_UPLOAD_INTENT_TTL_SECONDS.",
      });
    }
  });

export type DatabaseEnvironment = z.output<typeof databaseEnvironmentSchema>;
export type ServerEnvironment = z.output<typeof serverEnvironmentSchema>;
export type PublicEnvironment = z.output<typeof publicEnvironmentSchema>;
export type RedisEnvironment = z.output<typeof redisEnvironmentSchema>;
export type JobsEnvironment = z.output<typeof jobsEnvironmentSchema>;
export type StorageEnvironment = z.output<typeof storageEnvironmentSchema>;

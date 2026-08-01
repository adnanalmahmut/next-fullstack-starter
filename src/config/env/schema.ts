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

export type DatabaseEnvironment = z.output<typeof databaseEnvironmentSchema>;
export type ServerEnvironment = z.output<typeof serverEnvironmentSchema>;
export type PublicEnvironment = z.output<typeof publicEnvironmentSchema>;
export type RedisEnvironment = z.output<typeof redisEnvironmentSchema>;

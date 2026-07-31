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

export type DatabaseEnvironment = z.output<typeof databaseEnvironmentSchema>;
export type ServerEnvironment = z.output<typeof serverEnvironmentSchema>;
export type PublicEnvironment = z.output<typeof publicEnvironmentSchema>;

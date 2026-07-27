import { z } from "zod";

export const appEnvironmentSchema = z.enum([
  "development",
  "test",
  "staging",
  "production",
]);

export const serverEnvironmentSchema = z
  .object({
    APP_ENV: appEnvironmentSchema,
    NODE_ENV: z.enum(["development", "test", "production"]),
  })
  .strict();

export const publicEnvironmentSchema = z
  .object({
    NEXT_PUBLIC_APP_URL: z.url({
      protocol: /^https?$/,
    }),
  })
  .strict();

export type ServerEnvironment = z.output<typeof serverEnvironmentSchema>;
export type PublicEnvironment = z.output<typeof publicEnvironmentSchema>;

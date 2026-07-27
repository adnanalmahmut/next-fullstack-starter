import { parseEnvironment } from "./parse";
import { publicEnvironmentSchema } from "./schema";

export const publicEnv = parseEnvironment("public", publicEnvironmentSchema, {
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
});

import { parseEnvironment } from "./parse";
import { serverEnvironmentSchema, type ServerEnvironment } from "./schema";

type ServerEnvironmentSource = {
  APP_ENV?: string;
  NODE_ENV?: string;
};

export function readServerEnvironment(
  source: ServerEnvironmentSource = process.env,
): ServerEnvironment {
  return parseEnvironment("server", serverEnvironmentSchema, {
    APP_ENV: source.APP_ENV,
    NODE_ENV: source.NODE_ENV,
  });
}

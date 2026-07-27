import { parseEnvironment } from "./parse";
import { databaseEnvironmentSchema, type DatabaseEnvironment } from "./schema";

type DatabaseEnvironmentSource = {
  DATABASE_URL?: string;
};

export function readDatabaseEnvironment(
  source: DatabaseEnvironmentSource = {
    DATABASE_URL: process.env.DATABASE_URL,
  },
): DatabaseEnvironment {
  return parseEnvironment("database", databaseEnvironmentSchema, {
    DATABASE_URL: source.DATABASE_URL,
  });
}

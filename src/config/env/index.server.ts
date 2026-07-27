import "server-only";

import { readDatabaseEnvironment } from "./read-database";
import { readServerEnvironment } from "./read-server";

export const databaseEnv = readDatabaseEnvironment();
export const serverEnv = readServerEnvironment();

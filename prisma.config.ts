import { loadEnvConfig } from "@next/env";
import { defineConfig } from "prisma/config";

import { readDatabaseEnvironment } from "./src/config/env/read-database";

loadEnvConfig(process.cwd());

const databaseEnv = readDatabaseEnvironment();

export default defineConfig({
  schema: "prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseEnv.DATABASE_URL,
  },
});

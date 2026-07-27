import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { databaseEnv, serverEnv } from "@/config/env/index.server";
import { PrismaClient } from "@/generated/prisma/client";

const globalForDatabase = globalThis as typeof globalThis & {
  databaseClient?: PrismaClient;
};

function createDatabaseClient() {
  const adapter = new PrismaPg({
    connectionString: databaseEnv.DATABASE_URL,
  });

  return new PrismaClient({
    adapter,
  });
}

export const database =
  globalForDatabase.databaseClient ?? createDatabaseClient();

if (serverEnv.NODE_ENV !== "production") {
  globalForDatabase.databaseClient = database;
}

import "server-only";

export {
  checkDatabaseHealth,
  DATABASE_HEALTH_STATUS,
  DATABASE_HEALTH_TIMEOUT_MS,
  DATABASE_UNAVAILABLE,
  type DatabaseHealth,
  type DatabaseHealthProbe,
  type DatabaseHealthStatus,
} from "./health.server";

export { database } from "./prisma";

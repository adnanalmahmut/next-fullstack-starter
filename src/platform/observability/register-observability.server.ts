import "server-only";

import type { StructuredLogger } from "./create-logger.server";
import { LOG_EVENT } from "./log-event";
import { logger } from "./logger.server";

let registered = false;

export function registerObservability(
  baseLogger: StructuredLogger = logger,
): void {
  if (registered) {
    return;
  }

  registered = true;
  baseLogger.info(LOG_EVENT.APPLICATION_STARTED);
}

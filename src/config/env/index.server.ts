import "server-only";

import { readServerEnvironment } from "./read-server";

export const serverEnv = readServerEnvironment();

import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/platform/auth/auth.server";

/**
 * Better Auth owns every authentication endpoint under this path. The adapter
 * stays thin on purpose: no body parsing, no logging, no response rewriting, and
 * no business logic run before or after it.
 */
export const { GET, POST } = toNextJsHandler(auth.handler);

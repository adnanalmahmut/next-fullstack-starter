import { loadEnvConfig } from "@next/env";

import { TEST_ONLY_BETTER_AUTH_SECRET } from "./test-secrets";

loadEnvConfig(process.cwd());

// Automated runs must not depend on a developer-provided secret. Runtime code
// has no fallback: the value is injected here, at the test boundary only.
process.env.BETTER_AUTH_SECRET ??= TEST_ONLY_BETTER_AUTH_SECRET;

/**
 * Test-only secrets. These values exist so automated runs can satisfy the
 * validated server environment without a real secret. They must never be used
 * for a deployed environment, and the application must never fall back to them
 * at runtime.
 */
export const TEST_ONLY_BETTER_AUTH_SECRET =
  "test-only-better-auth-secret-do-not-use-in-production";

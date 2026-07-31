import { createAuthClient } from "better-auth/react";

/**
 * Client-safe Better Auth client.
 *
 * It is same-origin by default, so no base URL or secret is embedded in the
 * client bundle. It exists only to perform sign-in and sign-out and to render
 * pending state; it never decides access. Every protected page, Route Handler,
 * Server Action, and use case re-checks the session on the server.
 */
export const authClient = createAuthClient();

export const { signIn, signOut } = authClient;

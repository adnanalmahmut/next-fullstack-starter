import "server-only";

import { prismaAdapter } from "@better-auth/prisma-adapter";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins/admin";

import { publicEnv } from "@/config/env/index.client";
import { serverEnv } from "@/config/env/index.server";
import { database } from "@/platform/database/index.server";

import {
  ADMIN_ROLES,
  DEFAULT_ROLE,
  accessControl,
  authorizationRoles,
} from "./access-control";
import { isEmailRegistrationEnabled } from "./registration-policy";

/**
 * Session lifetime policy. Sessions are database-backed so a record can be
 * revoked immediately; no cookie cache is enabled, which means every server read
 * consults the database and a signed-out cookie cannot resurrect a session.
 */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

export const auth = betterAuth({
  appName: "next-fullstack-starter",
  secret: serverEnv.BETTER_AUTH_SECRET,
  baseURL: publicEnv.NEXT_PUBLIC_APP_URL,
  trustedOrigins: [publicEnv.NEXT_PUBLIC_APP_URL],

  database: prismaAdapter(database, {
    provider: "postgresql",
    transaction: true,
  }),

  emailAndPassword: {
    enabled: true,
    // Deployed environments reject sign-up at the endpoint, not by hiding a link.
    disableSignUp: !isEmailRegistrationEnabled(serverEnv.APP_ENV),
    // No email provider exists yet, so verification cannot be required.
    requireEmailVerification: false,
  },

  session: {
    expiresIn: SESSION_EXPIRES_IN_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
    cookieCache: {
      enabled: false,
    },
  },

  rateLimit: {
    // Better Auth throttles sign-in and sign-up by default in production, and
    // that default is kept for every real environment. The automated suite
    // exercises many of those requests from one address within seconds, so it is
    // the only environment where throttling is turned off. Designing an actual
    // rate-limit policy, including its storage, is deferred to its own change.
    enabled: serverEnv.APP_ENV !== "test",
  },

  advanced: {
    useSecureCookies: serverEnv.NODE_ENV === "production",
  },

  plugins: [
    admin({
      defaultRole: DEFAULT_ROLE,
      adminRoles: ADMIN_ROLES,
      ac: accessControl,
      roles: authorizationRoles,
    }),
  ],
});

export type Auth = typeof auth;

import "server-only";

import { ValidationError } from "@/shared/errors/application-error";

import { auth } from "../auth.server";

import type { Actor } from "./actor";
import { ADMIN_USERS_SEARCH_FIELD, type AdminUsersQuery } from "./admin-query";
import {
  type AdminUserDto,
  type AdminUserListPage,
  toAdminUserDto,
  toAdminUserDtos,
} from "./admin-user-dto";
import { toApplicationError } from "./api-error-mapping";
import { requireCallerHeaders } from "./caller-headers.server";
import { PERMISSION } from "./permission-registry";
import { requirePermission } from "./require-permission.server";
import { isAuthorizationRole } from "./role";

/**
 * The administrative user operations this application supports.
 *
 * Only four operations exist, and each one goes through Better Auth. Nothing here
 * writes to a Better Auth owned table directly, re-implements provider behavior,
 * or returns a provider record: every result is an allowlisted DTO.
 *
 * The capability is required here as well as in the Route Handler. The handler is
 * a public entry point and must not rely on a downstream check, and a service
 * must not rely on the caller having checked. The resource policies and the audit
 * records live in the Better Auth guard hook, so a direct call to
 * `/api/auth/admin/...` is held to exactly the same rules.
 */
export type AdminOperationContext = Readonly<{
  actor: Actor;
  /**
   * The caller's headers, for delegating to Better Auth on their behalf.
   *
   * Optional because a Route Handler must not hand transport data to a use case.
   * When it is omitted the headers are read from the request scope the Route
   * Handler factory opened; outside a request there is no caller, and
   * `requireCallerHeaders` refuses rather than acting without one. A caller that
   * already holds a verified header set — an integration test, or a service
   * composing another — may still pass it explicitly.
   */
  headers?: Headers;
}>;

export function callerHeaders(context: AdminOperationContext): Headers {
  return context.headers ?? requireCallerHeaders();
}

async function callProvider<TResult>(
  operation: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await operation();
  } catch (error) {
    throw toApplicationError(error);
  }
}

export async function listAdminUsers(
  context: AdminOperationContext,
  query: AdminUsersQuery,
): Promise<AdminUserListPage> {
  await requirePermission(context.actor, PERMISSION.IDENTITY_USER_LIST);

  const result = await callProvider(() =>
    auth.api.listUsers({
      headers: callerHeaders(context),
      query: {
        limit: query.limit,
        offset: query.offset,
        sortBy: query.sortBy,
        sortDirection: query.sortDirection,
        ...(query.search
          ? {
              searchField: ADMIN_USERS_SEARCH_FIELD,
              searchOperator: "contains" as const,
              searchValue: query.search,
            }
          : {}),
      },
    }),
  );

  return {
    users: toAdminUserDtos(result.users),
    total: result.total,
    limit: query.limit,
    offset: query.offset,
  };
}

export async function getAdminUser(
  context: AdminOperationContext,
  targetUserId: string,
): Promise<AdminUserDto> {
  await requirePermission(context.actor, PERMISSION.IDENTITY_USER_READ);

  return toAdminUserDto(
    await callProvider(() =>
      auth.api.getUser({
        headers: callerHeaders(context),
        query: { id: targetUserId },
      }),
    ),
  );
}

export async function setAdminUserRole(
  context: AdminOperationContext,
  targetUserId: string,
  role: string,
): Promise<AdminUserDto> {
  await requirePermission(context.actor, PERMISSION.IDENTITY_USER_SET_ROLE);

  // Better Auth types the body against the declared roles, so the value has to be
  // narrowed here. The check uses the central role guard, and the resource policy
  // inside the Better Auth hook repeats it for a direct caller.
  if (!isAuthorizationRole(role)) {
    throw new ValidationError(
      "The requested role is not one of the approved roles.",
    );
  }

  const result = await callProvider(() =>
    auth.api.setRole({
      headers: callerHeaders(context),
      body: {
        userId: targetUserId,
        role,
      },
    }),
  );

  return toAdminUserDto(result.user);
}

export async function revokeAdminUserSessions(
  context: AdminOperationContext,
  targetUserId: string,
): Promise<void> {
  await requirePermission(context.actor, PERMISSION.IDENTITY_SESSION_REVOKE);

  await callProvider(() =>
    auth.api.revokeUserSessions({
      headers: callerHeaders(context),
      body: { userId: targetUserId },
    }),
  );
}

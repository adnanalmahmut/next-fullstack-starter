import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { UnauthenticatedError } from "@/shared/errors/application-error";

/**
 * The caller's own request headers, scoped to the request being handled.
 *
 * Better Auth decides an administrative operation from the acting session, and it
 * reads that session from headers — for a router request and for a direct
 * `auth.api.*` call alike. That is deliberate: it is what makes the guard hook,
 * the resource policies, and the audit record impossible to skip. It also means a
 * server service that delegates to Better Auth needs the caller's headers.
 *
 * A use case must not be handed them. Request headers carry the session cookie and
 * the authorization header, and a use case that can read those can authenticate on
 * its own, which is exactly what the adapters exist to prevent. So the transport
 * boundary puts them here instead, and the service reads them from the request
 * scope rather than from its arguments. The Route Handler factory is what opens
 * the scope, in the same place it resolves the request context.
 *
 * This is credential propagation, not an ambient actor. Nothing here decides
 * anything: the actor is still built by verifying the session, and the capability
 * is still evaluated by the central gate.
 */
const callerHeadersStorage = new AsyncLocalStorage<Headers>();

/**
 * Runs `callback` with the caller's headers available to server services.
 *
 * The headers are copied, so a later mutation of the request cannot change what a
 * service already read, and a service cannot change what the transport sees.
 */
export function runWithCallerHeaders<T>(
  requestHeaders: Headers,
  callback: () => T,
): T {
  return callerHeadersStorage.run(new Headers(requestHeaders), callback);
}

export function getCallerHeaders(): Headers | undefined {
  return callerHeadersStorage.getStore();
}

/**
 * Reads the caller's headers, refusing when there is no caller.
 *
 * Absence means the code is running outside a request the factory opened — a
 * background job, or a service called directly — and no session can be proven for
 * it. Failing closed as unauthenticated is the only safe answer: silently
 * continuing without credentials would ask Better Auth to act with no acting
 * identity.
 */
export function requireCallerHeaders(): Headers {
  const requestHeaders = getCallerHeaders();

  if (!requestHeaders) {
    throw new UnauthenticatedError(
      "The operation requires the caller's request scope.",
    );
  }

  return requestHeaders;
}

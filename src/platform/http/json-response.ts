import { toPublicError } from "@/platform/errors/to-public-error";

import {
  type HttpErrorResponse,
  type HttpSuccessResponse,
  httpStatusForError,
} from "./http-response";

/**
 * Serialization for the implemented HTTP response contract.
 *
 * These two functions are the only place a Route Handler turns a value into a
 * response body. A caught error never reaches the wire: it is normalized to a
 * language-neutral code first, so a stack trace, a provider payload, or a
 * database detail cannot escape.
 *
 * This is deliberately not a route factory. Rate limiting, idempotency, and
 * request logging belong to a `defineRoute` boundary that does not exist yet.
 */
export function jsonSuccess<T>(data: T, status = 200): Response {
  return Response.json({ data } satisfies HttpSuccessResponse<T>, { status });
}

export function jsonNoContent(): Response {
  return new Response(null, { status: 204 });
}

export function jsonError(error: unknown): Response {
  const publicError = toPublicError(error);

  return Response.json({ error: publicError } satisfies HttpErrorResponse, {
    status: httpStatusForError(publicError.code),
  });
}

import { toPublicError } from "@/platform/errors/to-public-error";

import {
  HTTP_SUCCESS_STATUS,
  type HttpErrorResponse,
  type HttpSuccessResponse,
  type HttpSuccessStatus,
  httpStatusForError,
} from "./http-response";

/**
 * Serialization for the HTTP response contract.
 *
 * These two functions are the only place a value becomes a response body. A
 * caught error never reaches the wire: it is normalized to a language-neutral
 * code first, so a stack trace, a provider payload, or a database detail cannot
 * escape.
 *
 * Every answer is a JSON envelope. There is no `204` and no empty body: a route
 * with no payload answers `{"data": null}`, so a client parses one shape for
 * every outcome of every versioned endpoint.
 *
 * `headers` exists so the correlation header is written where the body is
 * written, rather than being stamped onto a finished response somewhere else.
 * `defineRoute` is the only caller.
 */
export function jsonSuccess<T>(
  data: T,
  status: HttpSuccessStatus = HTTP_SUCCESS_STATUS.OK,
  headers?: HeadersInit,
): Response {
  return Response.json({ data } satisfies HttpSuccessResponse<T>, {
    status,
    ...(headers ? { headers } : {}),
  });
}

export function jsonError(error: unknown, headers?: HeadersInit): Response {
  const publicError = toPublicError(error);

  return Response.json({ error: publicError } satisfies HttpErrorResponse, {
    status: httpStatusForError(publicError.code),
    ...(headers ? { headers } : {}),
  });
}

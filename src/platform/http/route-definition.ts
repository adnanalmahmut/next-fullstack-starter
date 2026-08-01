import type { NextRequest } from "next/server";

import type {
  Authorization,
  AuthorizedActor,
} from "@/platform/auth/authorization/authorization-mode";
import type { CacheInvalidation } from "@/platform/cache/cache-invalidation";

import type { HttpSuccessStatus } from "./http-response";
import type { RouteContext } from "./route-context";
import type { RouteHooks, RouteIdempotency } from "./route-hooks";
import type { RouteInputSchemas } from "./route-input";

/**
 * The use case call.
 *
 * It is the only place business logic belongs. By the time it runs the three
 * parts are validated, the actor is resolved, and the capability is granted; it
 * must not repeat any of that. It returns a value, never a `Response`: the
 * factory owns the envelope and the status.
 */
export type RouteExecute<TInput extends RouteInputSchemas, TActor, TOutput> = (
  context: RouteContext<TInput, TActor>,
) => TOutput | Promise<TOutput>;

/**
 * One Route Handler declaration.
 *
 * `TOutput` is inferred from `execute` and each input type is inferred from its
 * own schema, so a definition never restates a type the schema or the use case
 * already determines.
 */
export type RouteDefinition<
  TInput extends RouteInputSchemas,
  TAuthorization extends Authorization,
  TOutput,
> = Readonly<{
  /**
   * A stable, unique identifier such as `identity.user.list`. It is logged
   * verbatim and is the name a future OpenAPI operation id would be derived
   * from, so it must not change casually.
   */
  name: string;
  input?: TInput;
  authorization: TAuthorization;
  /**
   * The status a successful answer carries, declared statically here.
   *
   * A status is never chosen by client input and never returned by a use case.
   * There is no `204`: a route with no payload answers `200` with `{"data":
   * null}`, so every response in the versioned API is the same JSON envelope.
   */
  successStatus?: HttpSuccessStatus;
  execute: RouteExecute<TInput, AuthorizedActor<TAuthorization>, TOutput>;
  hooks?: RouteHooks<TInput, AuthorizedActor<TAuthorization>, TOutput>;
  /**
   * The idempotency lifecycle, when this route has one.
   *
   * A single coordinator rather than a list: two would each claim a key and
   * neither would know about the other's reservation. It is not a hook because
   * it does not merely gate the use case — it also has to be settled afterwards.
   */
  idempotency?: RouteIdempotency<
    TInput,
    AuthorizedActor<TAuthorization>,
    TOutput
  >;
  /**
   * Paths, tags, and Redis entries to invalidate after the use case succeeds.
   *
   * Declared here and never taken from client input. A Route Handler may not
   * declare the read-your-own-writes tag strategy: `updateTag` is a Server
   * Action API, and the factory refuses such a definition at module load.
   */
  revalidate?: CacheInvalidation;
}>;

/**
 * The handler a definition produces.
 *
 * The signature is the one Next.js calls a Route Handler with. `params` is
 * `unknown` because a path segment is client-controlled text until a schema has
 * parsed it, and the handler resolves rather than throws: every outcome,
 * including a refusal, is a serialized JSON envelope.
 */
export type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<unknown> },
) => Promise<Response>;

import type * as z from "zod";

import type { ActionResult } from "@/platform/actions/action-result";
import type {
  Authorization,
  AuthorizedActor,
} from "@/platform/auth/authorization/authorization-mode";

import type { ActionContext } from "./action-context";
import type { ActionHooks } from "./action-hooks";
import type { CacheInvalidation } from "./cache-invalidation.server";

/**
 * The authorization vocabulary a Server Action declares.
 *
 * The modes are owned by the authorization module and shared with the Route
 * Handler factory, so `permission` means exactly the same thing on a form
 * submission and on an HTTP request. These aliases keep the Action-facing names
 * an Action definition already uses.
 */
export {
  AUTHORIZATION_MODE,
  AUTHORIZATION_MODES,
  type ActorAuthorization,
  type AllPermissionsAuthorization,
  type AnyPermissionAuthorization,
  type AuthorizationMode,
  type PermissionAuthorization,
  type PublicAuthorization,
} from "@/platform/auth/authorization/authorization-mode";

export type ActionAuthorization = Authorization;

export type ActionActor<TAuthorization extends ActionAuthorization> =
  AuthorizedActor<TAuthorization>;

/**
 * The use case call.
 *
 * It is the only place business logic belongs. By the time it runs, the input is
 * validated and transformed, the actor is resolved, and the capability is
 * granted; it must not repeat any of that and must not touch the transport.
 */
export type ActionExecute<TInput, TActor, TOutput> = (
  context: ActionContext<TInput, TActor>,
) => TOutput | Promise<TOutput>;

/**
 * One Server Action declaration.
 *
 * `TOutput` is inferred from `execute`, and the input type is inferred from the
 * Zod schema's output, so a definition never restates a type the schema or the
 * use case already determines.
 */
export type ActionDefinition<
  TSchema extends z.ZodType,
  TAuthorization extends ActionAuthorization,
  TOutput,
> = Readonly<{
  /** A stable identifier such as `catalog.product.create`. Logged verbatim. */
  name: string;
  input: TSchema;
  authorization: TAuthorization;
  execute: ActionExecute<
    z.output<TSchema>,
    ActionActor<TAuthorization>,
    TOutput
  >;
  hooks?: ActionHooks<z.output<TSchema>, ActionActor<TAuthorization>, TOutput>;
  /**
   * Paths and tags to invalidate after the use case succeeds. Declared here and
   * never taken from client input.
   */
  revalidate?: CacheInvalidation;
}>;

/**
 * The callable a definition produces.
 *
 * It accepts `unknown` because a Server Action's argument crosses the network and
 * is untrusted until the schema has parsed it. It resolves rather than throws:
 * every outcome is an `ActionResult`.
 */
export type ServerAction<TOutput> = (
  input: unknown,
) => Promise<ActionResult<TOutput>>;

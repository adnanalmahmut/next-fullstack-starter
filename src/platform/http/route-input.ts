import type * as z from "zod";

/**
 * What a route declares about its input, and what that declaration produces.
 *
 * These are types only. Reading the actual query and body off the wire is
 * `request-input.ts`; this module is the shape a definition promises and the
 * shape `execute` therefore receives.
 */

/**
 * The schemas a route declares for the three independent parts of a request.
 *
 * Each part is optional and each is validated on its own. A part without a
 * schema is never read: an undeclared body is not parsed, so a route that takes
 * no body cannot be slowed down or made to fail by one, and an undeclared query
 * is not even collected.
 */
export type RouteInputSchemas = Readonly<{
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}>;

/**
 * The value `execute` receives for one part.
 *
 * It is the schema's *output*, so a transform or a coercion is already applied,
 * and it is `undefined` when the route declared no schema for that part. A route
 * therefore cannot read a part it never described.
 */
export type RouteInputValue<TSchema> = TSchema extends z.ZodType
  ? z.output<TSchema>
  : undefined;

/** The three validated parts, typed from the declared schemas. */
export type RouteInputValues<TInput extends RouteInputSchemas> = Readonly<{
  params: RouteInputValue<TInput["params"]>;
  query: RouteInputValue<TInput["query"]>;
  body: RouteInputValue<TInput["body"]>;
}>;

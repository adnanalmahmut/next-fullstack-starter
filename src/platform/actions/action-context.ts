import type { PublicError } from "@/platform/errors/public-error";

/**
 * The context every Server Action step receives.
 *
 * `TActor` is resolved from the authorization mode, so a protected Action reads a
 * guaranteed `Actor` and a public Action reads `null`. Neither the raw request,
 * the headers, the cookies, nor the session token is carried here: an Action must
 * not reach the transport.
 */
export type ActionContext<TInput, TActor> = Readonly<{
  /** The stable Action identifier used in logs. Never user-facing text. */
  actionName: string;
  /** The validated, transformed input. Never the unparsed client payload. */
  input: TInput;
  actor: TActor;
  requestId?: string;
}>;

/** The context for a step that runs after the use case succeeded. */
export type ActionSuccessContext<TInput, TActor, TOutput> = Readonly<
  ActionContext<TInput, TActor> & {
    output: TOutput;
  }
>;

/**
 * The context for a step that runs after a failure.
 *
 * `input` and `actor` are nullable because a failure can happen before either
 * exists: refused validation leaves no input, and a missing actor leaves no
 * actor. `error` is the normalized public error, never the raw thrown value, so a
 * failure observer cannot read a message, a stack trace, or a provider payload.
 */
export type ActionFailureContext<TInput, TActor> = Readonly<{
  actionName: string;
  input: TInput | null;
  actor: TActor | null;
  requestId?: string;
  error: PublicError;
}>;

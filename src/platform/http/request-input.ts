import { ValidationError } from "@/shared/errors/application-error";

/**
 * Reading the untrusted parts of a request.
 *
 * Nothing here decides anything and nothing here trusts anything: these two
 * functions turn transport bytes into a plain value for a schema to judge. A
 * refusal is deliberately opaque — the thrown error carries a fixed diagnostic
 * message and nothing derived from the payload — so a `VALIDATION_FAILED`
 * response can never disclose a field name, a field value, or the input itself.
 */

/** A query value is a single string, or every value a repeated key carried. */
export type QueryRecord = Readonly<Record<string, string | readonly string[]>>;

/**
 * Collects search parameters without losing a repeated key.
 *
 * `?role=a&role=b` is a real request, and flattening it to the last value would
 * silently discard half of what the caller sent. Grouping repeated keys into an
 * array instead keeps the whole input visible to the schema, which is then free
 * to refuse it: a schema expecting a single string rejects an array rather than
 * accepting an arbitrarily chosen one of the two.
 *
 * The record has a null prototype, so a key such as `__proto__` becomes ordinary
 * data instead of reaching `Object.prototype`.
 */
export function toQueryRecord(searchParams: URLSearchParams): QueryRecord {
  const record = Object.create(null) as Record<string, string | string[]>;

  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    const [only] = values;

    record[key] = values.length === 1 && only !== undefined ? only : values;
  }

  return record;
}

/**
 * Reads the request body as JSON, exactly once.
 *
 * A body is a stream and can only be consumed one time, so this is the single
 * place a route's body is read; a route that declares no body schema never
 * reaches it. Malformed JSON, and an absent body where one was expected, are the
 * same thing to a caller: an unacceptable request.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("The request body is not acceptable.");
  }
}

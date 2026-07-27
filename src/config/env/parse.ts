import { z } from "zod";

export function parseEnvironment<TSchema extends z.ZodType>(
  scope: string,
  schema: TSchema,
  values: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(values);

  if (!result.success) {
    throw new Error(
      `Invalid ${scope} environment variables:\n${z.prettifyError(result.error)}`,
    );
  }

  return result.data;
}

import "server-only";

import { randomUUID } from "node:crypto";

export const REQUEST_ID_HEADER = "x-request-id";

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && requestIdPattern.test(value);
}

export function resolveRequestId(value: unknown): string {
  return isValidRequestId(value) ? value : randomUUID();
}

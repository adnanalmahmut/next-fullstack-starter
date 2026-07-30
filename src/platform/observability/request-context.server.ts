import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import type { RequestContext } from "./log-context";

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  callback: () => T,
): T {
  return requestContextStorage.run({ ...context }, callback);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function requireRequestContext(): RequestContext {
  const context = getRequestContext();

  if (!context) {
    throw new Error("Request context is not available.");
  }

  return context;
}

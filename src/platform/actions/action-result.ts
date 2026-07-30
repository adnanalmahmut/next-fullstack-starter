import type { PublicError } from "@/platform/errors/public-error";

export type ActionSuccess<T> = Readonly<{
  ok: true;
  data: T;
}>;

export type ActionFailure<E extends PublicError = PublicError> = Readonly<{
  ok: false;
  error: E;
}>;

export type ActionResult<T, E extends PublicError = PublicError> =
  ActionSuccess<T> | ActionFailure<E>;

export function actionSuccess<T>(data: T): ActionSuccess<T> {
  return { ok: true, data };
}

export function actionFailure<E extends PublicError>(
  error: E,
): ActionFailure<E> {
  return { ok: false, error };
}

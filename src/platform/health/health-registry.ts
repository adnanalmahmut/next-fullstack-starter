import {
  MAX_DEPENDENCY_TIMEOUT_MS,
  MIN_DEPENDENCY_TIMEOUT_MS,
  type DependencyCheck,
  type DependencyName,
} from "./dependency-check";

/**
 * The set of checks one process runs, fixed at the moment it is built.
 *
 * It is deliberately **not** a registry in the usual sense. There is no
 * `register()`, no module-level collection, no import-time side effect, and
 * nothing on `globalThis`. A mutable health registry is a specific and
 * unpleasant bug: the set of checks a probe runs would depend on which modules
 * happened to have been imported by the time the first request arrived, so the
 * same deployment could answer `ready` on one instance and `not_ready` on
 * another, and a probe running in a cold serverless invocation could check
 * fewer things than one running in a warm process. Nothing about that failure
 * announces itself.
 *
 * So a registry is a value. It is constructed by a composition function, handed
 * to a handler, and never changed. Two processes wanting different checks build
 * two registries; that is the entire extension mechanism, and it needs no
 * plugin system.
 *
 * Construction validates, because the alternative is a probe that silently
 * checks the wrong things:
 *
 * - **Non-empty.** A registry with no checks would answer `ready` without
 *   having asked anything, which is worse than answering nothing.
 * - **Unique names.** Two checks with one name would collide in the response
 *   body and one would be invisible.
 * - **Bounded timeouts.** A check with no bound, or a bound of zero, would turn
 *   a probe into either a hang or a permanent failure.
 */
export type HealthRegistry = Readonly<{
  checks: readonly DependencyCheck[];
  names: readonly DependencyName[];
}>;

export function createHealthRegistry(
  checks: readonly DependencyCheck[],
): HealthRegistry {
  if (checks.length === 0) {
    throw new Error("A health registry must declare at least one check.");
  }

  const names: DependencyName[] = [];

  for (const check of checks) {
    if (names.includes(check.name)) {
      throw new Error("A health registry must not declare a name twice.");
    }

    if (
      !Number.isInteger(check.timeoutMs) ||
      check.timeoutMs < MIN_DEPENDENCY_TIMEOUT_MS ||
      check.timeoutMs > MAX_DEPENDENCY_TIMEOUT_MS
    ) {
      throw new Error(
        "A health check must declare a bounded timeout in milliseconds.",
      );
    }

    if (typeof check.run !== "function") {
      throw new Error("A health check must declare a callable probe.");
    }

    names.push(check.name);
  }

  // Frozen rather than merely typed `readonly`: the type disappears at runtime
  // and this value is held for the lifetime of the process, so an accidental
  // `push` somewhere would change what every later probe checks.
  return Object.freeze({
    checks: Object.freeze([...checks]),
    names: Object.freeze(names),
  });
}

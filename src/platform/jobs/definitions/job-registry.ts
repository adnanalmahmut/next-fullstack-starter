import type { JobRuntime } from "./define-job";
import { jobIdentity } from "./job-identity";

/**
 * The closed set of jobs one worker knows how to run.
 *
 * A registry is built once, from a list, and is immutable afterwards. There is
 * no `register` that a module can call on import: a mutable global registry
 * makes what a worker can run depend on which files happened to be loaded, and
 * that is not something anyone can reason about at three in the morning.
 *
 * A duplicate `name.version` throws at construction — that is, at startup —
 * rather than letting the second definition quietly shadow the first.
 */
export type JobRegistryEntry = Readonly<{ runtime: JobRuntime }>;

export type JobRegistry = Readonly<{
  size: number;
  identities: readonly string[];
  names: readonly string[];
  resolve: (name: unknown, version: unknown) => JobRuntime | null;
  has: (name: unknown, version: unknown) => boolean;
  /**
   * Whether the *name* is known, whatever the version.
   *
   * It is what separates "we have never heard of this job" from "we know this
   * job but not this version of it". The two are different operational facts —
   * the first is a message from another system, the second is a message from an
   * older or newer release of this one — and they get different dead-letter
   * codes.
   */
  hasName: (name: unknown) => boolean;
}>;

export function createJobRegistry(
  definitions: readonly JobRegistryEntry[],
): JobRegistry {
  const byIdentity = new Map<string, JobRuntime>();

  for (const definition of definitions) {
    const { runtime } = definition;

    if (byIdentity.has(runtime.identity)) {
      throw new Error(
        `Duplicate job definition for ${runtime.identity}. A name and version identify exactly one job.`,
      );
    }

    byIdentity.set(runtime.identity, runtime);
  }

  const identities = [...byIdentity.keys()].sort();
  const names = [
    ...new Set([...byIdentity.values()].map((runtime) => runtime.name)),
  ].sort();

  function resolve(name: unknown, version: unknown): JobRuntime | null {
    if (typeof name !== "string" || typeof version !== "number") {
      return null;
    }

    let identity: string;

    try {
      identity = jobIdentity(name, version);
    } catch {
      // An unacceptable name or version cannot match a registered job, and the
      // caller's answer for both cases is the same: refuse to run it.
      return null;
    }

    return byIdentity.get(identity) ?? null;
  }

  return {
    size: byIdentity.size,
    identities,
    names,
    resolve,
    has: (name, version) => resolve(name, version) !== null,
    hasName: (name) => typeof name === "string" && names.includes(name),
  };
}

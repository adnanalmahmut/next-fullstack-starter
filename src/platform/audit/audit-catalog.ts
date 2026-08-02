import type { AuditActionRuntime } from "./audit-action";
import {
  isValidAuditActionName,
  isValidAuditResourceType,
} from "./audit-action";

/**
 * The set of actions a reader knows how to interpret.
 *
 * It is a value, built by a composition root and handed to the reader that needs
 * it. It is not a registry: nothing registers itself, no module has a side
 * effect on import, and there is no mutable global that the order of imports
 * could change. Two readers may hold two different catalogs, which is what makes
 * the platform testable without a process-wide reset.
 *
 * ## Reading an action the catalog has never heard of
 *
 * This is the case the design is actually for. A record is written today, the
 * module that declared its action is removed next year, and the record is still
 * in the table — that is the entire point of an audit trail. So an unknown
 * action must not make the row disappear and must not fail the page it appears
 * on.
 *
 * The rule is: keep the row, show what is safe without a definition — the
 * action name, the actor, the resource, the result, the identifiers — and
 * withhold the metadata, because metadata is the one field whose meaning lives
 * in the definition. Handing the raw JSON through instead would put an
 * unvalidated value from an unknown writer in front of an administrator.
 */
export type AuditCatalog = Readonly<{
  /** The definition for a name, or `null` when the catalog does not know it. */
  find: (name: string) => AuditActionRuntime | null;
  has: (name: string) => boolean;
  /** Declaration order, which is the documented order. */
  names: readonly string[];
}>;

/**
 * Builds an immutable catalog.
 *
 * Duplicates throw. Two definitions under one name means two different metadata
 * shapes claiming the same rows, and whichever the lookup happened to return
 * would decide what a reader sees — a coin toss decided by array order.
 */
export function createAuditCatalog(
  definitions: readonly AuditActionRuntime[],
): AuditCatalog {
  const byName = new Map<string, AuditActionRuntime>();

  for (const definition of definitions) {
    if (
      !isValidAuditActionName(definition.name) ||
      !isValidAuditResourceType(definition.resourceType)
    ) {
      throw new Error(
        `The audit catalog refuses the malformed definition "${definition.name}".`,
      );
    }

    if (byName.has(definition.name)) {
      throw new Error(
        `The audit action "${definition.name}" is declared more than once.`,
      );
    }

    byName.set(definition.name, definition);
  }

  const names = [...byName.keys()];

  return {
    find: (name) => byName.get(name) ?? null,
    has: (name) => byName.has(name),
    names,
  };
}

/** A catalog that knows nothing, for a reader that should interpret nothing. */
export const EMPTY_AUDIT_CATALOG: AuditCatalog = createAuditCatalog([]);

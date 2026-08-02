import "server-only";

import { createAuditCatalog } from "@/platform/audit/index.server";
import { IDENTITY_AUDIT_ACTIONS } from "@/platform/auth/authorization/audit/identity-audit-actions";

/**
 * The audit actions this application knows how to interpret.
 *
 * This is the composition root for the audit trail, and it lives here rather
 * than inside the platform for the reason the whole area exists: the platform
 * must not know what actions there are, and the module that declares an action
 * must not have to know about every other module's. Only the application knows
 * both, so only the application assembles the list.
 *
 * A future module adds its own definitions to this array in its own pull
 * request. Nothing else changes — not the reader, not the route, not the table,
 * and not a database enum, because an action is a constrained string rather than
 * an enum value.
 *
 * It is a module-level constant because it is a pure value with no dependency on
 * a request. Building it per request would be work repeated for no reason;
 * building it lazily would add a code path for no reason. Duplicate names throw
 * at import, which means a mistake surfaces when the server starts rather than
 * when someone opens the audit page.
 */
export const APPLICATION_AUDIT_CATALOG = createAuditCatalog([
  ...IDENTITY_AUDIT_ACTIONS,
]);

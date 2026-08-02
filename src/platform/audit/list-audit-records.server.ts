import "server-only";

import type { AuditCatalog } from "./audit-catalog";
import { decodeAuditCursor, encodeAuditCursor } from "./audit-cursor";
import type { AuditListQuery } from "./audit-query";
import { type AuditRecordDto, toAuditRecordDtos } from "./audit-record";
import { findAuditRecordPage } from "./audit-repository.server";

/**
 * One page of the audit trail.
 *
 * `nextCursor` is `null` when there is nothing after this page. There is no
 * total, no page number, and no "last page" — see `audit-query.ts` for why a
 * count is the wrong thing to offer on an append-only table.
 */
export type AuditRecordPage = Readonly<{
  records: readonly AuditRecordDto[];
  limit: number;
  nextCursor: string | null;
}>;

/**
 * Reads one bounded page, newest first.
 *
 * ## Authorization is not here
 *
 * This is the one thing worth pointing out about this function, because it looks
 * like an omission and is not. The platform is generic and must stay reachable
 * from a business module that has never heard of this application's
 * authentication; importing the permission registry here would invert the
 * dependency the whole area is built around.
 *
 * So `audit.record.read` is required by the entry points instead — declared on
 * the Route Handler, checked explicitly by the page — and both are entry points,
 * which is where an authorization decision belongs anyway. What is lost is the
 * defence in depth of a second check further in; what is gained is that a module
 * can audit without depending on `platform/auth`. A contract test asserts both
 * entry points still require the capability.
 *
 * ## Knowing whether there is another page
 *
 * It reads `limit + 1` rows and returns `limit`. The extra row is never
 * serialized; its only job is to answer "is there more?" without a second query
 * and without a count. A cursor is then built from the last row that *was*
 * returned, so the next page resumes strictly after it.
 */
export async function listAuditRecords(
  catalog: AuditCatalog,
  query: AuditListQuery,
): Promise<AuditRecordPage> {
  const cursor =
    query.cursor === undefined ? null : decodeAuditCursor(query.cursor);

  const rows = await findAuditRecordPage(query.limit + 1, cursor);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);

  return {
    records: toAuditRecordDtos(page, catalog),
    limit: query.limit,
    nextCursor:
      rows.length > query.limit && last !== undefined
        ? encodeAuditCursor({ occurredAt: last.occurredAt, id: last.id })
        : null,
  };
}

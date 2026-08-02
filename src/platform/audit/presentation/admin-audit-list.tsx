import type { ReactNode } from "react";

import type { AuditRecordDto } from "../audit-record";

/**
 * The audit trail, rendered for an administrator.
 *
 * It is generic in the same way the rest of the platform is: it knows a record
 * has an actor, an action, a resource, and a result, and it knows nothing about
 * what any particular action means. Every piece of language — the action labels,
 * the result labels, the detail line, the date format — arrives as a prop from
 * the composition root, which is the only layer that knows both the catalog and
 * the locale. That is why this component does not import `next-intl`, and why it
 * can render a module's actions in a future pull request without being touched.
 *
 * What it can render, it renders from the DTO alone. The acting session
 * identifier is not in the DTO, so it cannot appear here. Metadata that could
 * not be re-validated arrives as `null` and shows the same "no detail" text as a
 * record that never had any — a reader is told nothing rather than shown a raw
 * value.
 *
 * There is no export control, no delete control, and no edit control, because
 * the platform has no operation behind them.
 */
export type AdminAuditListCopy = Readonly<{
  caption: string;
  occurredAtHeader: string;
  actionHeader: string;
  actorHeader: string;
  resourceHeader: string;
  resultHeader: string;
  detailHeader: string;
  noDetail: string;
  emptyTitle: string;
  emptyDescription: string;
  paginationLabel: string;
}>;

type AdminAuditListProps = Readonly<{
  records: readonly AuditRecordDto[];
  copy: AdminAuditListCopy;
  /** Translated action names, keyed by the stable action name. */
  actionLabels: Readonly<Record<string, string>>;
  /** Translated actor kinds, keyed by the stable actor type. */
  actorTypeLabels: Readonly<Record<string, string>>;
  /** Translated results, keyed by the stable result. */
  resultLabels: Readonly<Record<string, string>>;
  formatDetail: (record: AuditRecordDto) => string | null;
  formatDateTime: (isoDate: string) => string;
  /**
   * The control that loads the next page, supplied only when there is one.
   *
   * A node rather than an href: a locale-aware link belongs to the routing layer,
   * and building one here would mean this component knew about `next-intl`.
   */
  nextPageLink?: ReactNode;
}>;

/**
 * An identifier, always left to right.
 *
 * A UUID rendered inside an Arabic paragraph is reordered by the bidirectional
 * algorithm around its hyphens, so it reads correctly and copies wrongly. The
 * explicit direction is what stops that.
 */
function Identifier({ value }: Readonly<{ value: string }>) {
  return (
    <span className="font-mono text-xs" dir="ltr">
      {value}
    </span>
  );
}

function AdminAuditList({
  records,
  copy,
  actionLabels,
  actorTypeLabels,
  resultLabels,
  formatDetail,
  formatDateTime,
  nextPageLink,
}: AdminAuditListProps) {
  if (records.length === 0) {
    return (
      <div
        data-slot="admin-audit-list-empty"
        className="rounded-lg border border-border p-6 text-center"
      >
        <p className="text-body font-medium">{copy.emptyTitle}</p>
        <p className="text-sm text-muted-foreground">{copy.emptyDescription}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table
          data-slot="admin-audit-list"
          className="w-full border-collapse text-start text-sm"
        >
          <caption className="sr-only">{copy.caption}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="p-3 text-start font-medium">
                {copy.occurredAtHeader}
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                {copy.actionHeader}
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                {copy.actorHeader}
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                {copy.resourceHeader}
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                {copy.resultHeader}
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                {copy.detailHeader}
              </th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => (
              <tr
                key={record.id}
                data-slot="admin-audit-row"
                data-action={record.action}
                data-result={record.result}
                className="border-b border-border last:border-b-0"
              >
                <th scope="row" className="p-3 text-start font-normal">
                  {formatDateTime(record.occurredAt)}
                </th>
                <td className="p-3">
                  {/* An action the catalog no longer knows still has a stable
                      name, and showing it is better than showing nothing. */}
                  {actionLabels[record.action] ?? record.action}
                </td>
                <td className="p-3">
                  <span className="block text-xs text-muted-foreground">
                    {actorTypeLabels[record.actor.type] ?? record.actor.type}
                  </span>
                  <Identifier value={record.actor.id} />
                </td>
                <td className="p-3">
                  <span className="block text-xs text-muted-foreground">
                    <span dir="ltr">{record.resource.type}</span>
                  </span>
                  <Identifier value={record.resource.id} />
                </td>
                <td className="p-3">
                  {resultLabels[record.result] ?? record.result}
                </td>
                <td className="p-3">{formatDetail(record) ?? copy.noDetail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {nextPageLink ? (
        <nav
          data-slot="admin-audit-pagination"
          aria-label={copy.paginationLabel}
          className="flex justify-end"
        >
          {nextPageLink}
        </nav>
      ) : null}
    </div>
  );
}

export { AdminAuditList };

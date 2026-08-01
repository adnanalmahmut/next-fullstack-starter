import type { AuthorizationAuditRecordDto } from "../audit/audit-record";

/**
 * The audit trail for the administration area.
 *
 * A record carries identifiers, an action, a request id, and an allowlisted
 * metadata value, and nothing else. The acting session identifier is not part of
 * the DTO, so it cannot be rendered here.
 */
export type AdminAuditListCopy = Readonly<{
  caption: string;
  occurredAtHeader: string;
  actionHeader: string;
  actorHeader: string;
  targetHeader: string;
  detailHeader: string;
  noDetail: string;
  emptyTitle: string;
  emptyDescription: string;
}>;

type AdminAuditListProps = Readonly<{
  records: readonly AuthorizationAuditRecordDto[];
  copy: AdminAuditListCopy;
  actionLabels: Readonly<Record<string, string>>;
  formatDetail: (record: AuthorizationAuditRecordDto) => string | null;
  formatDateTime: (isoDate: string) => string;
}>;

function AdminAuditList({
  records,
  copy,
  actionLabels,
  formatDetail,
  formatDateTime,
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
              {copy.targetHeader}
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
              className="border-b border-border last:border-b-0"
            >
              <th scope="row" className="p-3 text-start font-normal">
                {formatDateTime(record.occurredAt)}
              </th>
              <td className="p-3">
                {actionLabels[record.action] ?? record.action}
              </td>
              <td className="p-3">
                <span className="font-mono text-xs" dir="ltr">
                  {record.actorUserId}
                </span>
              </td>
              <td className="p-3">
                <span className="font-mono text-xs" dir="ltr">
                  {record.targetUserId}
                </span>
              </td>
              <td className="p-3">{formatDetail(record) ?? copy.noDetail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { AdminAuditList };

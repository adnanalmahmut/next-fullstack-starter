import type { AdminUserDto } from "../admin-user-dto";

/**
 * The user list for the administration area.
 *
 * It renders only the allowlisted DTO fields. There is no credential, token, IP
 * address, user agent, or ban metadata to render, because the DTO does not carry
 * any. Every label arrives already translated, and the table uses logical
 * alignment so it reads correctly in both directions.
 */
export type AdminUserListCopy = Readonly<{
  caption: string;
  nameHeader: string;
  emailHeader: string;
  rolesHeader: string;
  createdAtHeader: string;
  noRole: string;
  emptyTitle: string;
  emptyDescription: string;
  total: string;
}>;

type AdminUserListProps = Readonly<{
  users: readonly AdminUserDto[];
  copy: AdminUserListCopy;
  roleLabels: Readonly<Record<string, string>>;
  formatDate: (isoDate: string) => string;
}>;

function AdminUserList({
  users,
  copy,
  roleLabels,
  formatDate,
}: AdminUserListProps) {
  if (users.length === 0) {
    return (
      <div
        data-slot="admin-user-list-empty"
        className="rounded-lg border border-border p-6 text-center"
      >
        <p className="text-body font-medium">{copy.emptyTitle}</p>
        <p className="text-sm text-muted-foreground">{copy.emptyDescription}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table
          data-slot="admin-user-list"
          className="w-full border-collapse text-start text-sm"
        >
          <caption className="sr-only">{copy.caption}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="p-3 text-start font-medium">
                {copy.nameHeader}
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                {copy.emailHeader}
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                {copy.rolesHeader}
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                {copy.createdAtHeader}
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr
                key={user.id}
                data-slot="admin-user-row"
                className="border-b border-border last:border-b-0"
              >
                <th scope="row" className="p-3 text-start font-normal">
                  {user.name}
                </th>
                <td className="p-3">
                  <span className="font-mono text-xs" dir="ltr">
                    {user.email}
                  </span>
                </td>
                <td className="p-3" data-slot="admin-user-roles">
                  {user.roles.length > 0
                    ? user.roles
                        .map((role) => roleLabels[role] ?? role)
                        .join(", ")
                    : copy.noRole}
                </td>
                <td className="p-3">{formatDate(user.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground" data-slot="admin-user-total">
        {copy.total}
      </p>
    </div>
  );
}

export { AdminUserList };

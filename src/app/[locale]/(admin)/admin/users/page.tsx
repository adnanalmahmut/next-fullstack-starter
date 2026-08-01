import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import {
  getFormatter,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { getActorFromHeaders } from "@/platform/auth/authorization/actor.server";
import { parseAdminUsersQuery } from "@/platform/auth/authorization/admin-query";
import { listAdminUsers } from "@/platform/auth/authorization/admin-users.service.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { AdminAreaHeader } from "@/platform/auth/authorization/presentation/admin-area-header";
import { AdminUserList } from "@/platform/auth/authorization/presentation/admin-user-list";
import {
  AUTHORIZATION_OUTCOME,
  resolveAuthorization,
} from "@/platform/auth/authorization/require-permission.server";
import { ADMIN_ROLE, USER_ROLE } from "@/platform/auth/authorization/role";
import { StatusState } from "@/ui/patterns/status-state";

type AdminUsersPageProps = {
  params: Promise<{
    locale: string;
  }>;
};

export async function generateMetadata({
  params,
}: AdminUsersPageProps): Promise<Metadata> {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  const t = await getTranslations({
    locale,
    namespace: "Admin.users",
  });

  return {
    title: t("metadataTitle"),
    description: t("metadataDescription"),
    robots: {
      index: false,
      follow: false,
    },
  };
}

/**
 * The user list.
 *
 * The page calls the administration service directly. A Server Component must not
 * fetch the application's own Route Handler, so the query runs in process and the
 * capability is required by the same centralized helper the handler uses.
 */
export default async function AdminUsersPage({ params }: AdminUsersPageProps) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  const requestHeaders = await headers();
  const actor = await getActorFromHeaders(requestHeaders);
  const outcome = await resolveAuthorization(actor, [
    PERMISSION.IDENTITY_USER_LIST,
  ]);
  const t = await getTranslations({ locale, namespace: "Admin" });
  const authorization = await getTranslations({
    locale,
    namespace: "Authorization",
  });

  if (!actor || outcome !== AUTHORIZATION_OUTCOME.GRANTED) {
    return (
      <StatusState
        data-slot="admin-forbidden"
        status="forbidden"
        title={authorization("forbiddenTitle")}
        description={authorization("forbiddenDescription")}
      />
    );
  }

  const format = await getFormatter({ locale });
  const page = await listAdminUsers(
    { actor, headers: requestHeaders },
    parseAdminUsersQuery({}),
  );

  return (
    <>
      <AdminAreaHeader
        current="users"
        title={t("users.title")}
        description={t("users.description")}
        navigationLabel={t("navigationLabel")}
        sectionLabels={{
          dashboard: t("sections.dashboard"),
          users: t("sections.users"),
          audit: t("sections.audit"),
        }}
      />

      <AdminUserList
        users={page.users}
        roleLabels={{
          [USER_ROLE]: authorization("roles.user"),
          [ADMIN_ROLE]: authorization("roles.admin"),
        }}
        formatDate={(isoDate) =>
          format.dateTime(new Date(isoDate), { dateStyle: "medium" })
        }
        copy={{
          caption: t("users.caption"),
          nameHeader: t("users.nameHeader"),
          emailHeader: t("users.emailHeader"),
          rolesHeader: t("users.rolesHeader"),
          createdAtHeader: t("users.createdAtHeader"),
          noRole: t("users.noRole"),
          emptyTitle: t("users.emptyTitle"),
          emptyDescription: t("users.emptyDescription"),
          total: t("users.total", { count: page.total }),
        }}
      />
    </>
  );
}

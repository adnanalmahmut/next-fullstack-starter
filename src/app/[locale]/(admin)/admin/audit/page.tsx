import { Suspense } from "react";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import {
  getFormatter,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { type AppLocale } from "@/i18n/config";
import { routing } from "@/i18n/routing";
import { getActorFromHeaders } from "@/platform/auth/authorization/actor.server";
import { listAuthorizationAudit } from "@/platform/auth/authorization/admin-audit.service.server";
import { parseAdminAuditQuery } from "@/platform/auth/authorization/admin-query";
import { AUDIT_ACTION } from "@/platform/auth/authorization/audit/audit-action";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { AdminAreaHeader } from "@/platform/auth/authorization/presentation/admin-area-header";
import { AdminAuditList } from "@/platform/auth/authorization/presentation/admin-audit-list";
import {
  AUTHORIZATION_OUTCOME,
  resolveAuthorization,
} from "@/platform/auth/authorization/require-permission.server";
import { ADMIN_ROLE, USER_ROLE } from "@/platform/auth/authorization/role";
import { LoadingState } from "@/ui/patterns/loading-state";
import { StatusState } from "@/ui/patterns/status-state";

type AdminAuditPageProps = {
  params: Promise<{
    locale: string;
  }>;
};

export async function generateMetadata({
  params,
}: AdminAuditPageProps): Promise<Metadata> {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  const t = await getTranslations({
    locale,
    namespace: "Admin.audit",
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
 * The audit trail view.
 *
 * It renders the reader DTO only, so no session identifier, credential, address,
 * or user agent can appear. The metadata column is rendered from an allowlisted
 * shape and is translated here, at the presentation boundary.
 */
export default async function AdminAuditPage({ params }: AdminAuditPageProps) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  const common = await getTranslations({ locale, namespace: "Common" });

  return (
    <Suspense
      fallback={<LoadingState variant="content" label={common("loading")} />}
    >
      <AdminAuditContent locale={locale} />
    </Suspense>
  );
}

async function AdminAuditContent({ locale }: Readonly<{ locale: AppLocale }>) {
  const requestHeaders = await headers();
  const actor = await getActorFromHeaders(requestHeaders);
  const outcome = await resolveAuthorization(actor, [
    PERMISSION.IDENTITY_AUDIT_READ,
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
  const page = await listAuthorizationAudit(
    { actor, headers: requestHeaders },
    parseAdminAuditQuery({}),
  );
  const roleLabels: Readonly<Record<string, string>> = {
    [USER_ROLE]: authorization("roles.user"),
    [ADMIN_ROLE]: authorization("roles.admin"),
  };

  return (
    <>
      <AdminAreaHeader
        current="audit"
        title={t("audit.title")}
        description={t("audit.description")}
        navigationLabel={t("navigationLabel")}
        sectionLabels={{
          dashboard: t("sections.dashboard"),
          users: t("sections.users"),
          audit: t("sections.audit"),
        }}
      />

      <AdminAuditList
        records={page.records}
        actionLabels={{
          [AUDIT_ACTION.USER_ROLE_SET]: t("audit.actions.roleSet"),
          [AUDIT_ACTION.SESSION_REVOKED]: t("audit.actions.sessionsRevoked"),
        }}
        formatDetail={(record) => {
          if (record.metadata && "role" in record.metadata) {
            return t("audit.detail.role", {
              role: roleLabels[record.metadata.role] ?? record.metadata.role,
            });
          }

          return record.metadata ? t("audit.detail.scope") : null;
        }}
        formatDateTime={(isoDate) =>
          format.dateTime(new Date(isoDate), {
            dateStyle: "short",
            timeStyle: "short",
          })
        }
        copy={{
          caption: t("audit.caption"),
          occurredAtHeader: t("audit.occurredAtHeader"),
          actionHeader: t("audit.actionHeader"),
          actorHeader: t("audit.actorHeader"),
          targetHeader: t("audit.targetHeader"),
          detailHeader: t("audit.detailHeader"),
          noDetail: t("audit.noDetail"),
          emptyTitle: t("audit.emptyTitle"),
          emptyDescription: t("audit.emptyDescription"),
        }}
      />
    </>
  );
}

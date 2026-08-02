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

import { APPLICATION_AUDIT_CATALOG } from "@/app/_composition/audit-catalog";
import { type AppLocale } from "@/i18n/config";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import {
  AUDIT_ACTOR_TYPE,
  AUDIT_RESULT,
  type AuditListQuery,
  decodeAuditCursor,
  listAuditRecords,
  parseAuditListQuery,
} from "@/platform/audit/index.server";
import { AdminAuditList } from "@/platform/audit/presentation/admin-audit-list";
import { getActorFromHeaders } from "@/platform/auth/authorization/actor.server";
import {
  IDENTITY_AUDIT_ACTION,
  IDENTITY_AUDIT_RESOURCE_TYPE,
} from "@/platform/auth/authorization/audit/identity-audit-actions";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { AdminAreaHeader } from "@/platform/auth/authorization/presentation/admin-area-header";
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
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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
 * Reads the cursor out of the URL.
 *
 * The value is client-controlled, so a malformed one is a bad URL rather than a
 * server error: the page answers "not found" instead of rendering an error
 * boundary or, worse, silently paging from the beginning as though the cursor
 * had been accepted. The API answers the same input with a validation error,
 * which is the right answer there and the wrong one here.
 *
 * The cursor is decoded here and thrown away. The reader decodes it again for
 * real; doing it once at this boundary is what moves the refusal into the page
 * shell, before the streamed content that would otherwise report it as a
 * failure. (The status stays 200 regardless: the shell is partially
 * prerendered, so it has already been flushed.)
 */
function readQuery(
  searchParams: Record<string, string | string[] | undefined>,
): AuditListQuery {
  const cursor = searchParams.cursor;

  if (Array.isArray(cursor)) {
    notFound();
  }

  try {
    const query = parseAuditListQuery(cursor === undefined ? {} : { cursor });

    if (query.cursor !== undefined) {
      decodeAuditCursor(query.cursor);
    }

    return query;
  } catch {
    notFound();
  }
}

/**
 * The audit trail view.
 *
 * It renders the reader DTO only, so no session identifier, credential, address,
 * or user agent can appear. The metadata column is rendered from an allowlisted
 * shape and is translated here, at the presentation boundary, because this is
 * the only layer that knows both the action catalog and the locale.
 */
export default async function AdminAuditPage({
  params,
  searchParams,
}: AdminAuditPageProps) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  const common = await getTranslations({ locale, namespace: "Common" });
  const query = readQuery(await searchParams);

  return (
    <Suspense
      fallback={<LoadingState variant="content" label={common("loading")} />}
    >
      <AdminAuditContent locale={locale} query={query} />
    </Suspense>
  );
}

async function AdminAuditContent({
  locale,
  query,
}: Readonly<{ locale: AppLocale; query: AuditListQuery }>) {
  const requestHeaders = await headers();
  const actor = await getActorFromHeaders(requestHeaders);
  const outcome = await resolveAuthorization(actor, [
    PERMISSION.AUDIT_RECORD_READ,
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
  const page = await listAuditRecords(APPLICATION_AUDIT_CATALOG, query);
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
          [IDENTITY_AUDIT_ACTION.USER_ROLE_SET]: t("audit.actions.roleSet"),
          [IDENTITY_AUDIT_ACTION.SESSION_REVOKED]: t(
            "audit.actions.sessionsRevoked",
          ),
        }}
        actorTypeLabels={{
          [AUDIT_ACTOR_TYPE.USER]: t("audit.actorTypes.user"),
          [AUDIT_ACTOR_TYPE.SYSTEM]: t("audit.actorTypes.system"),
        }}
        resultLabels={{
          [AUDIT_RESULT.SUCCEEDED]: t("audit.results.succeeded"),
          [AUDIT_RESULT.FAILED]: t("audit.results.failed"),
          [AUDIT_RESULT.DENIED]: t("audit.results.denied"),
        }}
        formatDetail={(record) => {
          // Only an action this page knows how to describe gets a detail line. A
          // record from a module whose labels are not composed here still
          // renders, with its stable action name and no detail — and so does a
          // record whose stored metadata the platform withheld.
          if (record.resource.type !== IDENTITY_AUDIT_RESOURCE_TYPE) {
            return null;
          }

          const recordedRole = record.metadata?.role;

          if (typeof recordedRole === "string") {
            return t("audit.detail.role", {
              role: roleLabels[recordedRole] ?? recordedRole,
            });
          }

          return record.metadata?.scope === undefined
            ? null
            : t("audit.detail.scope");
        }}
        formatDateTime={(isoDate) =>
          format.dateTime(new Date(isoDate), {
            dateStyle: "short",
            timeStyle: "short",
          })
        }
        nextPageLink={
          page.nextCursor === null ? undefined : (
            <Link
              data-slot="admin-audit-next-page"
              href={{
                pathname: "/admin/audit",
                query: { cursor: page.nextCursor },
              }}
              className="text-sm font-medium underline underline-offset-4"
            >
              {t("audit.nextPage")}
            </Link>
          )
        }
        copy={{
          caption: t("audit.caption"),
          occurredAtHeader: t("audit.occurredAtHeader"),
          actionHeader: t("audit.actionHeader"),
          actorHeader: t("audit.actorHeader"),
          resourceHeader: t("audit.resourceHeader"),
          resultHeader: t("audit.resultHeader"),
          detailHeader: t("audit.detailHeader"),
          noDetail: t("audit.noDetail"),
          emptyTitle: t("audit.emptyTitle"),
          emptyDescription: t("audit.emptyDescription"),
          paginationLabel: t("audit.paginationLabel"),
        }}
      />
    </>
  );
}

import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";
import { getCurrentActor } from "@/platform/auth/authorization/actor.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import { AdminAreaHeader } from "@/platform/auth/authorization/presentation/admin-area-header";
import {
  AUTHORIZATION_OUTCOME,
  resolveAuthorization,
} from "@/platform/auth/authorization/require-permission.server";
import { StatusState } from "@/ui/patterns/status-state";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/ui/primitives/card";

type AdminPageProps = {
  params: Promise<{
    locale: string;
  }>;
};

export async function generateMetadata({
  params,
}: AdminPageProps): Promise<Metadata> {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  const t = await getTranslations({
    locale,
    namespace: "Admin.dashboard",
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
 * The administration overview.
 *
 * The page re-checks its own capability rather than relying on the layout, and it
 * renders no mutation control: changing a role or revoking sessions is done
 * through the administration API in this change.
 */
export default async function AdminPage({ params }: AdminPageProps) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  const outcome = await resolveAuthorization(await getCurrentActor(), [
    PERMISSION.IDENTITY_ADMIN_ACCESS,
  ]);
  const t = await getTranslations({ locale, namespace: "Admin" });
  const authorization = await getTranslations({
    locale,
    namespace: "Authorization",
  });

  if (outcome !== AUTHORIZATION_OUTCOME.GRANTED) {
    return (
      <StatusState
        data-slot="admin-forbidden"
        status="forbidden"
        title={authorization("forbiddenTitle")}
        description={authorization("forbiddenDescription")}
      />
    );
  }

  return (
    <>
      <AdminAreaHeader
        current="dashboard"
        title={t("dashboard.title")}
        description={t("dashboard.description")}
        navigationLabel={t("navigationLabel")}
        sectionLabels={{
          dashboard: t("sections.dashboard"),
          users: t("sections.users"),
          audit: t("sections.audit"),
        }}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card data-slot="admin-supported-operations">
          <CardHeader>
            <CardTitle>
              <h2 className="text-heading-sm font-bold">
                {t("dashboard.supportedTitle")}
              </h2>
            </CardTitle>
            <CardDescription>
              {t("dashboard.supportedDescription")}
            </CardDescription>
          </CardHeader>
        </Card>

        <Card data-slot="admin-unsupported-operations">
          <CardHeader>
            <CardTitle>
              <h2 className="text-heading-sm font-bold">
                {t("dashboard.unsupportedTitle")}
              </h2>
            </CardTitle>
            <CardDescription>
              {t("dashboard.unsupportedDescription")}
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    </>
  );
}

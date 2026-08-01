import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { getLocaleDirection } from "@/i18n/config";
import { routing } from "@/i18n/routing";
import { getCurrentActor } from "@/platform/auth/authorization/actor.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import {
  AUTHORIZATION_OUTCOME,
  resolveAuthorization,
} from "@/platform/auth/authorization/require-permission.server";
import { RETURN_TO_PARAM } from "@/platform/auth/return-to";
import { PageContainer } from "@/ui/layout/page-container";
import { StatusState } from "@/ui/patterns/status-state";

type AdminLayoutProps = Readonly<{
  children: React.ReactNode;
  params: Promise<{
    locale: string;
  }>;
}>;

/**
 * The administration area boundary.
 *
 * Access is decided here, on the server, for every request:
 *
 * - No session redirects to the localized sign-in page, carrying a safe return
 *   path.
 * - A session without the `identity.admin.access` capability renders a localized
 *   denied state and the children are never rendered.
 *
 * This is a convenience boundary, not the security boundary. Every administration
 * page re-checks its own capability, and every `/api/v1/admin` Route Handler
 * authorizes independently. The proxy plays no part in the decision, and no client
 * value is consulted.
 *
 * `forbidden()` would give a real 403 for the page itself, but it is an
 * experimental API behind the `authInterrupts` flag, which this project does not
 * enable. So the denied state renders with a 200 status. The authoritative
 * refusal is the API, which answers 403.
 */
export default async function AdminLayout({
  children,
  params,
}: AdminLayoutProps) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  const actor = await getCurrentActor();
  const outcome = await resolveAuthorization(actor, [
    PERMISSION.IDENTITY_ADMIN_ACCESS,
  ]);

  if (outcome === AUTHORIZATION_OUTCOME.UNAUTHENTICATED) {
    const returnTo = encodeURIComponent(`/${locale}/admin`);

    redirect(`/${locale}/login?${RETURN_TO_PARAM}=${returnTo}`);
  }

  const t = await getTranslations({ locale, namespace: "Authorization" });

  return (
    <main
      className="flex flex-1 flex-col bg-surface py-12"
      dir={getLocaleDirection(locale)}
    >
      <PageContainer className="flex flex-col gap-8">
        {outcome === AUTHORIZATION_OUTCOME.GRANTED ? (
          children
        ) : (
          <StatusState
            data-slot="admin-forbidden"
            status="forbidden"
            title={t("forbiddenTitle")}
            description={t("forbiddenDescription")}
          />
        )}
      </PageContainer>
    </main>
  );
}

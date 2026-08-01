import { Suspense } from "react";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { getLocaleDirection, type AppLocale } from "@/i18n/config";
import { routing } from "@/i18n/routing";
import { getCurrentActor } from "@/platform/auth/authorization/actor.server";
import { PERMISSION } from "@/platform/auth/authorization/permission-registry";
import {
  AUTHORIZATION_OUTCOME,
  resolveAuthorization,
} from "@/platform/auth/authorization/require-permission.server";
import { RETURN_TO_PARAM } from "@/platform/auth/return-to";
import { PageContainer } from "@/ui/layout/page-container";
import { LoadingState } from "@/ui/patterns/loading-state";
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
 *
 * The decision reads the session, which is request data. Under Cache Components
 * that has to happen inside a `<Suspense>` boundary, so the chrome below
 * prerenders as a static shell and only the gate — and everything it guards —
 * streams in. Nothing about the decision changes: `children` is still unreachable
 * until the capability is granted.
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

  const common = await getTranslations({ locale, namespace: "Common" });

  return (
    <main
      className="flex flex-1 flex-col bg-surface py-12"
      dir={getLocaleDirection(locale)}
    >
      <PageContainer className="flex flex-col gap-8">
        <Suspense
          fallback={
            <LoadingState variant="content" label={common("loading")} />
          }
        >
          <AdminAccessBoundary locale={locale}>{children}</AdminAccessBoundary>
        </Suspense>
      </PageContainer>
    </main>
  );
}

/**
 * The part of the boundary that depends on who is asking.
 *
 * It renders `children` only after the capability is granted, so the gate stays a
 * parent of the pages rather than something each page opts into.
 */
async function AdminAccessBoundary({
  children,
  locale,
}: Readonly<{ children: React.ReactNode; locale: AppLocale }>) {
  const actor = await getCurrentActor();
  const outcome = await resolveAuthorization(actor, [
    PERMISSION.IDENTITY_ADMIN_ACCESS,
  ]);

  if (outcome === AUTHORIZATION_OUTCOME.UNAUTHENTICATED) {
    const returnTo = encodeURIComponent(`/${locale}/admin`);

    redirect(`/${locale}/login?${RETURN_TO_PARAM}=${returnTo}`);
  }

  if (outcome === AUTHORIZATION_OUTCOME.GRANTED) {
    return children;
  }

  const t = await getTranslations({ locale, namespace: "Authorization" });

  return (
    <StatusState
      data-slot="admin-forbidden"
      status="forbidden"
      title={t("forbiddenTitle")}
      description={t("forbiddenDescription")}
    />
  );
}

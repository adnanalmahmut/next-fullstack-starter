import { Suspense } from "react";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { getLocaleDirection, type AppLocale } from "@/i18n/config";
import { routing } from "@/i18n/routing";
import { LogoutButton } from "@/platform/auth/presentation/logout-button";
import { RETURN_TO_PARAM, defaultReturnTo } from "@/platform/auth/return-to";
import {
  getCurrentSession,
  toSessionViewer,
} from "@/platform/auth/session.server";
import { PageContainer } from "@/ui/layout/page-container";
import { LoadingState } from "@/ui/patterns/loading-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/ui/primitives/card";

type AccountPageProps = {
  params: Promise<{
    locale: string;
  }>;
};

export async function generateMetadata({
  params,
}: AccountPageProps): Promise<Metadata> {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  const t = await getTranslations({
    locale,
    namespace: "Auth.account",
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

export default async function AccountPage({ params }: AccountPageProps) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  const common = await getTranslations({ locale, namespace: "Common" });

  // The session is request data, so reading it belongs inside a `<Suspense>`
  // boundary. The protection is unchanged: nothing about the account is rendered
  // until the server has resolved a session, and no session still redirects.
  return (
    <main
      className="flex flex-1 items-center bg-surface py-16"
      dir={getLocaleDirection(locale)}
    >
      <PageContainer className="max-w-md">
        <Suspense
          fallback={
            <LoadingState variant="content" label={common("loading")} />
          }
        >
          <AccountCard locale={locale} />
        </Suspense>
      </PageContainer>
    </main>
  );
}

async function AccountCard({ locale }: Readonly<{ locale: AppLocale }>) {
  // Protection is enforced here, on the server. A cookie alone is not a session.
  const viewer = toSessionViewer(await getCurrentSession());

  if (!viewer) {
    const returnTo = encodeURIComponent(defaultReturnTo(locale));

    redirect(`/${locale}/login?${RETURN_TO_PARAM}=${returnTo}`);
  }

  const t = await getTranslations({
    locale,
    namespace: "Auth.account",
  });

  return (
    <Card className="shadow-subtle">
      <CardHeader className="gap-3">
        <CardTitle>
          <h1 className="text-heading-lg font-bold tracking-tight">
            {t("title")}
          </h1>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-body" data-slot="account-name">
          {t("signedInAs", { name: viewer.name })}
        </p>
        <p
          className="font-mono text-sm text-muted-foreground"
          dir="ltr"
          data-slot="account-email"
        >
          {viewer.email}
        </p>
      </CardContent>
      <CardFooter>
        <LogoutButton
          loginPath={`/${locale}/login`}
          copy={{
            logout: t("logout"),
            loggingOut: t("loggingOut"),
            logoutError: t("logoutError"),
          }}
        />
      </CardFooter>
    </Card>
  );
}

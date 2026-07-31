import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";

import { getLocaleDirection } from "@/i18n/config";
import { routing } from "@/i18n/routing";
import { LoginForm } from "@/platform/auth/presentation/login-form";
import {
  RETURN_TO_PARAM,
  resolveSafeReturnTo,
} from "@/platform/auth/return-to";
import { getCurrentSession } from "@/platform/auth/session.server";
import { PageContainer } from "@/ui/layout/page-container";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/ui/primitives/card";

type LoginPageProps = {
  params: Promise<{
    locale: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({
  params,
}: LoginPageProps): Promise<Metadata> {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  const t = await getTranslations({
    locale,
    namespace: "Auth.login",
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

export default async function LoginPage({
  params,
  searchParams,
}: LoginPageProps) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  const requestedReturnTo = (await searchParams)[RETURN_TO_PARAM];
  const returnTo = resolveSafeReturnTo(
    typeof requestedReturnTo === "string" ? requestedReturnTo : null,
    locale,
  );

  // The server decides whether this page should be shown at all.
  if (await getCurrentSession()) {
    redirect(returnTo);
  }

  const t = await getTranslations({
    locale,
    namespace: "Auth.login",
  });

  return (
    <main
      className="flex flex-1 items-center bg-surface py-16"
      dir={getLocaleDirection(locale)}
    >
      <PageContainer className="max-w-md">
        <Card className="shadow-subtle">
          <CardHeader className="gap-3">
            <CardTitle>
              <h1 className="text-heading-lg font-bold tracking-tight">
                {t("title")}
              </h1>
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <LoginForm
              returnTo={returnTo}
              copy={{
                emailLabel: t("emailLabel"),
                emailPlaceholder: t("emailPlaceholder"),
                passwordLabel: t("passwordLabel"),
                submit: t("submit"),
                submitting: t("submitting"),
                errorTitle: t("errorTitle"),
                invalidCredentials: t("invalidCredentials"),
                unexpectedError: t("unexpectedError"),
              }}
            />
          </CardContent>
        </Card>
      </PageContainer>
    </main>
  );
}

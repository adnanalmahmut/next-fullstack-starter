import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { serverEnv } from "@/config/env/index.server";
import { getLocaleDirection } from "@/i18n/config";
import { routing } from "@/i18n/routing";
import { PageContainer } from "@/ui/layout/page-container";

import { DesignSystemShowcase } from "./showcase";
import { isDesignSystemShowcaseEnabled } from "./showcase-access";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

type DesignSystemPageProps = {
  params: Promise<{
    locale: string;
  }>;
};

export default async function DesignSystemPage({
  params,
}: DesignSystemPageProps) {
  const { locale } = await params;

  if (
    !hasLocale(routing.locales, locale) ||
    !isDesignSystemShowcaseEnabled(serverEnv.APP_ENV)
  ) {
    notFound();
  }

  setRequestLocale(locale);

  const t = await getTranslations({
    locale,
    namespace: "DesignSystem",
  });

  return (
    <main className="bg-surface py-10 sm:py-16">
      <PageContainer>
        <header className="mb-10 flex max-w-3xl flex-col gap-3">
          <p className="text-label font-medium text-primary">{t("eyebrow")}</p>
          <h1 className="text-heading-xl font-bold tracking-tight">
            {t("title")}
          </h1>
          <p className="text-body-lg text-muted-foreground">
            {t("description")}
          </p>
        </header>
        <DesignSystemShowcase direction={getLocaleDirection(locale)} />
      </PageContainer>
    </main>
  );
}

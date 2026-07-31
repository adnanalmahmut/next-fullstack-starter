import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { getLocaleDirection } from "@/i18n/config";
import { routing } from "@/i18n/routing";
import { PageContainer } from "@/ui/layout/page-container";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/ui/primitives/card";

import { LanguageSwitcher } from "./_components/language-switcher";

type HomePageProps = {
  params: Promise<{
    locale: string;
  }>;
};

export default async function HomePage({ params }: HomePageProps) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  const t = await getTranslations({
    locale,
    namespace: "Home",
  });

  return (
    <main className="flex flex-1 items-center bg-surface py-16">
      <PageContainer className="max-w-3xl">
        <Card className="shadow-subtle">
          <CardHeader className="gap-4 px-8 pt-4 sm:px-12 sm:pt-8">
            <p className="text-label font-medium text-muted-foreground uppercase">
              Next.js 16 · next-intl
            </p>

            <CardTitle>
              <h1 className="text-heading-xl font-bold tracking-tight">
                {t("title")}
              </h1>
            </CardTitle>
            <CardDescription className="max-w-2xl text-body-lg">
              {t("description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-8 pb-4 sm:px-12 sm:pb-8">
            <LanguageSwitcher direction={getLocaleDirection(locale)} />
          </CardContent>
        </Card>
      </PageContainer>
    </main>
  );
}

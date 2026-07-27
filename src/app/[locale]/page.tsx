import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import { routing } from "@/i18n/routing";

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
    <main className="flex flex-1 items-center justify-center bg-zinc-50 px-6 py-16 dark:bg-black">
      <section className="flex w-full max-w-3xl flex-col gap-8 rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm sm:p-12 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="space-y-4">
          <p className="text-sm font-medium text-zinc-500 uppercase dark:text-zinc-400">
            Next.js 16 · next-intl
          </p>

          <h1 className="text-4xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
            {t("title")}
          </h1>

          <p className="max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-400">
            {t("description")}
          </p>
        </div>

        <LanguageSwitcher />
      </section>
    </main>
  );
}

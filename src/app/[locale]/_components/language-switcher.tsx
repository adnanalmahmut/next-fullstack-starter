"use client";

import { useLocale, useTranslations } from "next-intl";
import type { ChangeEvent } from "react";
import { useTransition } from "react";

import { i18nConfig, type AppLocale } from "@/i18n/config";
import { usePathname, useRouter } from "@/i18n/navigation";

const localeLabelKeys = {
  ar: "arabic",
  en: "english",
} as const;

export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations("Home");
  const pathname = usePathname();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleLocaleChange(event: ChangeEvent<HTMLSelectElement>) {
    const nextLocale = event.target.value as AppLocale;

    if (nextLocale === locale) {
      return;
    }

    startTransition(() => {
      const suffix = `${window.location.search}${window.location.hash}`;

      router.replace(`${pathname}${suffix}`, {
        locale: nextLocale,
      });
    });
  }

  return (
    <label className="flex items-center gap-3 text-sm font-medium">
      <span>{t("languageLabel")}</span>

      <select
        name="locale"
        value={locale}
        disabled={isPending}
        onChange={handleLocaleChange}
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-950 disabled:cursor-wait disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
      >
        {i18nConfig.locales.map((supportedLocale) => (
          <option key={supportedLocale} value={supportedLocale}>
            {t(localeLabelKeys[supportedLocale])}
          </option>
        ))}
      </select>
    </label>
  );
}

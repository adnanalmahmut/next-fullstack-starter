"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";

import { i18nConfig, type AppLocale } from "@/i18n/config";
import { usePathname, useRouter } from "@/i18n/navigation";
import { Field, FieldLabel } from "@/ui/primitives/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";

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

  function handleLocaleChange(nextLocale: AppLocale) {
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
    <Field orientation="responsive" data-disabled={isPending}>
      <FieldLabel htmlFor="locale-select">{t("languageLabel")}</FieldLabel>
      <Select
        name="locale"
        value={locale}
        disabled={isPending}
        onValueChange={(value) => handleLocaleChange(value as AppLocale)}
      >
        <SelectTrigger id="locale-select" className="min-w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {i18nConfig.locales.map((supportedLocale) => (
              <SelectItem key={supportedLocale} value={supportedLocale}>
                {t(localeLabelKeys[supportedLocale])}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

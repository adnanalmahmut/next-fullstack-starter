import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { extname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isDesignSystemShowcaseEnabled } from "@/app/[locale]/(development)/design-system/showcase-access";

const projectRoot = process.cwd();
const uiRoot = resolve(projectRoot, "src/ui");

const requiredColorTokens = [
  "background",
  "foreground",
  "surface",
  "surface-elevated",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "info",
  "info-foreground",
] as const;

function readProjectFile(filePath: string) {
  return readFileSync(resolve(projectRoot, filePath), "utf8");
}

function filesWithin(
  directory: string,
  entries: Dirent[] = readdirSync(directory, { withFileTypes: true }),
): string[] {
  return entries.flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);

    return entry.isDirectory() ? filesWithin(entryPath) : [entryPath];
  });
}

function cssBlock(source: string, selector: string) {
  const start = source.indexOf(`${selector} {`);

  if (start === -1) {
    return "";
  }

  let depth = 0;

  for (
    let index = source.indexOf("{", start);
    index < source.length;
    index += 1
  ) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return "";
}

function tokenNames(block: string) {
  return new Set(
    [...block.matchAll(/^\s+--([a-z0-9-]+):/gm)].map((match) => match[1]),
  );
}

function translationKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [prefix];
  }

  return Object.entries(value).flatMap(([key, child]) =>
    translationKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("design system contracts", () => {
  it("defines complete matching light and dark semantic color tokens", () => {
    const css = readProjectFile("src/app/globals.css");
    const lightTokens = tokenNames(cssBlock(css, ":root"));
    const darkTokens = tokenNames(cssBlock(css, ".dark"));

    for (const token of requiredColorTokens) {
      expect(lightTokens.has(token), `missing light token --${token}`).toBe(
        true,
      );
      expect(darkTokens.has(token), `missing dark token --${token}`).toBe(true);
    }

    const lightColors = [...lightTokens].filter((token) =>
      requiredColorTokens.includes(
        token as (typeof requiredColorTokens)[number],
      ),
    );
    const darkColors = [...darkTokens].filter((token) =>
      requiredColorTokens.includes(
        token as (typeof requiredColorTokens)[number],
      ),
    );

    expect(darkColors.sort()).toEqual(lightColors.sort());
  });

  it("defines typography, focus, motion, layout, and explicit direction policies", () => {
    const css = readProjectFile("src/app/globals.css");

    for (const token of [
      "--font-geist-sans",
      "--font-noto-sans-arabic",
      "--font-geist-mono",
      "--focus-ring-width",
      "--focus-ring-color",
      "--motion-duration-fast",
      "--motion-ease",
      "--page-max-width",
      "--page-padding-inline",
      "--layer-overlay-control",
      "--layer-overlay-backdrop",
      "--layer-overlay",
      "--layer-toast",
    ]) {
      expect(css).toContain(token);
    }

    const toaster = readProjectFile("src/ui/primitives/sonner.tsx");

    expect(toaster).toContain('zIndex: "var(--layer-toast)"');

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("[data-directional]");
    expect(css).toContain('html[dir="rtl"] [data-directional]');
    expect(css).not.toMatch(/html\[dir=["']rtl["']\]\s+svg/);
  });

  it("keeps reusable UI free of raw palette and physical direction utilities", () => {
    const source = filesWithin(uiRoot)
      .filter((filePath) => [".ts", ".tsx"].includes(extname(filePath)))
      .map((filePath) => readFileSync(filePath, "utf8"))
      .join("\n");
    const rawPalette =
      /(?:bg|text|border|ring)-(?:red|blue|green|yellow|orange|purple|pink|zinc|slate|gray|neutral|stone)-\d+/;
    const physicalDirection =
      /(?:^|[\s"'])(?:(?:m|p)[lr]-|left-|right-|text-left|text-right)/;
    const numericZIndex = /(?:^|[\s"'`])z-(?:\d+|\[\d+\])(?=$|[\s"'`])/m;

    expect(source).not.toMatch(rawPalette);
    expect(source).not.toMatch(physicalDirection);
    expect(source).not.toMatch(numericZIndex);
    expect(source).not.toContain("dark:");
  });

  it("uses the internal overlay control layer for both Select scroll controls", () => {
    const select = readProjectFile("src/ui/primitives/select.tsx");
    const scrollUp =
      select.match(/function SelectScrollUpButton[\s\S]*?\n}\n/)?.[0] ?? "";
    const scrollDown =
      select.match(/function SelectScrollDownButton[\s\S]*?\n}\n/)?.[0] ?? "";
    const semanticLayer = "z-[var(--layer-overlay-control)]";

    expect(scrollUp).toContain(semanticLayer);
    expect(scrollDown).toContain(semanticLayer);
    expect(select.match(/z-\[var\(--layer-overlay-control\)\]/g)).toHaveLength(
      2,
    );
  });

  it("keeps the UI layer client-safe, presentation-only, and directly imported", () => {
    const sourceFiles = filesWithin(uiRoot).filter((filePath) =>
      [".ts", ".tsx"].includes(extname(filePath)),
    );
    const restricted =
      /(?:from\s+|import\s*)["'](?:@prisma|prisma|pino|server-only|better-auth|@\/config\/env|@\/platform\/database)/;

    for (const filePath of sourceFiles) {
      const source = readFileSync(filePath, "utf8");

      expect(source, filePath).not.toMatch(restricted);
      expect(source, filePath).not.toMatch(/\bprocess\.env\b/);
      expect(source, filePath).not.toMatch(
        /\bconsole\.(?:log|info|warn|error|debug)\b/,
      );
      expect(source, filePath).not.toMatch(/from\s+["']@\/ui["']/);
      expect(source, filePath).not.toMatch(/next-intl|@\/i18n/);
    }

    expect(
      sourceFiles.filter((filePath) => /\/index\.(?:ts|tsx)$/.test(filePath)),
    ).toEqual([]);
  });

  it("keeps Arabic and English DesignSystem translation keys identical", () => {
    const english = JSON.parse(readProjectFile("messages/en.json")) as Record<
      string,
      unknown
    >;
    const arabic = JSON.parse(readProjectFile("messages/ar.json")) as Record<
      string,
      unknown
    >;

    expect(translationKeys(arabic.DesignSystem).sort()).toEqual(
      translationKeys(english.DesignSystem).sort(),
    );
  });

  it("gates the showcase with validated configuration and disables indexing", () => {
    const page = readProjectFile(
      "src/app/[locale]/(development)/design-system/page.tsx",
    );

    expect(isDesignSystemShowcaseEnabled("development")).toBe(true);
    expect(isDesignSystemShowcaseEnabled("test")).toBe(true);
    expect(isDesignSystemShowcaseEnabled("staging")).toBe(false);
    expect(isDesignSystemShowcaseEnabled("production")).toBe(false);
    expect(page).toContain('from "@/config/env/index.server"');
    expect(page).toContain("serverEnv.APP_ENV");
    expect(page).not.toContain("process.env");
    expect(page).toMatch(/index:\s*false/);
    expect(page).toMatch(/follow:\s*false/);
  });

  it("does not expose the development showcase in public navigation", () => {
    const publicFiles = [
      "src/app/[locale]/layout.tsx",
      "src/app/[locale]/page.tsx",
      "src/app/[locale]/_components/language-switcher.tsx",
    ];

    for (const filePath of publicFiles) {
      expect(readProjectFile(filePath)).not.toMatch(
        /(?:href|replace|push)\s*[=(].*design-system/,
      );
    }
  });

  it("keeps primitive copy caller-controlled", () => {
    const primitiveSource = filesWithin(resolve(uiRoot, "primitives"))
      .filter((filePath) => [".ts", ".tsx"].includes(extname(filePath)))
      .map((filePath) => readFileSync(filePath, "utf8"))
      .join("\n");

    expect(primitiveSource).not.toMatch(
      />\s*(?:Close|Loading|Cancel|Delete)\s*</,
    );
  });
});

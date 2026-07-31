import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { extname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isDesignSystemShowcaseEnabled } from "@/app/[locale]/(development)/design-system/showcase-access";

const projectRoot = process.cwd();
const appRoot = resolve(projectRoot, "src/app");
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
  it("centralizes the exact local font files, weights, and loading policy", () => {
    const fonts = readProjectFile("src/app/fonts.ts");
    const fontFiles = readdirSync(resolve(appRoot, "fonts")).sort();
    const sans =
      fonts.match(/const thmanyahSans = localFont\(\{[\s\S]*?\n\}\);/)?.[0] ??
      "";
    const serif =
      fonts.match(
        /const thmanyahSerifDisplay = localFont\(\{[\s\S]*?\n\}\);/,
      )?.[0] ?? "";
    const mono =
      fonts.match(/const geistMono = Geist_Mono\(\{[\s\S]*?\n\}\);/)?.[0] ?? "";

    expect(fontFiles).toEqual([
      "thmanyah-sans-bold.woff2",
      "thmanyah-sans-medium.woff2",
      "thmanyah-sans-regular.woff2",
      "thmanyah-serif-display-black.woff2",
      "thmanyah-serif-display-bold.woff2",
    ]);
    expect(fonts).toContain('import localFont from "next/font/local"');
    expect(fonts).toContain('import { Geist_Mono } from "next/font/google"');
    expect(fonts.match(/localFont\(\{/g)).toHaveLength(2);

    for (const [file, weight] of [
      ["thmanyah-sans-regular.woff2", "400"],
      ["thmanyah-sans-medium.woff2", "500"],
      ["thmanyah-sans-bold.woff2", "700"],
    ]) {
      expect(sans).toMatch(
        new RegExp(`path: "\\./fonts/${file}"[\\s\\S]*?weight: "${weight}"`),
      );
    }

    for (const [file, weight] of [
      ["thmanyah-serif-display-bold.woff2", "700"],
      ["thmanyah-serif-display-black.woff2", "900"],
    ]) {
      expect(serif).toMatch(
        new RegExp(`path: "\\./fonts/${file}"[\\s\\S]*?weight: "${weight}"`),
      );
    }

    expect(sans).toContain('variable: "--font-thmanyah-sans"');
    expect(sans).toContain('display: "swap"');
    expect(sans).toContain("preload: true");
    expect(sans).toContain('fallback: ["Arial", "sans-serif"]');
    expect(sans).toContain('adjustFontFallback: "Arial"');
    expect(serif).toContain('variable: "--font-thmanyah-serif-display"');
    expect(serif).toContain('display: "swap"');
    expect(serif).toContain("preload: false");
    expect(serif).toContain('fallback: ["Times New Roman", "serif"]');
    expect(serif).toContain('adjustFontFallback: "Times New Roman"');
    expect(mono).toContain('variable: "--font-geist-mono"');
    expect(mono).toContain('subsets: ["latin"]');
    expect(mono).toContain('display: "swap"');
    expect(fonts.match(/style: "normal"/g)).toHaveLength(5);
  });

  it("applies centralized font variables without direction-specific families", () => {
    const layout = readProjectFile("src/app/[locale]/layout.tsx");
    const css = readProjectFile("src/app/globals.css");
    const appSources = filesWithin(appRoot)
      .filter((filePath) => [".ts", ".tsx"].includes(extname(filePath)))
      .filter((filePath) => !filePath.endsWith("/fonts.ts"))
      .map((filePath) => readFileSync(filePath, "utf8"))
      .join("\n");

    expect(layout).toContain('from "@/app/fonts"');
    expect(layout).toContain("thmanyahSans.variable");
    expect(layout).toContain("thmanyahSerifDisplay.variable");
    expect(layout).toContain("geistMono.variable");
    expect(layout).not.toMatch(/Geist(?:_Mono)?|Noto_Sans_Arabic|localFont/);
    expect(appSources).not.toMatch(
      /from\s+["']next\/font\/(?:google|local)["']/,
    );

    expect(css).toContain("--font-sans: var(--font-thmanyah-sans)");
    expect(css).toContain("--font-heading: var(--font-thmanyah-sans)");
    expect(css).toContain("--font-display: var(--font-thmanyah-serif-display)");
    expect(css).toContain("--font-mono: var(--font-geist-mono)");
    expect(css).toContain("font-synthesis: none");
    expect(css).not.toMatch(
      /--font-application-sans|--font-geist-sans|--font-noto-sans-arabic/,
    );
    expect(css).not.toMatch(/@font-face|@import\s+url\(/);
  });

  it("uses only supported interface weights and reserves black for display", () => {
    const sourceFiles = [
      ...filesWithin(appRoot),
      ...filesWithin(uiRoot),
    ].filter((filePath) => [".ts", ".tsx"].includes(extname(filePath)));
    const unsupportedWeight =
      /\bfont-(?:thin|extralight|light|semibold|extrabold)\b/;

    for (const filePath of sourceFiles) {
      const source = readFileSync(filePath, "utf8");

      expect(source, filePath).not.toMatch(unsupportedWeight);

      for (const className of source.matchAll(/className="([^"]+)"/g)) {
        if (className[1].split(/\s+/).includes("font-black")) {
          expect(className[1], filePath).toMatch(/\bfont-display\b/);
        }
      }
    }
  });

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
      "--font-thmanyah-sans",
      "--font-thmanyah-serif-display",
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
    expect(css).not.toMatch(/(^|[\s,>])svg\s*\{[^}]*(?:scaleX|rotate)/);
    expect(css).not.toMatch(/\[dir=["']rtl["']\][^{]*\bsvg\b/);
  });

  it("aligns Select and DropdownMenu with logical direction utilities only", () => {
    const select = readProjectFile("src/ui/primitives/select.tsx");
    const dropdown = readProjectFile("src/ui/primitives/dropdown-menu.tsx");
    const memberClasses = (source: string, member: string) =>
      source.match(new RegExp(`function ${member}\\([\\s\\S]*?\\n}\\n`))?.[0] ??
      "";

    for (const [source, member] of [
      [select, "SelectItem"],
      [select, "SelectLabel"],
      [dropdown, "DropdownMenuItem"],
      [dropdown, "DropdownMenuLabel"],
      [dropdown, "DropdownMenuCheckboxItem"],
      [dropdown, "DropdownMenuRadioItem"],
      [dropdown, "DropdownMenuSubTrigger"],
    ] as const) {
      expect(memberClasses(source, member), member).toContain("text-start");
    }

    // Selected/checked indicators sit at the logical end, never a physical side.
    expect(memberClasses(select, "SelectItem")).toContain("absolute end-2");
    expect(memberClasses(dropdown, "DropdownMenuCheckboxItem")).toContain(
      "absolute end-2",
    );
    expect(memberClasses(dropdown, "DropdownMenuRadioItem")).toContain(
      "absolute end-2",
    );
    expect(memberClasses(dropdown, "DropdownMenuShortcut")).toContain(
      "ms-auto",
    );

    // Only the submenu chevron mirrors, through the explicit directional marker.
    expect(memberClasses(dropdown, "DropdownMenuSubTrigger")).toMatch(
      /<DirectionalIcon[\s\S]*?<ChevronRightIcon/,
    );
    expect(dropdown).not.toMatch(/rotate-180|scale-x-/);
    expect(select).not.toMatch(/rotate-180|scale-x-/);
  });

  it("provides explicit direction to interactive Radix roots from the presentation boundary", () => {
    const presentationUsages = [
      "src/app/[locale]/(development)/design-system/showcase.tsx",
      "src/app/[locale]/_components/language-switcher.tsx",
    ];

    for (const filePath of presentationUsages) {
      const source = readProjectFile(filePath);
      const roots = [
        ...source.matchAll(/<(Select|DropdownMenu)(?=[\s>])([^>]*)>/g),
      ];

      expect(roots.length, filePath).toBeGreaterThan(0);

      for (const [, root, attributes] of roots) {
        expect(attributes, `${filePath} <${root}>`).toMatch(/\bdir=\{/);
      }

      expect(source, filePath).toMatch(/direction[?]?:\s*"rtl"\s*\|\s*"ltr"/);
    }

    // Direction is resolved from the locale at the server boundary, not guessed
    // in the browser, and reusable primitives stay locale-agnostic.
    for (const filePath of [
      "src/app/[locale]/(development)/design-system/page.tsx",
      "src/app/[locale]/page.tsx",
    ]) {
      const source = readProjectFile(filePath);

      expect(source, filePath).toContain("getLocaleDirection(locale)");
      expect(source, filePath).toContain('from "@/i18n/config"');
    }

    for (const filePath of filesWithin(resolve(uiRoot, "primitives"))) {
      expect(readFileSync(filePath, "utf8"), filePath).not.toMatch(
        /document\.(?:dir|documentElement)/,
      );
    }
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

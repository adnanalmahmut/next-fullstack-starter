import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

type LintMessage = Awaited<
  ReturnType<ESLint["lintText"]>
>[number]["messages"][number];

const layerBoundaryRule = "no-restricted-imports";
const layerGlobalRule = "no-restricted-globals";
const clientBoundaryRule = "architecture/no-client-server-boundaries";
const serverMarkerRule = "architecture/require-server-only";

const architectureRuleIds = new Set([
  layerBoundaryRule,
  layerGlobalRule,
  clientBoundaryRule,
  serverMarkerRule,
]);

let eslint: ESLint;

async function lintArchitecture(
  code: string,
  filePath: string,
): Promise<LintMessage[]> {
  const [result] = await eslint.lintText(code, {
    filePath,
    warnIgnored: true,
  });

  if (!result) {
    throw new Error(`ESLint returned no result for ${filePath}`);
  }

  return result.messages.filter(({ ruleId }) =>
    architectureRuleIds.has(ruleId ?? ""),
  );
}

function expectArchitectureError(
  messages: LintMessage[],
  ruleId: string,
  messageFragment: string,
) {
  const matchingMessage = messages.find(
    ({ ruleId: actualRuleId, severity, message }) =>
      actualRuleId === ruleId &&
      severity === 2 &&
      message.includes(messageFragment),
  );

  expect(matchingMessage).toBeDefined();
}

describe("ESLint architecture contract", () => {
  beforeAll(async () => {
    eslint = new ESLint({
      cwd: process.cwd(),
    });

    // Resolving the flat config and building the type-aware program is a
    // one-time cost paid on the first lint. Warming it up here keeps it out
    // of whichever case happens to lint first.
    await eslint.lintText("export const warmUp = true;\n", {
      filePath: "src/modules/contract_fixture/domain/warm-up.ts",
      warnIgnored: true,
    });
  }, 20_000);

  describe("layer boundaries", () => {
    it.each([
      {
        name: "domain may import stable shared primitives",
        filePath: "src/modules/contract_fixture/domain/allowed.ts",
        code: `
          import { sharedValue } from "@/shared/value";

          export const domainValue = sharedValue;
        `,
      },
      {
        name: "application may import its own domain",
        filePath: "src/modules/contract_fixture/application/allowed.ts",
        code: `
          import { domainValue } from "../domain/value";

          export const applicationValue = domainValue;
        `,
      },
      {
        name: "infrastructure may access the database platform",
        filePath: "src/modules/contract_fixture/infrastructure/allowed.ts",
        code: `
          import "server-only";

          import { database } from "@/platform/database/index.server";

          export const infrastructureValue = database;
        `,
      },
      {
        name: "infrastructure may import the PostgreSQL driver",
        filePath: "src/modules/contract_fixture/infrastructure/postgres.ts",
        code: `
          import "server-only";

          import { Pool } from "pg";

          export const poolConstructor = Pool;
        `,
      },
      {
        name: "presentation may use application code and React",
        filePath: "src/modules/contract_fixture/presentation/allowed.tsx",
        code: `
          import type { ReactNode } from "react";

          import { applicationValue } from "../application/value";

          export const presentationValue: ReactNode =
            applicationValue;
        `,
      },
      {
        name: "presentation may use client-safe configuration",
        filePath: "src/modules/contract_fixture/presentation/public-config.ts",
        code: `
          import {
            publicEnv,
          } from "@/config/env/index.client";

          export const appUrl =
            publicEnv.NEXT_PUBLIC_APP_URL;
        `,
      },
    ])("allows: $name", async ({ code, filePath }) => {
      const messages = await lintArchitecture(code, filePath);

      const layerMessages = messages.filter(
        ({ ruleId }) => ruleId === layerBoundaryRule,
      );

      expect(layerMessages).toEqual([]);
    });

    it.each([
      {
        name: "domain importing Next.js",
        filePath: "src/modules/contract_fixture/domain/forbidden-next.ts",
        code: `
          import { cookies } from "next/headers";

          export const value = cookies;
        `,
        message: "Next.js APIs are not allowed",
      },
      {
        name: "domain importing the PostgreSQL driver",
        filePath: "src/modules/contract_fixture/domain/forbidden-postgres.ts",
        code: `
          import { Pool } from "pg";

          export const value = Pool;
        `,
        message: "PostgreSQL driver access is restricted to infrastructure",
      },
      {
        name: "domain importing application code",
        filePath:
          "src/modules/contract_fixture/domain/forbidden-application.ts",
        code: `
          export { value } from "../application/value";
        `,
        message: "Domain code must not depend on application",
      },
      {
        name: "application accessing the database",
        filePath:
          "src/modules/contract_fixture/application/forbidden-database.ts",
        code: `
          import { database } from "@/platform/database/index.server";

          export const value = database;
        `,
        message: "Direct database access is restricted to infrastructure",
      },
      {
        name: "application importing the PostgreSQL driver",
        filePath:
          "src/modules/contract_fixture/application/forbidden-postgres.ts",
        code: `
          import { Pool } from "pg";

          export const value = Pool;
        `,
        message: "PostgreSQL driver access is restricted to infrastructure",
      },
      {
        name: "application importing infrastructure",
        filePath:
          "src/modules/contract_fixture/application/forbidden-infrastructure.ts",
        code: `
          import { adapter } from "../infrastructure/adapter";

          export const value = adapter;
        `,
        message: "Application code must not depend on infrastructure",
      },
      {
        name: "infrastructure importing React",
        filePath:
          "src/modules/contract_fixture/infrastructure/forbidden-react.ts",
        code: `
          import "server-only";

          import { createElement } from "react";

          export const value = createElement;
        `,
        message: "React APIs are not allowed in this architectural layer",
      },
      {
        name: "infrastructure importing presentation",
        filePath:
          "src/modules/contract_fixture/infrastructure/forbidden-presentation.ts",
        code: `
          import "server-only";

          import { presenter } from "../presentation/presenter";

          export const value = presenter;
        `,
        message: "Infrastructure code must not depend on presentation",
      },
      {
        name: "presentation accessing the database",
        filePath:
          "src/modules/contract_fixture/presentation/forbidden-database.ts",
        code: `
          import { database } from "@/platform/database/index.server";

          export const value = database;
        `,
        message: "Direct database access is restricted to infrastructure",
      },
      {
        name: "presentation importing the PostgreSQL driver",
        filePath:
          "src/modules/contract_fixture/presentation/forbidden-postgres.ts",
        code: `
          import { Pool } from "pg";

          export const value = Pool;
        `,
        message: "PostgreSQL driver access is restricted to infrastructure",
      },
      {
        name: "presentation importing server configuration",
        filePath:
          "src/modules/contract_fixture/presentation/forbidden-server-config.ts",
        code: `
          import {
            serverEnv,
          } from "@/config/env/index.server";

          export const value = serverEnv;
        `,
        message:
          "Presentation code must not access server environment configuration",
      },
      {
        name: "presentation importing infrastructure",
        filePath:
          "src/modules/contract_fixture/presentation/forbidden-infrastructure.ts",
        code: `
          import { adapter } from "../infrastructure/adapter";

          export const value = adapter;
        `,
        message: "Presentation code must use application use cases",
      },
    ])("rejects: $name", async ({ code, filePath, message }) => {
      const messages = await lintArchitecture(code, filePath);

      expectArchitectureError(messages, layerBoundaryRule, message);
    });

    it.each([
      {
        name: "domain reading process environment",
        filePath: "src/modules/contract_fixture/domain/environment.ts",
        code: `
          export const value = process.env.DATABASE_URL;
        `,
        message: "Domain code must not access process",
      },
      {
        name: "application reading process environment",
        filePath: "src/modules/contract_fixture/application/environment.ts",
        code: `
          export const value = process.env.DATABASE_URL;
        `,
        message: "Application code must not access process",
      },
      {
        name: "infrastructure reading process environment",
        filePath: "src/modules/contract_fixture/infrastructure/environment.ts",
        code: `
          import "server-only";

          export const value = process.env.DATABASE_URL;
        `,
        message: "Infrastructure code must use validated configuration",
      },
      {
        name: "presentation reading process environment",
        filePath: "src/modules/contract_fixture/presentation/environment.ts",
        code: `
          export const value = process.env.DATABASE_URL;
        `,
        message: "Presentation code must use controlled configuration",
      },
    ])("rejects: $name", async ({ code, filePath, message }) => {
      const messages = await lintArchitecture(code, filePath);

      expectArchitectureError(messages, layerGlobalRule, message);
    });

    it.each([
      {
        name: "domain escaping to platform",
        filePath: "src/modules/contract_fixture/domain/platform.ts",
        code: `
          export {
            database,
          } from "../../../platform/database/index.server";
        `,
        message: "Domain code must not escape its layer",
      },
      {
        name: "application escaping to platform",
        filePath: "src/modules/contract_fixture/application/platform.ts",
        code: `
          export {
            database,
          } from "../../../platform/database/index.server";
        `,
        message: "Application code must not escape its layer",
      },
      {
        name: "infrastructure escaping to UI",
        filePath: "src/modules/contract_fixture/infrastructure/ui.ts",
        code: `
          import "server-only";

          export {
            Button,
          } from "../../../ui/button";
        `,
        message:
          "Infrastructure code must not reach routing, UI, or translations",
      },
      {
        name: "presentation escaping to database",
        filePath: "src/modules/contract_fixture/presentation/database.ts",
        code: `
          export {
            database,
          } from "../../../platform/database/index.server";
        `,
        message: "Presentation code must not reach environment or persistence",
      },
    ])("rejects: $name", async ({ code, filePath, message }) => {
      const messages = await lintArchitecture(code, filePath);

      expectArchitectureError(messages, layerBoundaryRule, message);
    });
  });

  describe("proxy boundaries", () => {
    it.each([
      {
        name: "the pipeline may use request APIs and locale routing",
        filePath: "src/platform/proxy/steps/contract-fixture.ts",
        code: `
          import createMiddleware from "next-intl/middleware";
          import { NextResponse } from "next/server";

          import { routing } from "@/i18n/routing";

          export const value = [createMiddleware, NextResponse, routing];
        `,
      },
      {
        name: "the composition root may use the pipeline",
        filePath: "src/proxy.ts",
        code: `
          import type { NextRequest } from "next/server";

          import { runRequestPipeline } from "./platform/proxy/compose";

          export function proxy(request: NextRequest) {
            return runRequestPipeline(request);
          }
        `,
      },
    ])("allows: $name", async ({ code, filePath }) => {
      const messages = await lintArchitecture(code, filePath);

      const layerMessages = messages.filter(
        ({ ruleId }) => ruleId === layerBoundaryRule,
      );

      expect(layerMessages).toEqual([]);
    });

    it.each([
      {
        name: "pipeline importing Prisma",
        filePath: "src/platform/proxy/contract-fixture-prisma.ts",
        code: `
          export { PrismaClient } from "@prisma/client";
        `,
        message: "Prisma access is restricted to infrastructure adapters",
      },
      {
        name: "pipeline importing the database platform",
        filePath: "src/platform/proxy/contract-fixture-database.ts",
        code: `
          export { database } from "@/platform/database/index.server";
        `,
        message: "Direct database access is restricted to infrastructure",
      },
      {
        name: "pipeline importing Redis",
        filePath: "src/platform/proxy/contract-fixture-redis.ts",
        code: `
          export { Redis } from "ioredis";
        `,
        message: "Redis access is restricted to infrastructure adapters",
      },
      {
        name: "pipeline importing a queue client",
        filePath: "src/platform/proxy/contract-fixture-queue.ts",
        code: `
          export { Queue } from "bullmq";
        `,
        message: "Queue access is restricted to infrastructure adapters",
      },
      {
        name: "pipeline importing a business module",
        filePath: "src/platform/proxy/contract-fixture-module.ts",
        code: `
          export { value } from "@/modules/contract_fixture/index.server";
        `,
        message: "must not depend on business modules",
      },
      {
        name: "composition root importing Better Auth",
        filePath: "src/proxy.ts",
        code: `
          export { betterAuth } from "better-auth";
        `,
        message:
          "Better Auth must not be accessed from this architectural layer",
      },
    ])("rejects: $name", async ({ code, filePath, message }) => {
      const messages = await lintArchitecture(code, filePath);

      expectArchitectureError(messages, layerBoundaryRule, message);
    });
  });

  describe("client and server boundaries", () => {
    it.each([
      {
        name: "client module importing React",
        code: `
          "use client";

          import { useState } from "react";

          export const useValue = () => useState("");
        `,
      },
      {
        name: "client module reading a public environment variable",
        code: `
          "use client";

          export const appUrl =
            process.env.NEXT_PUBLIC_APP_URL;
        `,
      },
      {
        name: "server module using Node.js and private environment variables",
        code: `
          import { readFile } from "node:fs/promises";

          export const readPackage = () =>
            readFile("package.json", "utf8");

          export const databaseUrl =
            process.env.DATABASE_URL;
        `,
      },
    ])("allows: $name", async ({ code }) => {
      const messages = await lintArchitecture(
        code,
        "src/app/contract-fixture.tsx",
      );

      const clientMessages = messages.filter(
        ({ ruleId }) => ruleId === clientBoundaryRule,
      );

      expect(clientMessages).toEqual([]);
    });

    it.each([
      {
        name: "Node.js built-in import",
        code: `
          "use client";

          import { readFile } from "node:fs/promises";

          export const value = readFile;
        `,
        message: "Node.js built-in modules",
      },
      {
        name: "database platform import",
        code: `
          "use client";

          import { database } from "@/platform/database/index.server";

          export const value = database;
        `,
        message: "Infrastructure clients",
      },
      {
        name: "PostgreSQL driver import",
        code: `
          "use client";

          import { Pool } from "pg";

          export const value = Pool;
        `,
        message: "PostgreSQL drivers are server-only",
      },
      {
        name: "server module entry point",
        code: `
          "use client";

          export * from "@/modules/catalog/index.server";
        `,
        message: "client-safe module entry points",
      },
      {
        name: "dynamic server import",
        code: `
          "use client";

          export const loadDatabase = () =>
            import("@/platform/database/index.server");
        `,
        message: "Infrastructure clients",
      },
      {
        name: "private environment variable",
        code: `
          "use client";

          export const databaseUrl =
            process.env.DATABASE_URL;
        `,
        message: "process.env.DATABASE_URL",
      },
      {
        name: "dynamic environment variable access",
        code: `
          "use client";

          const key = "NEXT_PUBLIC_APP_URL";

          export const value = process.env[key];
        `,
        message: "dynamic process.env access",
      },
      {
        name: "Better Auth server entry",
        code: `
          "use client";

          import { betterAuth } from "better-auth";

          export const value = betterAuth;
        `,
        message: "Better Auth server entry",
      },
      {
        name: "private environment reader",
        code: `
          "use client";

          export {
            readServerEnvironment,
          } from "@/config/env/read-server";
        `,
        message: "client-safe environment entry point",
      },
    ])("rejects: $name", async ({ code, message }) => {
      const messages = await lintArchitecture(
        code,
        "src/app/contract-fixture.tsx",
      );

      expectArchitectureError(messages, clientBoundaryRule, message);
    });
  });

  describe("client-safe and server-only boundaries", () => {
    it.each([
      {
        name: "client entry point with client-safe exports",
        filePath: "src/modules/contract_fixture/index.client.ts",
        code: `
          export const publicValue =
            process.env.NEXT_PUBLIC_APP_URL;
        `,
      },
      {
        name: "server entry point with server-only",
        filePath: "src/modules/contract_fixture/index.server.ts",
        code: `
          import "server-only";

          export const serverValue = "server";
        `,
      },
      {
        name: "infrastructure module with server-only",
        filePath: "src/modules/contract_fixture/infrastructure/adapter.ts",
        code: `
          import "server-only";

          export const adapterValue = "adapter";
        `,
      },
    ])("allows: $name", async ({ code, filePath }) => {
      const messages = await lintArchitecture(code, filePath);

      expect(messages).toEqual([]);
    });

    it.each([
      {
        name: "client entry point importing server infrastructure",
        filePath: "src/modules/contract_fixture/index.client.ts",
        code: `
          import {
            database,
          } from "@/platform/database/index.server";

          export const clientDatabase = database;
        `,
        ruleId: clientBoundaryRule,
        message: "Infrastructure clients",
      },
      {
        name: "client entry point importing relative infrastructure",
        filePath: "src/modules/contract_fixture/index.client.ts",
        code: `
          export {
            adapterValue,
          } from "./infrastructure/adapter";
        `,
        ruleId: clientBoundaryRule,
        message: "Infrastructure modules cannot enter the client bundle",
      },
      {
        name: "client entry point importing PostgreSQL",
        filePath: "src/modules/contract_fixture/index.client.ts",
        code: `
          import { Pool } from "pg";

          export const poolConstructor = Pool;
        `,
        ruleId: clientBoundaryRule,
        message: "PostgreSQL drivers are server-only",
      },
      {
        name: "server entry point without server-only",
        filePath: "src/modules/contract_fixture/index.server.ts",
        code: `
          export const serverValue = "server";
        `,
        ruleId: serverMarkerRule,
        message: 'import "server-only"',
      },
      {
        name: "infrastructure module without server-only",
        filePath: "src/modules/contract_fixture/infrastructure/adapter.ts",
        code: `
          export const adapterValue = "adapter";
        `,
        ruleId: serverMarkerRule,
        message: 'import "server-only"',
      },
    ])("rejects: $name", async ({ code, filePath, ruleId, message }) => {
      const messages = await lintArchitecture(code, filePath);

      expectArchitectureError(messages, ruleId, message);
    });
  });
});

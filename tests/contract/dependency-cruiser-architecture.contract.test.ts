import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

interface DependencyCruiserPackage {
  bin?: string | Record<string, string>;
}

interface CruiseViolation {
  rule:
    | string
    | {
        name?: string;
        severity?: string;
      };
  from: string;
  to: string;
}

interface CruiseReport {
  modules: Array<{
    source: string;
  }>;
  summary: {
    violations: CruiseViolation[];
  };
}

interface ProcessFailure extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

const projectRoot = process.cwd();
const dependencyCruiserConfig = path.join(
  projectRoot,
  ".dependency-cruiser.js",
);

let fixtureRoot: string;
let dependencyCruiserEntryPoint: string;
let cruiseReport: CruiseReport;

async function writeFixture(relativePath: string, content: string) {
  const filePath = path.join(fixtureRoot, relativePath);

  await mkdir(path.dirname(filePath), {
    recursive: true,
  });

  await writeFile(filePath, content);
}

function getRuleName(violation: CruiseViolation) {
  return typeof violation.rule === "string"
    ? violation.rule
    : violation.rule.name;
}

async function resolveDependencyCruiserEntryPoint() {
  const packageDirectory = path.join(
    projectRoot,
    "node_modules",
    "dependency-cruiser",
  );

  const packageJson = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  ) as DependencyCruiserPackage;

  const binary =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.depcruise;

  if (!binary) {
    throw new Error("dependency-cruiser does not declare a depcruise binary");
  }

  return path.join(packageDirectory, binary);
}

async function runDependencyCruiser(outputType: "json" | "err-long") {
  return execFileAsync(
    process.execPath,
    [
      dependencyCruiserEntryPoint,
      "--config",
      dependencyCruiserConfig,
      "--output-type",
      outputType,
      "--",
      "src",
      "tests",
    ],
    {
      cwd: fixtureRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

describe("Dependency Cruiser architecture contract", () => {
  beforeAll(async () => {
    fixtureRoot = await mkdtemp(
      path.join(tmpdir(), "next-fullstack-architecture-"),
    );

    dependencyCruiserEntryPoint = await resolveDependencyCruiserEntryPoint();

    await mkdir(path.join(fixtureRoot, "tests"), {
      recursive: true,
    });

    await writeFixture(
      "tsconfig.json",
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            strict: true,
            baseUrl: ".",
            paths: {
              "@/*": ["src/*"],
            },
          },
        },
        null,
        2,
      ),
    );

    await writeFixture(
      "src/modules/alpha/domain/entity.ts",
      `
        export const alphaValue = "alpha";
      `,
    );

    await writeFixture(
      "src/modules/alpha/application/use-alpha.ts",
      `
        import { alphaValue } from "../domain/entity";

        export const useAlpha = () => alphaValue;
      `,
    );

    await writeFixture(
      "src/modules/beta/domain/entity.ts",
      `
        export const betaValue = "beta";
      `,
    );

    await writeFixture(
      "src/modules/beta/index.server.ts",
      `
        export { betaValue } from "./domain/entity";
      `,
    );

    await writeFixture(
      "src/modules/beta/index.client.ts",
      `
        export { betaValue } from "./domain/entity";
      `,
    );

    await writeFixture(
      "src/modules/alpha/index.server.ts",
      `
        export {
          betaValue,
        } from "@/modules/beta/index.server";
      `,
    );

    await writeFixture(
      "src/modules/alpha/index.client.ts",
      `
        export {
          betaValue,
        } from "@/modules/beta/index.client";
      `,
    );

    await writeFixture(
      "src/modules/alpha/infrastructure/forbidden-cross-module.ts",
      `
        import {
          betaValue,
        } from "@/modules/beta/domain/entity";

        export const forbiddenCrossModuleValue =
          betaValue;
      `,
    );

    await writeFixture(
      "src/shared/forbidden-outside-module.ts",
      `
        import {
          betaValue,
        } from "@/modules/beta/domain/entity";

        export const forbiddenOutsideValue =
          betaValue;
      `,
    );

    await writeFixture(
      "src/proxy.ts",
      `
        import {
          betaValue,
        } from "@/modules/beta/domain/entity";

        export const forbiddenProxyValue =
          betaValue;
      `,
    );

    await writeFixture(
      "src/app/allowed-module-entry.ts",
      `
        import {
          betaValue,
        } from "@/modules/beta/index.server";

        export const allowedModuleValue =
          betaValue;
      `,
    );

    await writeFixture(
      "src/shared/cycle-a.ts",
      `
        import { cycleB } from "./cycle-b";

        export const cycleA = cycleB;
      `,
    );

    await writeFixture(
      "src/shared/cycle-b.ts",
      `
        import { cycleA } from "./cycle-a";

        export const cycleB = cycleA;
      `,
    );

    await writeFixture(
      "src/shared/unresolved.ts",
      `
        import {
          missingValue,
        } from "@/shared/missing";

        export const unresolvedValue =
          missingValue;
      `,
    );

    await writeFixture(
      "src/generated/prisma/generated-a.ts",
      `
        import { generatedB } from "./generated-b";

        export const generatedA = generatedB;
      `,
    );

    await writeFixture(
      "src/generated/prisma/generated-b.ts",
      `
        import { generatedA } from "./generated-a";

        export const generatedB = generatedA;
      `,
    );

    const { stdout } = await runDependencyCruiser("json");

    cruiseReport = JSON.parse(stdout) as CruiseReport;
  }, 20_000);

  afterAll(async () => {
    if (fixtureRoot) {
      await rm(fixtureRoot, {
        recursive: true,
        force: true,
      });
    }
  });

  it("detects every configured dependency violation", () => {
    const detectedRules = new Set(
      cruiseReport.summary.violations.map(getRuleName),
    );

    expect(detectedRules).toEqual(
      new Set([
        "no-circular-dependencies",
        "no-cross-module-internal-imports",
        "no-outside-module-internal-imports",
        "no-unresolvable-dependencies",
      ]),
    );
  });

  it("blocks root source files from importing module internals", () => {
    const proxyViolation = cruiseReport.summary.violations.find(
      ({ from }) => from === "src/proxy.ts",
    );

    expect(proxyViolation).toBeDefined();
    expect(getRuleName(proxyViolation!)).toBe(
      "no-outside-module-internal-imports",
    );
  });

  it("allows dependencies through controlled module entry points", () => {
    const allowedFiles = [
      "src/modules/alpha/application/use-alpha.ts",
      "src/modules/alpha/index.server.ts",
      "src/modules/alpha/index.client.ts",
      "src/modules/beta/index.server.ts",
      "src/modules/beta/index.client.ts",
      "src/app/allowed-module-entry.ts",
    ];

    for (const file of allowedFiles) {
      const violation = cruiseReport.summary.violations.find(
        ({ from }) => from === file,
      );

      expect(violation).toBeUndefined();
    }
  });

  it("excludes generated Prisma source from analysis", () => {
    const generatedModules = cruiseReport.modules.filter(({ source }) =>
      source.startsWith("src/generated/"),
    );

    expect(generatedModules).toEqual([]);
  });

  it("returns a non-zero exit code for error-level violations", async () => {
    let failure: ProcessFailure | undefined;

    try {
      await runDependencyCruiser("err-long");
    } catch (error) {
      failure = error as ProcessFailure;
    }

    expect(failure).toBeDefined();
    expect(Number(failure?.code)).toBeGreaterThan(0);

    const output = [failure?.stdout ?? "", failure?.stderr ?? ""].join("\n");

    expect(output).toContain("no-circular-dependencies");
    expect(output).toContain("no-cross-module-internal-imports");
    expect(output).toContain("no-outside-module-internal-imports");
    expect(output).toContain("no-unresolvable-dependencies");
  }, 20_000);
});

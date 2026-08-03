import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The operational health boundary contract.
 *
 * Four kinds of assertion appear here.
 *
 * The **inventory** assertions prove the HTTP surface is what it claims: exactly
 * two probes, neither under a locale, neither under `/api/v1`, and neither built
 * by `defineRoute`.
 *
 * The **reachability** assertions walk the real import graph from each route file
 * and prove what each one can and cannot arrive at. That is the only way to state
 * the liveness guarantee, because the failure it prevents is transitive: a single
 * import of a shared entry point would construct a Prisma client, and the endpoint
 * would still answer `200` while quietly holding a connection pool.
 *
 * The **boundary** assertions prove the exception to `defineRoute` is exactly two
 * files wide, that the health platform reaches no application area, and that the
 * ESLint blocks actually refuse what they claim to.
 *
 * The **scope** assertions prove this change is what it says it is: no migration,
 * no schema, no new dependency, no telemetry SDK, no deployment manifest.
 */
const projectRoot = process.cwd();
const healthRoot = "src/platform/health";
const livenessRoute = "src/app/api/health/live/route.ts";
const readinessRoute = "src/app/api/health/ready/route.ts";
const healthRoutes = [livenessRoute, readinessRoute];

/** The three controlled entry points, and the process each one serves. */
const entryPoints = [
  `${healthRoot}/index.server.ts`,
  `${healthRoot}/liveness.server.ts`,
  `${healthRoot}/readiness.server.ts`,
];

function read(filePath: string): string {
  return readFileSync(resolve(projectRoot, filePath), "utf8");
}

function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function readImports(source: string): string[] {
  return Array.from(
    stripComments(source).matchAll(
      /(?:from\s+|import\s*\(\s*|import\s*)["']([^"']+)["']/g,
    ),
    (match) => match[1] ?? "",
  );
}

function collectFiles(directory: string, suffix: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      return collectFiles(entryPath, suffix);
    }

    return entry.name.endsWith(suffix)
      ? [relative(projectRoot, entryPath).replaceAll("\\", "/")]
      : [];
  });
}

const healthFiles = collectFiles(resolve(projectRoot, healthRoot), ".ts");
const healthProductionFiles = healthFiles.filter(
  (path) => !path.includes(".test."),
);

/**
 * Resolves an import specifier to a repository file, or `null` when it is a
 * package.
 *
 * Only what is needed to walk this repository's own graph: the `@/` alias and
 * relative paths, with the extension and index resolution TypeScript applies.
 */
function resolveModule(fromFile: string, specifier: string): string | null {
  let base: string;

  if (specifier.startsWith("@/")) {
    base = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith(".")) {
    const directory = fromFile.split("/").slice(0, -1).join("/");
    const segments = `${directory}/${specifier}`.split("/");
    const stack: string[] = [];

    for (const segment of segments) {
      if (segment === "." || segment === "") {
        continue;
      }

      if (segment === "..") {
        stack.pop();
      } else {
        stack.push(segment);
      }
    }

    base = stack.join("/");
  } else {
    return null;
  }

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (
      existsSync(resolve(projectRoot, candidate)) &&
      candidate.endsWith(".ts" as string) === candidate.endsWith(".ts")
    ) {
      const isFile = /\.(?:ts|tsx)$/.test(candidate);

      if (isFile) {
        return candidate;
      }
    }
  }

  return null;
}

type Graph = Readonly<{
  files: readonly string[];
  packages: readonly string[];
}>;

/** Every repository file and every package specifier reachable from one entry. */
function reachableFrom(entry: string): Graph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.shift();

    if (current === undefined || files.has(current)) {
      continue;
    }

    files.add(current);

    for (const specifier of readImports(read(current))) {
      const resolved = resolveModule(current, specifier);

      if (resolved === null) {
        packages.add(specifier);
      } else if (!files.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return { files: [...files].sort(), packages: [...packages].sort() };
}

const livenessGraph = reachableFrom(livenessRoute);
const readinessGraph = reachableFrom(readinessRoute);
const sharedEntryGraph = reachableFrom(`${healthRoot}/index.server.ts`);

describe("the HTTP surface", () => {
  it("exposes exactly two probes", () => {
    const found = collectFiles(
      resolve(projectRoot, "src/app/api/health"),
      "route.ts",
    );

    expect(found.sort()).toEqual([...healthRoutes].sort());
  });

  it("serves them at the paths a load balancer is configured with", () => {
    for (const path of healthRoutes) {
      expect(existsSync(resolve(projectRoot, path)), path).toBe(true);
    }
  });

  it("places neither under a locale segment", () => {
    // A probe is called by a machine that will not follow a redirect to `/ar/…`,
    // and `/api` is a non-localized subtree in the proxy's rules.
    for (const path of healthRoutes) {
      expect(path, path).not.toContain("[locale]");
    }

    expect(existsSync(resolve(projectRoot, "src/app/[locale]/api"))).toBe(
      false,
    );
  });

  it("places neither under the versioned API", () => {
    // An operational contract is not a product API: it has no envelope, no
    // deprecation policy, and nothing to version.
    for (const path of healthRoutes) {
      expect(path, path).not.toContain("/api/v1/");
    }
  });

  it("keeps each route a declaration and nothing more", () => {
    for (const path of healthRoutes) {
      const statements = stripComments(read(path))
        .split("\n")
        .filter((line) => line.trim().length > 0);

      expect(statements.length, path).toBeLessThan(12);
      expect(stripComments(read(path)), path).toMatch(
        /export const GET = create\w+Handler\(/,
      );
    }
  });

  it.each([
    { name: "an error mapping", pattern: /\btry\s*\{|\bcatch\s*\(/ },
    {
      name: "response construction",
      pattern: /Response\.json|new Response|NextResponse/,
    },
    { name: "a status literal", pattern: /\b(?:200|404|503)\b/ },
    { name: "a header", pattern: /no-store|cache-control/i },
    { name: "control flow", pattern: /\bif\s*\(|\bswitch\s*\(|\bfor\s*\(/ },
    {
      name: "a session read",
      pattern: /getSession|getCurrentActor|cookies\(\)|headers\(\)/,
    },
    { name: "a capability check", pattern: /require(?:Actor|Permission)/ },
  ])("never restates $name in a route file", ({ pattern }) => {
    for (const path of healthRoutes) {
      expect(stripComments(read(path)), path).not.toMatch(pattern);
    }
  });

  it("declares no removed route segment config", () => {
    // `dynamic`, `revalidate`, and `fetchCache` were removed in Next.js 16 when
    // Cache Components is enabled. `connection()` is the supported mechanism, and
    // it lives in the adapter rather than in a route file.
    for (const path of healthRoutes) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(
        /export const (?:dynamic|revalidate|fetchCache)\b/,
      );
    }
  });
});

describe("liveness reachability", () => {
  it("reaches a small, named set of repository files and nothing else", () => {
    expect(livenessGraph.files).toEqual([
      "src/app/api/health/live/route.ts",
      "src/platform/health/health-code.ts",
      "src/platform/health/health-headers.ts",
      "src/platform/health/health-status.ts",
      "src/platform/health/liveness-response.ts",
      "src/platform/health/liveness.server.ts",
      "src/platform/health/liveness.ts",
    ]);
  });

  it.each([
    { name: "the database platform", pattern: /^src\/platform\/database\// },
    { name: "the Redis platform", pattern: /^src\/platform\/redis\// },
    { name: "the storage platform", pattern: /^src\/platform\/storage\// },
    { name: "the jobs platform", pattern: /^src\/platform\/jobs\// },
    { name: "authentication", pattern: /^src\/platform\/auth\// },
    { name: "the audit platform", pattern: /^src\/platform\/audit\// },
    { name: "the cache", pattern: /^src\/platform\/cache\// },
    {
      name: "the concurrency controls",
      pattern: /^src\/platform\/concurrency\//,
    },
    { name: "the worker", pattern: /^src\/worker\// },
    { name: "a business module", pattern: /^src\/modules\// },
    {
      name: "the observability logger",
      pattern: /^src\/platform\/observability\//,
    },
    { name: "server environment configuration", pattern: /^src\/config\// },
  ])("never reaches $name, transitively", ({ pattern }) => {
    expect(livenessGraph.files.filter((path) => pattern.test(path))).toEqual(
      [],
    );
  });

  it.each([
    { name: "Prisma", pattern: /^(?:@prisma\/|prisma$|@\/generated)/ },
    { name: "the PostgreSQL driver", pattern: /^pg(?:\/|$)/ },
    { name: "a Redis driver", pattern: /^(?:redis|ioredis)(?:\/|$)|^@redis\// },
    { name: "BullMQ", pattern: /^bullmq(?:\/|$)/ },
    { name: "the AWS SDK", pattern: /^(?:@aws-sdk\/|aws-sdk(?:\/|$))/ },
    { name: "Better Auth", pattern: /^better-auth(?:\/|$)/ },
    { name: "Pino", pattern: /^pino(?:\/|$)/ },
    { name: "React", pattern: /^react(?:-dom)?(?:\/|$)/ },
    { name: "translations", pattern: /^next-intl(?:\/|$)/ },
  ])("never reaches the $name package, transitively", ({ pattern }) => {
    expect(livenessGraph.packages.filter((name) => pattern.test(name))).toEqual(
      [],
    );
  });

  it("uses one Next.js import, and only for request-time rendering", () => {
    expect(
      livenessGraph.packages.filter((name) => /^next(?:\/|$)/.test(name)),
    ).toEqual(["next/server"]);

    expect(read(`${healthRoot}/liveness.server.ts`)).toContain(
      'import { connection } from "next/server";',
    );
  });

  it("works with every external service down, by construction", () => {
    // Nothing in the reachable set can open a socket, so there is no service whose
    // absence could change the answer.
    expect(
      livenessGraph.packages.filter(
        (name) => name !== "next/server" && name !== "server-only",
      ),
    ).toEqual([]);
  });
});

describe("readiness reachability", () => {
  it("reaches the three dependencies it reports on", () => {
    for (const pattern of [
      /^src\/platform\/database\//,
      /^src\/platform\/redis\//,
      /^src\/platform\/storage\//,
    ]) {
      expect(
        readinessGraph.files.filter((path) => pattern.test(path)).length,
        String(pattern),
      ).toBeGreaterThan(0);
    }
  });

  it.each([
    { name: "the jobs platform", pattern: /^src\/platform\/jobs\// },
    { name: "the worker", pattern: /^src\/worker\// },
    { name: "authentication", pattern: /^src\/platform\/auth\// },
    { name: "the audit platform", pattern: /^src\/platform\/audit\// },
    { name: "the cache", pattern: /^src\/platform\/cache\// },
    {
      name: "the concurrency controls",
      pattern: /^src\/platform\/concurrency\//,
    },
    { name: "the Route Handler factory", pattern: /^src\/platform\/http\// },
    { name: "a business module", pattern: /^src\/modules\// },
    { name: "UI code", pattern: /^src\/ui\// },
  ])("never reaches $name, transitively", ({ pattern }) => {
    expect(readinessGraph.files.filter((path) => pattern.test(path))).toEqual(
      [],
    );
  });

  it.each([
    { name: "BullMQ", pattern: /^bullmq(?:\/|$)/ },
    { name: "ioredis", pattern: /^ioredis(?:\/|$)/ },
    { name: "Better Auth", pattern: /^better-auth(?:\/|$)/ },
    { name: "React", pattern: /^react(?:-dom)?(?:\/|$)/ },
    { name: "translations", pattern: /^next-intl(?:\/|$)/ },
  ])("never reaches the $name package, transitively", ({ pattern }) => {
    expect(
      readinessGraph.packages.filter((name) => pattern.test(name)),
    ).toEqual([]);
  });

  it("waits for a request before running a check", () => {
    expect(read(`${healthRoot}/readiness.server.ts`)).toContain(
      "await connection();",
    );
  });
});

describe("the shared entry point", () => {
  it("reaches neither Next.js nor any of the three dependency areas", () => {
    // This is what lets `pnpm jobs:health` — a plain Node process — use the
    // contracts without loading request machinery or an object-storage SDK.
    for (const pattern of [
      /^src\/platform\/database\//,
      /^src\/platform\/redis\//,
      /^src\/platform\/storage\//,
      /^src\/platform\/jobs\//,
      /^src\/worker\//,
    ]) {
      expect(
        sharedEntryGraph.files.filter((path) => pattern.test(path)),
        String(pattern),
      ).toEqual([]);
    }

    expect(
      sharedEntryGraph.packages.filter((name) => /^next(?:\/|$)/.test(name)),
    ).toEqual([]);
  });

  it("exports no handler factory", () => {
    const source = read(`${healthRoot}/index.server.ts`);

    expect(source).not.toContain("createLivenessHandler");
    expect(source).not.toContain("createReadinessHandler");
    expect(source).not.toContain("createWebReadinessRegistry");
  });
});

describe("the health platform", () => {
  it("marks every server module with the server-only guard", () => {
    const serverModules = healthProductionFiles.filter((path) =>
      path.includes(".server."),
    );

    expect(serverModules.length).toBeGreaterThan(0);

    for (const path of serverModules) {
      expect(read(path).startsWith('import "server-only";'), path).toBe(true);
    }
  });

  it("publishes exactly three controlled entry points", () => {
    const found = healthProductionFiles.filter((path) =>
      /\/(?:index|liveness|readiness)\.server\.ts$/.test(path),
    );

    expect(found.sort()).toEqual([...entryPoints].sort());
  });

  it("ships no client entry point", () => {
    // Nothing here is safe to import into a browser bundle, and nothing needs to
    // be: a probe is a machine-to-machine contract.
    expect(
      existsSync(resolve(projectRoot, `${healthRoot}/index.client.ts`)),
    ).toBe(false);
  });

  it.each([
    { name: "Prisma", pattern: /^(?:@prisma(?:\/|$)|prisma$|@\/generated)/ },
    { name: "the PostgreSQL driver", pattern: /^pg(?:\/|$)/ },
    { name: "a Redis driver", pattern: /^(?:redis|ioredis)(?:\/|$)|^@redis\// },
    { name: "BullMQ", pattern: /^bullmq(?:\/|$)/ },
    { name: "the AWS SDK", pattern: /^(?:@aws-sdk\/|aws-sdk(?:\/|$))/ },
    { name: "Better Auth", pattern: /^better-auth(?:\/|$)/ },
    { name: "the jobs platform", pattern: /^@\/platform\/jobs/ },
    { name: "the worker", pattern: /^@\/worker/ },
    { name: "authentication", pattern: /^@\/platform\/auth/ },
    { name: "the audit platform", pattern: /^@\/platform\/audit/ },
    { name: "the cache", pattern: /^@\/platform\/cache/ },
    { name: "the concurrency controls", pattern: /^@\/platform\/concurrency/ },
    {
      name: "an application adapter",
      pattern: /^@\/platform\/(?:actions|http|proxy)/,
    },
    { name: "application routing", pattern: /^@\/app(?:\/|$)/ },
    { name: "a business module", pattern: /^@\/modules/ },
    { name: "UI code", pattern: /^@\/ui/ },
    { name: "React", pattern: /^react(?:-dom)?(?:\/|$)/ },
    { name: "translations", pattern: /^(?:next-intl|@\/i18n)/ },
  ])("never imports $name", ({ pattern }) => {
    for (const path of healthProductionFiles) {
      expect(
        readImports(read(path)).filter((name) => pattern.test(name)),
        path,
      ).toEqual([]);
    }
  });

  it("uses no Next.js API other than the request-time signal", () => {
    const nextImports = healthProductionFiles
      .flatMap((path) => readImports(read(path)))
      .filter((name) => /^next(?:\/|$)/.test(name));

    expect([...new Set(nextImports)]).toEqual(["next/server"]);
  });

  it("owns no probe of its own: the three checks come from the areas that own them", () => {
    const composition = read(`${healthRoot}/web-readiness.server.ts`);

    expect(composition).toContain("checkDatabaseHealth");
    expect(composition).toContain("checkRedisHealth");
    expect(composition).toContain("checkStorageHealth");

    // No query, no ping, no bucket call anywhere in the directory.
    for (const path of healthProductionFiles) {
      const source = stripComments(read(path));

      for (const pattern of [
        /\$queryRaw/,
        /\.ping\(/,
        /HeadBucket/,
        /SELECT\s+1/i,
      ]) {
        expect(source, `${path} ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("writes every log line through the single writer", () => {
    const writers = healthProductionFiles.filter((path) =>
      readImports(read(path)).some((name) =>
        name.startsWith("@/platform/observability/logger"),
      ),
    );

    expect(writers).toEqual([`${healthRoot}/health-logger.server.ts`]);
  });

  it("uses no console anywhere", () => {
    for (const path of healthProductionFiles) {
      expect(stripComments(read(path)), path).not.toMatch(/\bconsole\s*\./);
    }
  });

  it("builds no mutable registry and holds nothing on globalThis", () => {
    for (const path of healthProductionFiles) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/globalThis/);
      expect(source, path).not.toMatch(/export function register\w*Check/);
      expect(source, path).not.toMatch(/checks\.push\(/);
    }
  });

  it("never derives a code from a caught value", () => {
    for (const path of healthProductionFiles) {
      const source = stripComments(read(path));

      // Every `catch` in this area is a bare `catch {}` or discards the binding;
      // reading the value is how a driver message reaches a public document.
      expect(source, path).not.toMatch(
        /catch\s*\([^)]+\)\s*\{[\s\S]{0,400}?\berror\s*\.\s*message/,
      );
      expect(source, path).not.toMatch(/\.stack\b/);
      expect(source, path).not.toMatch(/String\(\s*error\s*\)/);
    }
  });
});

describe("the exception to defineRoute", () => {
  it("is exactly two files wide", () => {
    const importers = collectFiles(resolve(projectRoot, "src"), ".ts")
      .concat(collectFiles(resolve(projectRoot, "src"), ".tsx"))
      .filter((path) => !path.startsWith(`${healthRoot}/`))
      .filter((path) => !path.includes(".test."))
      .filter((path) =>
        readImports(read(path)).some((name) =>
          name.startsWith("@/platform/health"),
        ),
      );

    expect(importers.sort()).toEqual(
      [...healthRoutes, "src/worker/jobs.health.ts"].sort(),
    );
  });

  it("leaves every versioned endpoint on the factory", () => {
    const versioned = collectFiles(
      resolve(projectRoot, "src/app/api/v1"),
      "route.ts",
    );

    expect(versioned.length).toBeGreaterThan(0);

    for (const path of versioned) {
      const source = stripComments(read(path));

      expect(source, path).toContain("defineRoute");
      expect(source, path).not.toContain("@/platform/health");
    }
  });

  it("puts no Prisma, Redis, or storage SDK anywhere in src/app", () => {
    const appFiles = collectFiles(
      resolve(projectRoot, "src/app"),
      ".ts",
    ).concat(collectFiles(resolve(projectRoot, "src/app"), ".tsx"));

    for (const path of appFiles) {
      for (const pattern of [
        /^(?:@prisma(?:\/|$)|prisma$|@\/generated)/,
        /^@\/platform\/database/,
        /^pg(?:\/|$)/,
        /^(?:redis|ioredis)(?:\/|$)|^@redis\//,
        /^bullmq(?:\/|$)/,
        /^(?:@aws-sdk\/|aws-sdk(?:\/|$))/,
        /^@\/platform\/storage/,
      ]) {
        expect(
          readImports(read(path)).filter((name) => pattern.test(name)),
          `${path} ${String(pattern)}`,
        ).toEqual([]);
      }
    }
  });
});

describe("the worker contract", () => {
  const command = "src/worker/jobs.health.ts";

  it("exists as a one-shot command with its own package script", () => {
    const scripts = (
      JSON.parse(read("package.json")) as {
        scripts: Record<string, string>;
      }
    ).scripts;

    expect(scripts["jobs:health"]).toBe(
      "tsx --conditions=react-server src/worker/jobs.health.ts",
    );
  });

  it("opens no HTTP server and no port", () => {
    for (const path of collectFiles(
      resolve(projectRoot, "src/worker"),
      ".ts",
    )) {
      const source = stripComments(read(path));

      for (const pattern of [
        /createServer/,
        /\.listen\(/,
        /node:http\b/,
        /from "http"/,
        /express/,
        /fastify/,
      ]) {
        expect(source, `${path} ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it("maps the three verdicts onto the existing exit codes", () => {
    const source = read(command);

    expect(source).toContain("WORKER_EXIT_CODE.OK");
    expect(source).toContain("WORKER_EXIT_CODE.MISCONFIGURED");
    expect(source).toContain("WORKER_EXIT_CODE.FAILED");
    expect(source).not.toMatch(/process\.exit\(/);
  });

  it("adds no exit code of its own", () => {
    const bootstrap = read("src/worker/bootstrap.ts");
    const codes = Array.from(
      bootstrap.matchAll(/^\s{2}([A-Z_]+):\s*(\d+),$/gm),
      (match) => `${match[1]}=${match[2]}`,
    );

    expect(codes).toEqual(["OK=0", "FAILED=1", "MISCONFIGURED=78"]);
  });

  it("leaves the meaning of jobs:status unchanged", () => {
    const status = read("src/worker/jobs.status.ts");

    expect(status).toContain('operation: "status"');
    expect(status).not.toContain("checkJobsQueueHealth");
    expect(status).not.toContain("checkWorkerReadiness");
    expect(status).not.toContain("@/platform/health");
  });

  it("enqueues nothing and writes nothing", () => {
    const source = stripComments(read(command));

    for (const pattern of [
      /queue\.add\(/,
      /writeOutboxMessage/,
      /runDatabaseJobOnce/,
      /startJobsWorkerRuntime/,
      /createOutboxDispatcher/,
      /\.create\(/,
      /\.update\(/,
      /\.delete\(/,
    ]) {
      expect(source, String(pattern)).not.toMatch(pattern);
    }
  });

  it("closes what it opened", () => {
    const source = stripComments(read(command));

    expect(source).toContain("finally");
    expect(source).toContain("$disconnect()");
  });

  it("logs no address, prefix, or credential", () => {
    const source = stripComments(read(command));

    for (const pattern of [
      /JOBS_REDIS_URL/,
      /DATABASE_URL/,
      /queuePrefix/,
      /\bconsole\s*\./,
    ]) {
      expect(source, String(pattern)).not.toMatch(pattern);
    }
  });
});

describe("the published contract", () => {
  it("closes the code set", () => {
    const source = read(`${healthRoot}/health-code.ts`);
    const codes = Array.from(
      source.matchAll(/^\s{2}([A-Z_]+):\s*"([A-Z_]+)",$/gm),
      (match) => match[2],
    );

    expect(codes.sort()).toEqual([
      "DATABASE_UNAVAILABLE",
      "JOBS_REDIS_UNAVAILABLE",
      "NOT_READY",
      "PROCESS_ALIVE",
      "READY",
      "REDIS_UNAVAILABLE",
      "STORAGE_MISCONFIGURED",
      "STORAGE_UNAVAILABLE",
      "WORKER_MISCONFIGURED",
      "WORKER_NOT_READY",
      "WORKER_READY",
    ]);
  });

  it.each([
    {
      name: "the database platform",
      path: "src/platform/database/health.server.ts",
      code: "DATABASE_UNAVAILABLE",
    },
    {
      name: "the Redis platform",
      path: "src/platform/redis/health.server.ts",
      code: "REDIS_UNAVAILABLE",
    },
    {
      name: "the jobs platform",
      path: "src/platform/jobs/queue/queue-health.server.ts",
      code: "JOBS_REDIS_UNAVAILABLE",
    },
  ])("publishes the same spelling $name uses", ({ path, code }) => {
    // The owning area declares its own constant so it can answer without depending
    // on the health platform, and the health platform publishes the complete list
    // in one file. The two must be the same string, and this is what stops them
    // drifting apart unnoticed. It is asserted here rather than in a unit test
    // because reading the jobs area from `src/platform/health` would make
    // background jobs a dependency of the endpoint a load balancer calls.
    expect(read(path)).toContain(`export const ${code} = "${code}" as const;`);
    expect(read(`${healthRoot}/health-code.ts`)).toContain(
      `${code}: "${code}",`,
    );
  });

  it("keeps every code in one file", () => {
    const declarers = healthProductionFiles.filter((path) =>
      /"(?:PROCESS_ALIVE|READY|NOT_READY|WORKER_READY)"/.test(
        stripComments(read(path)),
      ),
    );

    expect(declarers).toEqual([`${healthRoot}/health-code.ts`]);
  });

  it("closes the status set to two HTTP codes", () => {
    const source = read(`${healthRoot}/readiness.ts`);
    const statuses = Array.from(
      source.matchAll(/^\s{2}(?:READY|NOT_READY):\s*(\d{3}),$/gm),
      (match) => Number(match[1]),
    );

    expect(statuses.sort()).toEqual([200, 503]);
  });

  it("sets no-store in exactly one place", () => {
    const setters = healthProductionFiles.filter((path) =>
      /no-store/.test(stripComments(read(path))),
    );

    expect(setters).toEqual([`${healthRoot}/health-headers.ts`]);
  });

  it("closes the log-field allowlist", () => {
    const source = read(`${healthRoot}/health-log-fields.ts`);
    const names = Array.from(
      source.matchAll(/^\s{2}"(\w+)",$/gm),
      (match) => match[1],
    );

    expect(names).toEqual([
      "process",
      "status",
      "code",
      "databaseStatus",
      "redisStatus",
      "storageStatus",
      "queueStatus",
      "durationMs",
    ]);
  });

  it("exposes no latency in the response contract", () => {
    for (const path of [
      `${healthRoot}/liveness.ts`,
      `${healthRoot}/readiness.ts`,
      `${healthRoot}/dependency-check.ts`,
    ]) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/latencyMs\?:/);
    }

    // The document types have no field for it; the internal result does.
    expect(read(`${healthRoot}/dependency-check.ts`)).toContain("durationMs");
  });
});

describe("scope", () => {
  it("adds no migration", () => {
    const migrations = readdirSync(resolve(projectRoot, "prisma/migrations"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(migrations).toEqual([
      "20260731201511_establish_authentication_foundation",
      "20260731220528_establish_authorization_admin_access_control",
      "20260801200849_establish_background_jobs_and_transactional_outbox",
      "20260802145528_establish_application_audit_platform",
      "20260802192103_establish_secure_object_storage_and_uploads",
    ]);
  });

  it("adds no Prisma model or schema file", () => {
    const schemas = readdirSync(resolve(projectRoot, "prisma"))
      .filter((name) => name.endsWith(".prisma"))
      .sort();

    expect(schemas).toEqual([
      "audit.prisma",
      "authorization.prisma",
      "identity.prisma",
      "jobs.prisma",
      "schema.prisma",
      "storage.prisma",
    ]);
  });

  it("names no table in the health platform", () => {
    for (const path of healthProductionFiles) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(
        /database\.\w+\.(?:count|findMany|create)/,
      );
      expect(source, path).not.toMatch(/\$transaction/);
    }
  });

  it("adds no dependency", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "@aws-sdk/client-s3",
      "@aws-sdk/s3-presigned-post",
      "@aws-sdk/s3-request-presigner",
      "@better-auth/prisma-adapter",
      "@next/env",
      "@opentelemetry/api",
      "@prisma/adapter-pg",
      "@prisma/client",
      "better-auth",
      "bullmq",
      "class-variance-authority",
      "clsx",
      "ioredis",
      "lucide-react",
      "next",
      "next-intl",
      "pg",
      "pino",
      "radix-ui",
      "react",
      "react-dom",
      "redis",
      "server-only",
      "shadcn",
      "sonner",
      "tailwind-merge",
      "tsx",
      "tw-animate-css",
      "zod",
    ]);

    expect(Object.keys(manifest.devDependencies).sort()).toEqual([
      "@playwright/test",
      "@tailwindcss/postcss",
      "@testing-library/jest-dom",
      "@testing-library/react",
      "@testing-library/user-event",
      "@types/node",
      "@types/pg",
      "@types/react",
      "@types/react-dom",
      "@vitest/coverage-v8",
      "dependency-cruiser",
      "eslint",
      "eslint-config-next",
      "jsdom",
      "prettier",
      "prettier-plugin-tailwindcss",
      "prisma",
      "tailwindcss",
      "typescript",
      "vitest",
    ]);
  });

  it("ships no telemetry SDK, metrics endpoint, or status page", () => {
    for (const path of healthProductionFiles.concat(healthRoutes)) {
      const source = stripComments(read(path));

      for (const pattern of [
        /@opentelemetry/,
        /prom-client/,
        /prometheus/i,
        /@sentry/,
        /metrics/i,
        /uptime/i,
      ]) {
        expect(source, `${path} ${String(pattern)}`).not.toMatch(pattern);
      }
    }

    expect(existsSync(resolve(projectRoot, "src/app/api/metrics"))).toBe(false);
    expect(existsSync(resolve(projectRoot, "src/app/[locale]/status"))).toBe(
      false,
    );
  });

  it("adds no deployment manifest", () => {
    for (const path of [
      "Dockerfile",
      "Dockerfile.web",
      "Dockerfile.worker",
      "k8s",
      "kubernetes",
      "helm",
      "chart",
      "deploy",
      "deployment.yaml",
    ]) {
      expect(existsSync(resolve(projectRoot, path)), path).toBe(false);
    }
  });

  it("adds no scheduler", () => {
    for (const path of healthProductionFiles) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/setInterval/);
      expect(source, path).not.toMatch(/\bcron\b/i);
    }
  });

  it("caches no probe result", () => {
    for (const path of healthProductionFiles) {
      const source = stripComments(read(path));

      // A cached probe result would let a stale success hide a current failure,
      // which is the one thing a readiness endpoint must never do.
      expect(source, path).not.toMatch(/"use cache"/);
      expect(source, path).not.toMatch(/@\/platform\/cache/);
      expect(source, path).not.toMatch(/cacheLife|cacheTag|revalidate/);
    }
  });
});

describe("CI", () => {
  const workflow = read(".github/workflows/ci.yml");

  it("still runs with every optional dependency off by default", () => {
    expect(workflow).toContain('REDIS_ENABLED: "false"');
    expect(workflow).toContain('JOBS_ENABLED: "false"');
    expect(workflow).toContain('STORAGE_ENABLED: "false"');
  });

  it("needs no new service for the health contracts", () => {
    // Liveness needs nothing, readiness needs what `pnpm verify` already has, and
    // the worker contract runs inside the jobs suite.
    expect(workflow).not.toContain("health-probe");
    expect(workflow).not.toContain("jobs:health");
  });
});

describe("ESLint enforcement", () => {
  let eslint: ESLint;

  beforeAll(async () => {
    eslint = new ESLint({ cwd: projectRoot });

    await eslint.lintText("export const warmUp = true;\n", {
      filePath: `${healthRoot}/warm-up.ts`,
      warnIgnored: true,
    });
  }, 30_000);

  async function lint(code: string, filePath: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, {
      filePath,
      warnIgnored: true,
    });

    if (!result) {
      throw new Error(`ESLint returned no result for ${filePath}.`);
    }

    return result.messages
      .filter(({ severity }) => severity === 2)
      .map(({ message }) => message);
  }

  it.each([
    {
      name: "background jobs",
      code: `export { isJobsEnabled } from "@/platform/jobs/index.server";\n`,
    },
    {
      name: "Prisma",
      code: `export { PrismaClient } from "@/generated/prisma/client";\n`,
    },
    {
      name: "a Redis driver",
      code: `export { createClient } from "redis";\n`,
    },
    {
      name: "the AWS SDK",
      code: `export { S3Client } from "@aws-sdk/client-s3";\n`,
    },
    {
      name: "authentication",
      code: `export { auth } from "@/platform/auth/auth.server";\n`,
    },
    {
      name: "the Route Handler factory",
      code: `export { defineRoute } from "@/platform/http/index.server";\n`,
    },
    {
      name: "ambient request headers",
      code: `export { headers } from "next/headers";\n`,
    },
    {
      name: "React",
      code: `export { useState } from "react";\n`,
    },
  ])(
    "refuses a health platform module that imports $name",
    async ({ code }) => {
      expect(await lint(code, `${healthRoot}/probe.ts`)).not.toEqual([]);
    },
  );

  it("allows the health platform to use the request-time signal", async () => {
    expect(
      await lint(
        `import { connection } from "next/server";\n\nexport const probe = connection;\n`,
        `${healthRoot}/probe-connection.ts`,
      ),
    ).toEqual([]);
  });

  it("allows the health platform to reach the database platform", async () => {
    // The one persistence import it may take: the check belongs to the area that
    // owns the client, and this is how it is reached.
    expect(
      await lint(
        `export { checkDatabaseHealth } from "@/platform/database/index.server";\n`,
        `${healthRoot}/probe-database.ts`,
      ),
    ).toEqual([]);
  });

  it.each([
    {
      name: "the Route Handler factory",
      code: `export { defineRoute } from "@/platform/http/index.server";\n`,
    },
    {
      name: "a health platform internal",
      code: `export { LIVENESS_REPORT } from "@/platform/health/liveness";\n`,
    },
    {
      name: "the database platform",
      code: `export { database } from "@/platform/database/index.server";\n`,
    },
    {
      name: "the storage platform",
      code: `export { checkStorageHealth } from "@/platform/storage/index.server";\n`,
    },
    {
      name: "an error mapping",
      code: `export function GET() {\n  try {\n    return null;\n  } catch {\n    return null;\n  }\n}\n`,
    },
    {
      name: "response construction",
      code: `export function GET() {\n  return Response.json({ status: "live" });\n}\n`,
    },
  ])("refuses a health route that performs $name", async ({ code }) => {
    expect(
      await lint(code, "src/app/api/health/contract-fixture/route.ts"),
    ).not.toEqual([]);
  });

  it("allows a health route that declares and delegates", async () => {
    expect(
      await lint(
        `import { createLivenessHandler } from "@/platform/health/liveness.server";\n\nexport const GET = createLivenessHandler();\n`,
        "src/app/api/health/contract-fixture-ok/route.ts",
      ),
    ).toEqual([]);
  });

  it("refuses object storage anywhere in src/app", async () => {
    expect(
      await lint(
        `export { checkStorageHealth } from "@/platform/storage/index.server";\n`,
        "src/app/api/v1/admin/contract-fixture/route.ts",
      ),
    ).not.toEqual([]);
  });
});

describe("documentation", () => {
  it("documents the operational health architecture", () => {
    const document = read(
      "docs/architecture/operational-health.md",
    ).toLowerCase();

    for (const topic of [
      "liveness",
      "readiness",
      "web readiness",
      "worker readiness",
      "http status",
      "stable codes",
      "optional",
      "timeout",
      "failure containment",
      "sanitiz",
      "load balancer",
      "why web readiness does not check the worker",
      "why the worker runs no http server",
      "definer",
      "removing redis",
      "removing object storage",
      "known limitations",
    ]) {
      expect(document, topic).toContain(topic.toLowerCase());
    }
  });

  it("records the two probe paths and the codes in the document", () => {
    const document = read("docs/architecture/operational-health.md");

    for (const value of [
      "/api/health/live",
      "/api/health/ready",
      "PROCESS_ALIVE",
      "READY",
      "NOT_READY",
      "DATABASE_UNAVAILABLE",
      "REDIS_UNAVAILABLE",
      "STORAGE_UNAVAILABLE",
      "STORAGE_MISCONFIGURED",
      "WORKER_READY",
      "WORKER_NOT_READY",
      "WORKER_MISCONFIGURED",
      "JOBS_REDIS_UNAVAILABLE",
      "no-store",
      "503",
      "pnpm jobs:health",
    ]) {
      expect(document, value).toContain(value);
    }
  });

  it("explains the defineRoute exception where the factory is documented", () => {
    const document = read("docs/architecture/route-handler-factory.md");

    expect(document).toContain("/api/health/live");
    expect(document).toContain("/api/health/ready");
    expect(document).toContain("operational-health.md");
  });

  it.each([
    { name: "the architecture index", path: "docs/architecture/README.md" },
    { name: "the module map", path: "docs/architecture/module-map.md" },
  ])("links the document from $name", ({ path }) => {
    expect(read(path)).toContain("operational-health.md");
  });

  it("documents the implementation rules next to the code", () => {
    const document = read(`${healthRoot}/README.md`);

    expect(document).toContain("createLivenessHandler");
    expect(document).toContain("createReadinessHandler");
    expect(document).toContain("server-only");
    expect(read("src/platform/README.md")).toContain("health/README.md");
  });

  it("names the allowlisted log fields in the document", () => {
    const document = read("docs/architecture/operational-health.md");

    for (const field of [
      "process",
      "status",
      "code",
      "databaseStatus",
      "queueStatus",
    ]) {
      expect(document, field).toContain(field);
    }
  });
});

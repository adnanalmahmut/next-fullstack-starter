import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The Redis foundation contract.
 *
 * One property dominates every assertion here: **Redis is optional**. The
 * application must build, boot, and pass its whole default suite on a machine
 * with no Redis and no Redis variable, and it must be removable by deleting a
 * directory rather than by editing business code. That is a property of the
 * repository's shape, so it is asserted against the tree rather than against a
 * running system.
 */
const projectRoot = process.cwd();
const redisRoot = "src/platform/redis";

function read(filePath: string): string {
  return readFileSync(resolve(projectRoot, filePath), "utf8");
}

function exists(filePath: string): boolean {
  return existsSync(resolve(projectRoot, filePath));
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
      /(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g,
    ),
    (match) => match[1] ?? "",
  );
}

function collectSourceFiles(root: string): string[] {
  const directory = resolve(projectRoot, root);

  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return collectSourceFiles(relative(projectRoot, entryPath));
      }

      return /\.(?:ts|tsx)$/.test(entry.name)
        ? [relative(projectRoot, entryPath).replaceAll("\\", "/")]
        : [];
    })
    .sort();
}

const repositorySources = [
  ...collectSourceFiles("src"),
  ...collectSourceFiles("tests"),
].filter((path) => !path.startsWith("src/generated/"));

const redisSources = collectSourceFiles(redisRoot);
const redisProductionSources = redisSources.filter(
  (path) => !path.includes(".test."),
);

const driverPattern = /^(?:(?:redis|ioredis)(?:\/|$)|@redis\/)/;

const ciWorkflow = read(".github/workflows/ci.yml");
const packageJson = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("Redis is optional", () => {
  it("defaults to disabled", () => {
    const schema = read("src/config/env/schema.ts");

    expect(schema).toContain("REDIS_ENABLED: redisFlagSchema.default(false)");
    expect(read(".env.example")).toContain("REDIS_ENABLED=false");
  });

  it("is absent from the required server environment", () => {
    const schema = stripComments(read("src/config/env/schema.ts"));
    const serverBlock = schema.slice(
      schema.indexOf("export const serverEnvironmentSchema"),
      schema.indexOf("export const publicEnvironmentSchema"),
    );

    expect(serverBlock).not.toContain("REDIS");
  });

  it("is not read by the eager configuration entry point", () => {
    const entryPoint = read("src/config/env/index.server.ts");

    expect(entryPoint).not.toContain("Redis");
    expect(entryPoint).not.toContain("redis");
  });

  it("names no default URL and no localhost fallback in production code", () => {
    for (const path of [
      ...redisProductionSources,
      "src/config/env/schema.ts",
      "src/config/env/read-redis.ts",
    ]) {
      const source = stripComments(read(path));

      expect(source, path).not.toContain("localhost");
      expect(source, path).not.toContain("127.0.0.1");
      expect(source, path).not.toMatch(/rediss?:\/\//);
    }
  });

  it("requires a URL only once enabled", () => {
    const schema = read("src/config/env/schema.ts");

    expect(schema).toContain(
      "REDIS_URL is required when REDIS_ENABLED is true",
    );
    expect(schema).toContain("REDIS_URL: redisUrlSchema.optional()");
  });

  it("accepts only the two Redis protocols", () => {
    expect(read("src/config/env/schema.ts")).toContain("protocol: /^rediss?$/");
  });
});

describe("no core module depends on Redis", () => {
  const coreRoots = [
    "src/platform/auth",
    "src/platform/database",
    "src/platform/actions",
    "src/platform/http",
    "src/platform/proxy",
    "src/platform/observability",
    "src/app",
    "src/ui",
    "src/i18n",
    "src/modules",
  ];

  it.each(coreRoots)(
    "%s imports neither the driver nor the platform",
    (root) => {
      for (const path of collectSourceFiles(root)) {
        for (const specifier of readImports(read(path))) {
          expect(driverPattern.test(specifier), `${path} -> ${specifier}`).toBe(
            false,
          );
          expect(
            specifier.startsWith("@/platform/redis"),
            `${path} -> ${specifier}`,
          ).toBe(false);
        }
      }
    },
  );

  it("is imported by nothing outside its own directory and its own tests", () => {
    const importers = repositorySources.filter(
      (path) =>
        !path.startsWith(`${redisRoot}/`) &&
        readImports(read(path)).some((specifier) =>
          specifier.startsWith("@/platform/redis"),
        ),
    );

    expect(importers).toEqual([
      "tests/fixtures/redis.fixture.ts",
      "tests/redis/redis-foundation.redis.test.ts",
    ]);
  });
});

describe("driver containment", () => {
  it("is imported only inside the Redis platform directory", () => {
    // Contract suites embed probe source as string literals to lint them. Those
    // are samples, not imports, so they are read out of this scan.
    const importers = repositorySources
      .filter((path) => !path.startsWith("tests/contract/"))
      .filter((path) =>
        readImports(read(path)).some((specifier) =>
          driverPattern.test(specifier),
        ),
      );

    for (const path of importers) {
      expect(path.startsWith(`${redisRoot}/`), path).toBe(true);
    }
  });

  it("imports the driver in exactly two places: the client and the type re-export", () => {
    const importers = redisSources.filter((path) =>
      readImports(read(path)).some((specifier) =>
        driverPattern.test(specifier),
      ),
    );

    expect(importers).toEqual([
      `${redisRoot}/client.server.ts`,
      `${redisRoot}/index.server.ts`,
    ]);
  });

  it("declares the driver as the only Redis dependency", () => {
    const allDependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };
    const redisRelated = Object.keys(allDependencies).filter((name) =>
      /redis|bullmq|redlock|upstash|cache|rate-limit/i.test(name),
    );

    expect(redisRelated).toEqual(["redis"]);
  });
});

describe("connection lifecycle", () => {
  it("opens no connection at module import", () => {
    for (const path of redisProductionSources) {
      const source = stripComments(read(path));
      const topLevel = source
        .split("\n")
        .filter((line) => line.length > 0 && !/^[\s})\]]/.test(line));

      expect(topLevel.join("\n"), path).not.toMatch(/^\s*await /m);
      // A call at column zero runs on import; one inside a function does not.
      expect(source, path).not.toMatch(/^(?:createClient|connect)\s*\(/m);
      expect(source, path).not.toMatch(/^\w[\w.]*\.connect\s*\(/m);
    }

    const client = stripComments(read(`${redisRoot}/client.server.ts`));

    // The only `connect` call sits inside the lazy connector.
    expect(client.match(/\.connect\(\)/g)).toHaveLength(1);
    expect(client.indexOf(".connect()")).toBeGreaterThan(
      client.indexOf("async function connect("),
    );
  });

  it("marks every server module with the server-only guard", () => {
    const serverModules = redisProductionSources.filter((path) =>
      path.includes(".server."),
    );

    expect(serverModules.length).toBeGreaterThan(0);

    for (const path of serverModules) {
      expect(read(path).startsWith('import "server-only";'), path).toBe(true);
    }
  });

  it("bounds the reconnect policy", () => {
    const client = stripComments(read(`${redisRoot}/client.server.ts`));

    expect(client).toContain("MAX_RECONNECT_ATTEMPTS");
    expect(client).toContain("reconnectStrategy");
    expect(client).toContain("connectTimeout");
  });

  it("reuses one singleton across a development reload", () => {
    const client = stripComments(read(`${redisRoot}/client.server.ts`));

    expect(client).toContain("globalThis");
    expect(client).toContain("redisClientState");
  });

  it("registers no process signal handler", () => {
    for (const path of redisProductionSources) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/process\.on\(/);
      expect(source, path).not.toMatch(/SIGTERM|SIGINT|beforeExit/);
    }
  });
});

describe("secret hygiene", () => {
  it("logs no URL, credential, or raw error", () => {
    for (const path of redisProductionSources) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/logger\.\w+\([^)]*\burl\b/i);
      expect(source, path).not.toMatch(/password|username|credential/i);
      expect(source, path).not.toMatch(/logger\.\w+\(\s*\{[^}]*\berror\s*[},]/);
      expect(source, path).not.toMatch(/\bconsole\s*\./);
    }
  });

  it("keeps the health result to a status, a latency, and a stable code", () => {
    const health = read(`${redisRoot}/health.server.ts`);

    expect(health).toContain('code: "REDIS_UNAVAILABLE"');
    expect(health).not.toMatch(/error\.message|String\(error\)|\berror\b\s*\}/);
    expect(stripComments(health)).not.toContain("catch (");
  });
});

describe("key discipline", () => {
  it("builds every key through the key module", () => {
    for (const path of repositorySources) {
      if (path.startsWith(`${redisRoot}/`) || path.includes(".test.")) {
        continue;
      }

      expect(stripComments(read(path)), path).not.toMatch(
        /["'][a-z0-9-]+:(?:cache|rate-limit|lock|temporary|idempotency):/,
      );
    }
  });

  it.each([
    { name: "FLUSHDB", pattern: /\bflushdb\b/i },
    { name: "FLUSHALL", pattern: /\bflushall\b/i },
    // `Object.keys` is not the Redis command; a client call is.
    { name: "KEYS", pattern: /\b(?:client|redis)\s*\.\s*keys\s*\(/i },
    { name: "SELECT", pattern: /\b(?:client|redis)\s*\.\s*select\s*\(/i },
    { name: "a database number", pattern: /\bdatabase\s*:\s*\d/ },
  ])("issues no $name in any file that can reach Redis", ({ pattern }) => {
    // Scoped to the files that hold a client. A repository-wide text search
    // would match `Object.keys` and a `<Select>` component and prove nothing.
    const redisCapableFiles = [
      ...redisSources,
      ...collectSourceFiles("tests/redis"),
      "tests/fixtures/redis.fixture.ts",
    ];

    expect(redisCapableFiles.length).toBeGreaterThan(5);

    for (const path of redisCapableFiles) {
      expect(stripComments(read(path)), path).not.toMatch(pattern);
    }
  });

  it("removes test keys with SCAN and UNLINK only", () => {
    const fixture = stripComments(read("tests/fixtures/redis.fixture.ts"));

    expect(fixture).toContain(".scan(");
    expect(fixture).toContain(".unlink(");
    expect(fixture).toContain("redisScopePattern");
  });

  it("separates environments by prefix rather than by database number", () => {
    for (const path of redisProductionSources) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/\bdatabase:\s*\d/);
      expect(source, path).not.toMatch(/\bselect\s*\(/i);
    }

    expect(read(`${redisRoot}/key.ts`)).toContain("<prefix>:<environment>");
  });

  it("scopes a test key to its run", () => {
    expect(read(`${redisRoot}/key.ts`)).toContain("testRunId");
    expect(read(`${redisRoot}/config.ts`)).toContain("generateTestRunId");
  });
});

describe("Docker services", () => {
  it("keeps Redis in its own Compose file and project", () => {
    expect(exists("compose.redis.yaml")).toBe(true);
    expect(exists("compose.redis.env.example")).toBe(true);

    const redisCompose = read("compose.redis.yaml");
    const databaseCompose = read("compose.yaml");

    expect(redisCompose).toContain("next-fullstack-starter-redis");
    expect(redisCompose).not.toContain("postgres");
    expect(databaseCompose).not.toContain("redis");
  });

  it("pins the image and binds to the loopback interface", () => {
    const redisCompose = read("compose.redis.yaml");

    expect(redisCompose).toMatch(/REDIS_IMAGE:-redis:\d+\.\d+\.\d+-alpine/);
    expect(redisCompose).not.toContain(":latest");

    const ports = redisCompose.match(/- "[^"]*:6379"/g) ?? [];

    expect(ports.length).toBe(2);

    for (const port of ports) {
      expect(port).toContain("127.0.0.1:");
    }
  });

  it("gives the test service no persistence and no restart", () => {
    const testService = read("compose.redis.yaml").slice(
      read("compose.redis.yaml").indexOf("redis-test:"),
    );

    expect(testService).toContain('restart: "no"');
    expect(testService).toContain("tmpfs:");
    expect(testService).toContain("redis-cli ping");
  });

  it("bounds resources and logs for both services", () => {
    const redisCompose = read("compose.redis.yaml");

    for (const setting of ["mem_limit", "cpus", "pids_limit", "max-size"]) {
      expect(
        redisCompose.match(new RegExp(setting, "g"))?.length,
        setting,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps the database and Redis scripts independent", () => {
    const { scripts } = packageJson;

    for (const name of [
      "redis:up",
      "redis:down",
      "redis:status",
      "redis:logs",
    ]) {
      expect(scripts[name], name).toContain("compose.redis.yaml");
    }

    for (const name of [
      "redis:test:up",
      "redis:test:down",
      "redis:test:logs",
    ]) {
      expect(scripts[name], name).toContain("compose.redis.yaml");
    }

    for (const name of ["db:up", "db:down", "db:test:up", "db:test:down"]) {
      expect(scripts[name], name).not.toContain("redis");
    }

    for (const [name, script] of Object.entries(scripts)) {
      if (name.startsWith("redis:")) {
        expect(script, name).not.toContain("postgres");
      }
    }
  });
});

describe("verification without Redis", () => {
  it("keeps the Redis suite out of the default configuration", () => {
    const vitestConfig = read("vitest.config.ts");

    expect(vitestConfig).not.toContain("redis");
    expect(exists("vitest.redis.config.ts")).toBe(true);
    expect(read("vitest.redis.config.ts")).toContain(
      "tests/redis/**/*.redis.test.ts",
    );
  });

  it("reaches the Redis suite only through its own script", () => {
    const { scripts } = packageJson;

    expect(scripts["test:redis:integration"]).toBe(
      "vitest run --config vitest.redis.config.ts",
    );

    for (const name of [
      "verify",
      "check",
      "test",
      "test:unit",
      "test:coverage",
    ]) {
      expect(scripts[name], name).not.toContain("redis");
    }
  });

  it("runs the default suite with Redis disabled in CI", () => {
    expect(ciWorkflow).toContain('REDIS_ENABLED: "false"');

    const verifyStep = ciWorkflow.slice(
      ciWorkflow.indexOf("- name: Verify project"),
      ciWorkflow.indexOf("- name: Cache Playwright browsers"),
    );

    expect(verifyStep).not.toContain("REDIS_ENABLED");
    expect(verifyStep).not.toContain("REDIS_URL");
  });

  it("runs the Redis suite as its own enabled step", () => {
    const redisStep = ciWorkflow.slice(
      ciWorkflow.indexOf("- name: Run Redis integration tests"),
    );

    expect(redisStep).toContain('REDIS_ENABLED: "true"');
    expect(redisStep).toContain("REDIS_URL: redis://127.0.0.1:6379");
    expect(redisStep).toContain("REDIS_TEST_RUN_ID: ci-");
    expect(redisStep).toContain("pnpm test:redis:integration");
  });

  it("keeps the required check named Verify and provisions a pinned Redis", () => {
    expect(ciWorkflow).toContain("name: Verify");
    expect(ciWorkflow).toMatch(/image: redis:\d+\.\d+\.\d+-alpine/);
    expect(ciWorkflow).toContain('--health-cmd "redis-cli ping"');
  });

  it("does not wire Redis into the application or the end-to-end run", () => {
    const e2eStep = ciWorkflow.slice(
      ciWorkflow.indexOf("- name: Run end-to-end tests"),
      ciWorkflow.indexOf("- name: Run Redis integration tests"),
    );

    expect(e2eStep).not.toContain("REDIS");
  });
});

describe("ESLint enforcement", () => {
  it("refuses a Redis driver import outside the platform directory", async () => {
    const eslint = new ESLint({ cwd: projectRoot });

    const [outside] = await eslint.lintText(
      `import { createClient } from "redis";\n\nexport const value = createClient;\n`,
      { filePath: "src/platform/http/redis-probe.ts", warnIgnored: true },
    );
    const [inside] = await eslint.lintText(
      `import { createClient } from "redis";\n\nexport const value = createClient;\n`,
      { filePath: `${redisRoot}/redis-probe.ts`, warnIgnored: true },
    );

    const errorsOutside = (outside?.messages ?? []).filter(
      ({ severity }) => severity === 2,
    );
    const driverErrorsInside = (inside?.messages ?? []).filter(
      ({ ruleId }) => ruleId === "architecture/no-redis-driver-import",
    );

    expect(errorsOutside).not.toEqual([]);
    expect(driverErrorsInside).toEqual([]);
  }, 30_000);
});

describe("documentation and removal", () => {
  it("documents the foundation", () => {
    const document = read(
      "docs/architecture/redis-foundation.md",
    ).toLowerCase();

    for (const topic of [
      "optional",
      "when to use redis",
      "when not to use",
      "enabling redis locally",
      "enabling redis in a deployment",
      "connection lifecycle",
      "health contract",
      "key namespaces",
      "test isolation",
      "not implemented",
      "removing redis from a generated project",
    ]) {
      expect(document).toContain(topic);
    }
  });

  it("lists a removal procedure that touches no business code", () => {
    const document = read("docs/architecture/redis-foundation.md");
    const removal = document.slice(
      document.indexOf("## Removing Redis from a generated project"),
    );

    for (const step of [
      "src/platform/redis",
      "compose.redis.yaml",
      "compose.redis.env.example",
      "vitest.redis.config.ts",
      "tests/redis",
      "package.json",
      ".env.example",
      ".github/workflows/ci.yml",
    ]) {
      expect(removal, step).toContain(step);
    }

    for (const untouched of [
      "src/platform/auth",
      "src/platform/database",
      "src/platform/actions",
      "src/platform/http",
      "src/ui",
    ]) {
      expect(removal, untouched).toContain(untouched);
    }
  });

  it.each([
    { name: "the architecture index", path: "docs/architecture/README.md" },
    { name: "the module map", path: "docs/architecture/module-map.md" },
  ])("links the document from $name", ({ path }) => {
    expect(read(path)).toContain("redis-foundation.md");
  });

  it("documents the implementation rules next to the code", () => {
    const document = read(`${redisRoot}/README.md`);

    expect(document).toContain("server-only");
    expect(document).toContain("REDIS_ENABLED");
    expect(read("src/platform/README.md")).toContain("redis/README.md");
    expect(read("src/config/README.md")).toContain("REDIS_ENABLED");
  });
});

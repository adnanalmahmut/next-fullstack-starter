import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The cache and concurrency contract.
 *
 * Three properties dominate every assertion here.
 *
 * **PostgreSQL is the source of truth.** Redis holds copies, counters, and
 * coordination; the Next.js cache holds rendered output. Neither may become the
 * place a business fact lives, and no code may treat one as if it had.
 *
 * **Redis stays optional.** Everything PR #17 established still holds: the
 * application builds, boots, and passes its default suite with no Redis, and
 * removing Redis is a matter of deleting directories.
 *
 * **A fallback is always explicit.** There is no hidden default anywhere for
 * what happens when a control cannot run.
 *
 * These are properties of the repository's shape, so they are asserted against
 * the tree rather than against a running system.
 */
const projectRoot = process.cwd();
const cacheRoot = "src/platform/cache";
const concurrencyRoot = "src/platform/concurrency";

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

function productionFilesOf(root: string): string[] {
  return collectSourceFiles(root).filter((path) => !path.includes(".test."));
}

const repositorySources = [
  ...collectSourceFiles("src"),
  ...collectSourceFiles("tests"),
].filter((path) => !path.startsWith("src/generated/"));

const cacheProduction = productionFilesOf(cacheRoot);
const concurrencyProduction = productionFilesOf(concurrencyRoot);
const controlProduction = [...cacheProduction, ...concurrencyProduction];

const ciWorkflow = read(".github/workflows/ci.yml");
const nextConfig = read("next.config.ts");

describe("the modules exist and are entered through one door", () => {
  it.each([
    `${cacheRoot}/cache-identity.ts`,
    `${cacheRoot}/cache-policy.ts`,
    `${cacheRoot}/cache-invalidation.ts`,
    `${cacheRoot}/cache-invalidation.server.ts`,
    `${cacheRoot}/next-cache.server.ts`,
    `${cacheRoot}/redis-cache-aside.server.ts`,
    `${cacheRoot}/index.server.ts`,
    `${cacheRoot}/README.md`,
    `${concurrencyRoot}/availability-policy.ts`,
    `${concurrencyRoot}/rate-limit.server.ts`,
    `${concurrencyRoot}/idempotency.server.ts`,
    `${concurrencyRoot}/lock.server.ts`,
    `${concurrencyRoot}/route-adapters.server.ts`,
    `${concurrencyRoot}/index.server.ts`,
    `${concurrencyRoot}/README.md`,
  ])("has %s", (path) => {
    expect(exists(path)).toBe(true);
  });

  it.each(controlProduction.filter((path) => path.includes(".server.")))(
    "%s is marked server-only",
    (path) => {
      expect(read(path)).toMatch(/^import "server-only";/m);
    },
  );

  it("names no generic file that would collect unrelated code", () => {
    for (const path of controlProduction) {
      expect(path).not.toMatch(/\/(?:utils|helpers|manager|service)\.ts$/);
    }
  });
});

describe("PostgreSQL remains the source of truth", () => {
  it("keeps persistence out of both control modules", () => {
    for (const path of controlProduction) {
      for (const specifier of readImports(read(path))) {
        expect(
          /^(?:@prisma|prisma$|pg(?:\/|$)|@\/platform\/database|@\/generated)/.test(
            specifier,
          ),
          `${path} -> ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it("keeps the controls out of the repositories that own the data", () => {
    const repositories = [
      "src/platform/audit/audit-repository.server.ts",
      "src/platform/auth/authorization/identity-read.repository.server.ts",
    ];

    for (const path of repositories) {
      for (const specifier of readImports(read(path))) {
        expect(
          specifier.startsWith("@/platform/cache") ||
            specifier.startsWith("@/platform/concurrency"),
          `${path} -> ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it("never answers an authorization decision from a cache", () => {
    // A stale capability is a security bug, not a stale read. The authorization
    // area may not import either control, so a permission is always resolved
    // from the database through Better Auth.
    for (const path of collectSourceFiles("src/platform/auth")) {
      for (const specifier of readImports(read(path))) {
        expect(
          specifier.startsWith("@/platform/cache") ||
            specifier.startsWith("@/platform/concurrency"),
          `${path} -> ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it("documents that these controls are not a substitute for the database", () => {
    const documentation = read(
      "docs/architecture/cache-and-concurrency-controls.md",
    );

    expect(documentation).toMatch(/source of truth/i);
    expect(documentation).toMatch(/not atomic/i);
    expect(documentation).toMatch(/unique constraint/i);
    expect(documentation).toMatch(/transaction/i);
  });

  it("says plainly what is unsafe for a financial operation", () => {
    const documentation = read(
      "docs/architecture/cache-and-concurrency-controls.md",
    );

    expect(documentation).toMatch(/financial/i);
    expect(documentation.toLowerCase()).toContain("redlock");
  });
});

describe("Redis stays optional", () => {
  it("reaches Redis only through its controlled entry point", () => {
    for (const path of controlProduction) {
      for (const specifier of readImports(read(path))) {
        if (!specifier.startsWith("@/platform/redis")) {
          continue;
        }

        expect(specifier, path).toBe("@/platform/redis/index.server");
      }
    }
  });

  it("never imports a Redis driver outside the Redis platform", () => {
    for (const path of controlProduction) {
      for (const specifier of readImports(read(path))) {
        expect(
          /^(?:(?:redis|ioredis)(?:\/|$)|@redis\/)/.test(specifier),
          `${path} -> ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it("names no host, port, or connection string of its own", () => {
    for (const path of controlProduction) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/redis:\/\//);
      expect(source, path).not.toMatch(/\b127\.0\.0\.1\b/);
      expect(source, path).not.toMatch(/\blocalhost\b/);
      expect(source, path).not.toMatch(/\b6379\b/);
    }
  });

  it("wires no existing endpoint to a Redis-dependent control", () => {
    // The adapters exist to be opted into. Making an administration route
    // require Redis in this change would quietly end the optionality.
    for (const path of collectSourceFiles("src/app")) {
      for (const specifier of readImports(read(path))) {
        expect(
          specifier.startsWith("@/platform/concurrency"),
          `${path} -> ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it("declares no rate limit, idempotency, or lock on an existing route", () => {
    for (const path of collectSourceFiles("src/app")) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/\brateLimit\s*:/);
      expect(source, path).not.toMatch(/\bidempotency\s*:/);
      expect(source, path).not.toMatch(/\bwithLock\s*\(/);
    }
  });

  it("keeps the Redis-backed reads out of the module graph a page needs", () => {
    // `cache-identity`, `cache-policy`, and `cache-invalidation` are the parts a
    // module declares against. None of them may drag the client in.
    for (const path of [
      `${cacheRoot}/cache-policy.ts`,
      `${cacheRoot}/cache-invalidation.ts`,
    ]) {
      for (const specifier of readImports(read(path))) {
        expect(specifier.startsWith("@/platform/redis"), path).toBe(false);
      }
    }
  });
});

describe("every fallback is explicit", () => {
  it("offers exactly two availability policies and no default", () => {
    const source = read(`${concurrencyRoot}/availability-policy.ts`);

    expect(source).toContain('REQUIRED: "required"');
    expect(source).toContain('BEST_EFFORT: "best-effort"');
    expect(source).not.toMatch(/DEFAULT_(?:AVAILABILITY_)?POLICY/);
  });

  it("offers exactly two rate-limit fallbacks and no default", () => {
    const source = read(`${concurrencyRoot}/availability-policy.ts`);

    expect(source).toContain('ALLOW: "allow"');
    expect(source).toContain('DENY: "deny"');
    expect(source).not.toMatch(/DEFAULT_RATE_LIMIT_FALLBACK/);
  });

  it("makes the policy a required option on every adapter that needs one", () => {
    const source = read(`${concurrencyRoot}/route-adapters.server.ts`);

    // `policy:` and `fallback:` without a `?`, so a definition cannot omit them.
    expect(source).toMatch(/^\s{2}policy: AvailabilityPolicy;$/m);
    expect(source).toMatch(/^\s{2}fallback: RateLimitFallback;$/m);
  });

  it("makes the lock policy required too", () => {
    expect(read(`${concurrencyRoot}/lock.server.ts`)).toMatch(
      /^\s{4}policy: AvailabilityPolicy;$/m,
    );
  });

  it("documents the fallback matrix", () => {
    const documentation = read(
      "docs/architecture/cache-and-concurrency-controls.md",
    );

    expect(documentation).toMatch(/\|\s*Cache\s*\|/);
    expect(documentation).toMatch(/\|\s*Rate limit\s*\|/);
    expect(documentation).toMatch(/\|\s*Idempotency\s*\|/);
    expect(documentation).toMatch(/\|\s*Lock\s*\|/);
  });
});

describe("Redis command discipline", () => {
  const forbidden = [
    { name: "KEYS", pattern: /\bKEYS\b(?!\[)/ },
    { name: "FLUSHDB", pattern: /\bFLUSHDB\b/ },
    { name: "FLUSHALL", pattern: /\bFLUSHALL\b/ },
    { name: "SELECT", pattern: /\bSELECT\b/ },
  ];

  it.each(forbidden)("never uses $name", ({ pattern }) => {
    for (const path of controlProduction) {
      const source = stripComments(read(path));

      expect(pattern.test(source), path).toBe(false);
    }
  });

  it("never scans on a production read path", () => {
    for (const path of controlProduction) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/\.scan\s*\(/);
      expect(source, path).not.toMatch(/\bSCAN\b/);
    }
  });

  it("uses no wildcard in any key or pattern it builds", () => {
    for (const path of controlProduction) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(
        /redisScopePattern|redisNamespacePattern/,
      );
    }
  });

  it("builds every key through the Redis key builder", () => {
    const keyBuilders = controlProduction.filter((path) =>
      /buildRedisKey/.test(read(path)),
    );

    expect(keyBuilders.length).toBeGreaterThan(0);

    for (const path of controlProduction) {
      const source = stripComments(read(path));

      // No key assembled by hand: a template literal joining segments with the
      // separator would sidestep every validation the builder performs.
      expect(source, path).not.toMatch(/`[^`]*:\$\{[^}]*\}:[^`]*`/);
    }
  });

  it("passes keys through KEYS and values through ARGV in every script", () => {
    for (const path of concurrencyProduction) {
      const source = read(path);
      const scripts = Array.from(
        source.matchAll(/const [A-Z_]+_SCRIPT = `([\s\S]*?)`;/g),
        (match) => match[1] ?? "",
      );

      for (const script of scripts) {
        expect(script, path).toContain("KEYS[1]");
        // A key built inside Lua cannot be routed by a cluster and could be
        // forged from a caller-supplied value.
        expect(script, path).not.toMatch(/KEYS\[\d\]\s*\.\./);
        expect(script, path).not.toMatch(/redis\.call\(\s*'[A-Z]+',\s*ARGV/);
      }
    }
  });

  it("hashes every caller-supplied subject before it reaches a key", () => {
    for (const path of [
      `${concurrencyRoot}/rate-limit.server.ts`,
      `${concurrencyRoot}/idempotency.server.ts`,
    ]) {
      expect(read(path)).toContain("opaqueKeySegment");
    }
  });
});

describe("the Next.js cache is configured, not improvised", () => {
  it("enables Cache Components", () => {
    expect(nextConfig).toContain("cacheComponents: true");
  });

  it("takes its profiles from the platform definitions", () => {
    expect(nextConfig).toContain("cacheLife: CACHE_PROFILE_DEFINITIONS");
  });

  it("registers no custom cache handler", () => {
    // A Redis-backed Next.js cache handler would merge the two stores into one,
    // and the separation is the point of having both.
    expect(nextConfig).not.toContain("cacheHandler");
    expect(nextConfig).not.toContain("incrementalCacheHandlerPath");
  });

  it("uses no pre-Cache-Components caching API anywhere", () => {
    for (const path of collectSourceFiles("src")) {
      const source = stripComments(read(path));

      expect(source, path).not.toContain("unstable_cache");
      expect(source, path).not.toContain("unstable_noStore");
    }
  });

  it("never asks for a remote cache directive", () => {
    for (const path of collectSourceFiles("src")) {
      expect(read(path), path).not.toContain("use cache: remote");
    }
  });

  it("keeps every profile's expiry beyond its revalidation", () => {
    const source = read(`${cacheRoot}/cache-policy.ts`);
    const definitions = Array.from(
      source.matchAll(
        /\{ stale: ([\d_]+), revalidate: ([\d_]+), expire: ([\d_]+) \}/g,
      ),
      (match) =>
        match.slice(1).map((value) => Number(value.replaceAll("_", ""))),
    );

    expect(definitions.length).toBe(3);

    for (const [, revalidate, expire] of definitions) {
      expect(expire).toBeGreaterThan(revalidate as number);
    }
  });
});

describe("invalidation is one system", () => {
  it("has no second invalidation module", () => {
    expect(exists("src/platform/actions/cache-invalidation.server.ts")).toBe(
      false,
    );
  });

  it("is the only place the Next.js invalidation APIs are called", () => {
    const callers = collectSourceFiles("src")
      .filter((path) => !path.includes(".test."))
      .filter((path) =>
        /\b(?:revalidateTag|revalidatePath|updateTag)\s*\(/.test(
          stripComments(read(path)),
        ),
      );

    expect(callers).toEqual([`${cacheRoot}/cache-invalidation.server.ts`]);
  });

  it("restricts updateTag to a Server Action, in code and not only in prose", () => {
    const source = read(`${cacheRoot}/cache-invalidation.server.ts`);

    expect(source).toContain("INVALIDATION_CONTEXT.SERVER_ACTION");
    expect(read(`${cacheRoot}/cache-invalidation.ts`)).toContain(
      "assertInvalidationContext",
    );
  });

  it("is checked when a Route Handler is defined rather than after it commits", () => {
    expect(read("src/platform/http/define-route.server.ts")).toContain(
      "assertInvalidationContext(",
    );
  });

  it("attempts every target and reports instead of throwing", () => {
    const source = read(`${cacheRoot}/cache-invalidation.server.ts`);

    expect(source).toContain("CacheInvalidationReport");
    expect(source).toMatch(/attempted/);
    expect(source).toMatch(/failed/);
  });

  it("deletes Redis entries by exact key", () => {
    const source = stripComments(
      read(`${cacheRoot}/redis-cache-aside.server.ts`),
    );

    expect(source).toContain("client.unlink(keys)");

    // No glob in any string this file builds: deleting by prefix would mean
    // scanning a shared server on a mutation path.
    expect(source).not.toMatch(/["'`][^"'`\n]*\*[^"'`\n]*["'`]/);
  });
});

describe("a use case never sees the infrastructure", () => {
  it.each([
    "src/platform/http/route-context.ts",
    "src/platform/actions/action-context.ts",
  ])("hands no infrastructure client to %s", (path) => {
    const source = stripComments(read(path));

    expect(source).not.toMatch(/\bRedis\b/);
    expect(source).not.toMatch(/\b(?:redisClient|RedisClientType|prisma)\b/);
  });

  it("keeps the idempotency header inside the adapter", () => {
    const readers = collectSourceFiles("src").filter((path) =>
      /idempotency-key/i.test(stripComments(read(path))),
    );

    for (const path of readers) {
      expect(
        path.startsWith(concurrencyRoot) || path.includes(".test."),
        path,
      ).toBe(true);
    }
  });

  it("gives the factory a lifecycle rather than a lookup", () => {
    const hooks = read("src/platform/http/route-hooks.ts");

    expect(hooks).toContain("IdempotencyReservation");
    expect(hooks).toMatch(/complete:/);
    expect(hooks).toMatch(/abort:/);
  });

  it("keeps no module-level state for an in-flight attempt", () => {
    for (const path of concurrencyProduction) {
      const source = stripComments(read(path));

      // A shared map is how a lifecycle leaks between requests and never gets
      // cleaned up. The reservation closure is the whole of the state.
      expect(source, path).not.toMatch(/^(?:const|let)\s+\w+\s*=\s*new Map\(/m);
      expect(source, path).not.toMatch(/globalThis/);
    }
  });
});

describe("logging discipline", () => {
  const allowlist = [
    "module",
    "operation",
    "routeName",
    "requestId",
    "durationMs",
    "outcome",
    "errorCode",
    "retryAfterMs",
    "ttlMs",
  ];

  it("declares the allowlist in one place", () => {
    const source = read("src/platform/observability/control-log-fields.ts");

    for (const field of allowlist) {
      expect(source).toContain(`${field}`);
    }
  });

  it("builds every control log line through that allowlist", () => {
    for (const path of controlProduction) {
      const source = stripComments(read(path));

      if (!/logger|getRequestLogger/.test(source)) {
        continue;
      }

      expect(source, path).toContain("toControlLogFields");
    }
  });

  it("never logs a key, a value, a token, or a raw error", () => {
    for (const path of controlProduction) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(
        /logger\.\w+\(\s*\{[^}]*\b(?:key|value|token|error|input|output|fingerprint|subject)\s*[},]/,
      );
    }
  });

  it("keeps a cache hit off the default log level", () => {
    const source = read(`${cacheRoot}/redis-cache-aside.server.ts`);

    expect(source).toContain("getRequestLogger().debug");
  });
});

describe("the application still works without Redis", () => {
  it("runs the default verification with Redis disabled in CI", () => {
    expect(ciWorkflow).toContain('REDIS_ENABLED: "false"');
    expect(ciWorkflow).toContain("pnpm verify");
  });

  it("runs the end-to-end suite with Redis disabled", () => {
    const e2eStep = ciWorkflow.slice(
      ciWorkflow.indexOf("Run end-to-end tests"),
      ciWorkflow.indexOf("Run Redis integration tests"),
    );

    expect(e2eStep).not.toContain("REDIS_ENABLED");
    expect(e2eStep).not.toContain("REDIS_URL");
  });

  it("exercises the controls only in the opt-in Redis step", () => {
    const redisStep = ciWorkflow.slice(
      ciWorkflow.indexOf("Run Redis integration tests"),
    );

    expect(redisStep).toContain('REDIS_ENABLED: "true"');
    expect(redisStep).toContain("REDIS_URL");
    expect(redisStep).toContain("REDIS_TEST_RUN_ID");
    expect(redisStep).toContain("pnpm test:redis:integration");
  });

  it("keeps the required check named Verify", () => {
    expect(ciWorkflow).toContain("name: Verify");
  });

  it("covers the new controls in the Redis suite", () => {
    expect(exists("tests/redis/cache-concurrency.redis.test.ts")).toBe(true);
  });
});

describe("removing Redis stays a deletion", () => {
  const documentation = read(
    "docs/architecture/cache-and-concurrency-controls.md",
  );
  const removal = read("docs/architecture/redis-foundation.md");

  it("documents what survives the removal", () => {
    expect(removal).toContain("## Removing Redis from a generated project");
    expect(removal).toContain("### What survives");
    expect(removal).toMatch(/profiles/i);
    expect(removal).toMatch(/cache tag/i);
    expect(removal).toMatch(/defineRoute/);
    expect(removal).toMatch(/defineAction/);
  });

  it("names the files a removal deletes", () => {
    for (const path of [
      `${cacheRoot}/redis-cache-aside.server.ts`,
      concurrencyRoot,
    ]) {
      expect(removal).toContain(path);
    }
  });

  it("keeps the Next.js side usable on its own", () => {
    // Deleting Redis must not take the cache profiles or the tags with it.
    for (const path of [
      `${cacheRoot}/cache-policy.ts`,
      `${cacheRoot}/next-cache.server.ts`,
    ]) {
      for (const specifier of readImports(read(path))) {
        expect(specifier.startsWith("@/platform/redis"), path).toBe(false);
      }
    }

    expect(documentation).toMatch(/without Redis/i);
  });
});

describe("scope exclusions", () => {
  it.each([
    { name: "a queue", pattern: /\bbullmq\b/i },
    {
      name: "publish and subscribe",
      pattern: /\b(?:pubsub|publish|subscribe)\b/i,
    },
    { name: "streams", pattern: /\bxadd\b|\bxread\b/i },
    { name: "cluster", pattern: /\bcluster\b/i },
    { name: "sentinel", pattern: /\bsentinel\b/i },
    { name: "Redlock", pattern: /\bredlock\b/i },
  ])("implements no $name", ({ pattern }) => {
    for (const path of controlProduction) {
      expect(pattern.test(stripComments(read(path))), path).toBe(false);
    }
  });

  it("adds no dependency for the controls", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };

    for (const forbidden of ["redlock", "lru-cache", "node-cache"]) {
      expect(Object.keys(manifest.dependencies)).not.toContain(forbidden);
    }

    // `bullmq` and `ioredis` are installed for the background-jobs platform.
    // What matters here is unchanged: neither reaches the controls, which run on
    // the `redis` driver through @/platform/redis.
    for (const path of controlProduction) {
      for (const specifier of readImports(read(path))) {
        expect(/^(?:ioredis|bullmq)(?:\/|$)/.test(specifier), path).toBe(false);
        expect(specifier.startsWith("@/platform/jobs"), path).toBe(false);
      }
    }
  });

  it("stores no session in Redis", () => {
    for (const path of controlProduction) {
      expect(stripComments(read(path)), path).not.toMatch(/\bsession\b/i);
    }
  });
});

describe("test discipline", () => {
  it("skips nothing and focuses on nothing", () => {
    for (const path of repositorySources.filter((candidate) =>
      candidate.includes(".test."),
    )) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(
        /\b(?:it|test|describe)\.(?:skip|todo|only)\b/,
      );
    }
  });

  it("suppresses no type or lint diagnostic", () => {
    // Contract suites embed probe source as string literals to lint it. Those
    // are samples, not suppressions, so they are read out of this scan.
    const scanned = [...controlProduction, ...repositorySources].filter(
      (path) => !path.startsWith("tests/contract/"),
    );

    for (const path of scanned) {
      const source = read(path);

      expect(source, path).not.toContain("@ts-ignore");
      expect(source, path).not.toContain("@ts-expect-error");
      expect(source, path).not.toContain("eslint-disable");
    }
  });

  it("keeps the coverage thresholds where they were", () => {
    const config = read("vitest.config.ts");

    expect(config).toContain("statements: 85");
    expect(config).toContain("branches: 80");
    expect(config).not.toContain("retry:");
  });

  it("raises no global timeout", () => {
    const config = read("vitest.redis.config.ts");

    expect(config).not.toContain("testTimeout");
    expect(config).not.toContain("hookTimeout");
  });
});

/**
 * Probe sources, linted once.
 *
 * Booting ESLint with the full flat config and the TypeScript parser costs
 * several seconds. Doing it inside the first `it` would spend the whole boot
 * against that one case's budget, so the probes are linted here, at module
 * scope, and each assertion below reads a precomputed result. One boot, six
 * properties, and no test timeout to raise.
 */
const lint = new ESLint({ cwd: projectRoot });

async function lintProbe(filePath: string, source: string): Promise<string> {
  const [result] = await lint.lintText(source, {
    filePath: resolve(projectRoot, filePath),
    warnIgnored: true,
  });

  return (result?.messages ?? []).map((message) => message.message).join("\n");
}

const probeResults = {
  redisDriverInCache: await lintProbe(
    `${cacheRoot}/probe.ts`,
    'import { createClient } from "redis";\n\nexport const client = createClient;\n',
  ),
  databaseInCache: await lintProbe(
    `${cacheRoot}/probe.ts`,
    'import { prisma } from "@/platform/database/index.server";\n\nexport const client = prisma;\n',
  ),
  databaseInConcurrency: await lintProbe(
    `${concurrencyRoot}/probe.ts`,
    'import { prisma } from "@/platform/database/index.server";\n\nexport const client = prisma;\n',
  ),
  legacyCacheApi: await lintProbe(
    "src/probe.ts",
    'import { unstable_cache } from "next/cache";\n\nexport const cached = unstable_cache;\n',
  ),
  cacheInAuthorization: await lintProbe(
    "src/platform/auth/authorization/probe.ts",
    'import { cacheAside } from "@/platform/cache/index.server";\n\nexport const read = cacheAside;\n',
  ),
  concurrencyInDomain: await lintProbe(
    "src/modules/probe/domain/probe.ts",
    'import { withLock } from "@/platform/concurrency/index.server";\n\nexport const run = withLock;\n',
  ),
};

describe("the boundaries are enforced by the linter", () => {
  it("refuses a Redis driver import in the cache platform", () => {
    expect(probeResults.redisDriverInCache).toContain(
      "may only be imported inside src/platform/redis/",
    );
  });

  it("refuses persistence in the cache platform", () => {
    expect(probeResults.databaseInCache).toContain("Direct database access");
  });

  it("refuses persistence in the concurrency platform", () => {
    expect(probeResults.databaseInConcurrency).toContain(
      "Direct database access",
    );
  });

  it("refuses the pre-Cache-Components API anywhere in the source tree", () => {
    expect(probeResults.legacyCacheApi).toContain("use cache");
  });

  it("refuses caching inside the authorization area", () => {
    expect(probeResults.cacheInAuthorization).toContain(
      "must not depend on caching",
    );
  });

  it("refuses the concurrency controls inside a module's domain layer", () => {
    expect(probeResults.concurrencyInDomain).toContain(
      "must not depend on the concurrency",
    );
  });
});

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The background-jobs and outbox contract.
 *
 * Four properties dominate every assertion here.
 *
 * **PostgreSQL is the durable source.** A job exists because a committed row
 * says so; Redis holds delivery state and may be lost without losing work.
 *
 * **Background jobs are optional.** The application builds, boots, and passes
 * its default suite with no queue, no worker, and no queue address, and removing
 * the capability is a matter of deleting two directories.
 *
 * **Nothing is fire-and-forget.** Work is recorded inside the transaction that
 * earns it. No route, Action, or module may reach a queue, and no important work
 * may be launched by a floating promise, a timer, or `after()`.
 *
 * **Delivery is at-least-once, and the code says so.** No comment, document, or
 * identifier here claims exactly-once delivery.
 *
 * These are properties of the repository's shape, so they are asserted against
 * the tree rather than against a running system.
 */
const projectRoot = process.cwd();
const jobsRoot = "src/platform/jobs";
const workerRoot = "src/worker";

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

const jobsSources = collectSourceFiles(jobsRoot);
const jobsProduction = productionFilesOf(jobsRoot);
const workerSources = collectSourceFiles(workerRoot);
const workerProduction = productionFilesOf(workerRoot);

const queueDriverPattern = /^(?:ioredis|bullmq)(?:\/|$)/;

const packageJson = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const ciWorkflow = read(".github/workflows/ci.yml");
const documentation = read("docs/architecture/background-jobs-and-outbox.md");
const jobsSchema = read("prisma/jobs.prisma");

describe("background jobs are optional", () => {
  it("default to disabled", () => {
    expect(read("src/config/env/schema.ts")).toContain(
      "JOBS_ENABLED: jobsFlagSchema.default(false)",
    );
    expect(read(".env.example")).toContain("JOBS_ENABLED=false");
  });

  it("are absent from the required server environment", () => {
    const schema = stripComments(read("src/config/env/schema.ts"));
    const serverBlock = schema.slice(
      schema.indexOf("export const serverEnvironmentSchema"),
      schema.indexOf("export const publicEnvironmentSchema"),
    );

    expect(serverBlock).not.toContain("JOBS");
    expect(serverBlock).not.toContain("OUTBOX");
  });

  it("are not read by the eager configuration entry point", () => {
    const entryPoint = read("src/config/env/index.server.ts");

    expect(entryPoint.toLowerCase()).not.toContain("jobs");
    expect(entryPoint.toLowerCase()).not.toContain("outbox");
  });

  it("name no default address and no localhost fallback in production code", () => {
    for (const path of [
      ...jobsProduction,
      ...workerProduction,
      "src/config/env/schema.ts",
      "src/config/env/read-jobs.ts",
    ]) {
      const source = stripComments(read(path));

      expect(source, path).not.toContain("localhost");
      expect(source, path).not.toContain("127.0.0.1");
      expect(source, path).not.toMatch(/rediss?:\/\//);
    }
  });

  it("accept only the two Redis protocols for the queue address", () => {
    const schema = read("src/config/env/schema.ts");
    const jobsBlock = schema.slice(
      schema.indexOf("export const jobsRedisUrlSchema"),
    );

    expect(jobsBlock).toContain("protocol: /^rediss?$/");
  });

  it("bound every configured number on both ends", () => {
    const schema = read("src/config/env/schema.ts");

    for (const name of [
      "JOBS_WORKER_CONCURRENCY",
      "JOBS_WORKER_SHUTDOWN_TIMEOUT_MS",
      "OUTBOX_BATCH_SIZE",
      "OUTBOX_POLL_INTERVAL_MS",
      "OUTBOX_LEASE_MS",
      "OUTBOX_MAX_PUBLISH_ATTEMPTS",
      "OUTBOX_BACKOFF_BASE_MS",
    ]) {
      expect(schema, name).toContain(`${name}: boundedInteger(`);
    }
  });

  it("refuse an unknown jobs variable rather than ignoring it", () => {
    const schema = read("src/config/env/schema.ts");
    const jobsBlock = schema.slice(
      schema.indexOf("export const jobsEnvironmentSchema"),
    );

    expect(jobsBlock).toContain(".strict()");
  });
});

describe("the two configuration levels stay apart", () => {
  it("requires the address only where a queue is built", () => {
    const config = read(`${jobsRoot}/config/jobs-config.ts`);
    const requireBlock = config.slice(
      config.indexOf("export function getJobsRedisConfiguration"),
    );

    expect(requireBlock).toContain("JOBS_REDIS_URL");

    // The only function that reads it, so a call site that needs Redis is
    // visible in a grep.
    const readers = jobsProduction.filter((path) =>
      stripComments(read(path)).includes("JOBS_REDIS_URL"),
    );

    expect(readers).toEqual([`${jobsRoot}/config/jobs-config.ts`]);
  });

  it("never asks where the queue is in order to write an outbox row", () => {
    const writer = stripComments(
      read(`${jobsRoot}/outbox/write-outbox-message.server.ts`),
    );

    expect(writer).toContain("isJobsEnabled");
    expect(writer).not.toContain("getJobsRedisConfiguration");
    expect(writer).not.toContain("requireJobQueue");
    expect(writer).not.toContain("queue");
  });

  it("keeps the queue prefix separate from the cache key prefix", () => {
    // BullMQ manages its own namespace; a shared prefix would put queue keys
    // inside the cache's key space.
    expect(read("src/config/env/schema.ts")).toContain(
      'DEFAULT_JOBS_QUEUE_PREFIX = "next-fullstack-starter-jobs"',
    );
    expect(read("src/config/env/schema.ts")).toContain(
      'DEFAULT_REDIS_KEY_PREFIX = "next-fullstack-starter"',
    );
  });
});

describe("driver containment", () => {
  it("imports the queue driver only inside the jobs platform", () => {
    // Contract suites embed probe source as string literals to lint them. Those
    // are samples, not imports, so they are read out of this scan.
    const importers = repositorySources
      .filter((path) => !path.startsWith("tests/contract/"))
      .filter((path) =>
        readImports(read(path)).some((specifier) =>
          queueDriverPattern.test(specifier),
        ),
      );

    for (const path of importers) {
      expect(path.startsWith(`${jobsRoot}/`), path).toBe(true);
    }
  });

  it("confines the queue driver to the connection and the queue", () => {
    const importers = jobsProduction.filter((path) =>
      readImports(read(path)).some((specifier) =>
        queueDriverPattern.test(specifier),
      ),
    );

    expect(importers).toEqual([
      `${jobsRoot}/execution/job-processor.server.ts`,
      `${jobsRoot}/queue/connection.server.ts`,
      `${jobsRoot}/queue/job-queue.server.ts`,
      // The readiness probe, which takes the `Redis` type only: it builds its
      // bounded connection through `connection.server.ts` like everything else
      // here, and closes it in a `finally`.
      `${jobsRoot}/queue/queue-health.server.ts`,
      `${jobsRoot}/runtime/worker-runtime.server.ts`,
    ]);
  });

  it("never reaches the Redis platform from the jobs platform", () => {
    // BullMQ owns its key layout. Borrowing the cache's key builder would put
    // queue keys in the cache's namespace and tie two removable areas together.
    for (const path of jobsSources) {
      for (const specifier of readImports(read(path))) {
        expect(specifier.startsWith("@/platform/redis"), path).toBe(false);
        expect(/^(?:redis(?:\/|$)|@redis\/)/.test(specifier), path).toBe(false);
        expect(specifier.startsWith("@/platform/cache"), path).toBe(false);
        expect(specifier.startsWith("@/platform/concurrency"), path).toBe(
          false,
        );
      }
    }
  });

  it("declares the queue dependencies at exact versions", () => {
    expect(packageJson.dependencies.bullmq).toBe("5.81.2");
    expect(packageJson.dependencies.ioredis).toBe("5.11.1");
    expect(packageJson.dependencies["@opentelemetry/api"]).toBe("1.9.1");
    // `tsx` runs the worker in production, so it is a dependency rather than a
    // development tool.
    expect(packageJson.dependencies.tsx).toBe("4.23.1");
    expect(packageJson.devDependencies.tsx).toBeUndefined();
  });

  it("adds no second queue, no dashboard, and no tracing SDK", () => {
    const installed = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    for (const forbidden of [
      "bull",
      "agenda",
      "bee-queue",
      "kue",
      "@bull-board/api",
      "@bull-board/express",
      "bull-board",
      "redlock",
      "@opentelemetry/sdk-node",
      "@opentelemetry/sdk-trace-node",
      "@opentelemetry/sdk-trace-base",
      "@opentelemetry/auto-instrumentations-node",
      "@opentelemetry/exporter-trace-otlp-http",
    ]) {
      expect(installed, forbidden).not.toHaveProperty(forbidden);
    }

    const otel = Object.keys(installed).filter((name) =>
      name.startsWith("@opentelemetry/"),
    );

    expect(otel).toEqual(["@opentelemetry/api"]);
  });

  it("keeps the Redis foundation's own driver installed and separate", () => {
    expect(packageJson.dependencies.redis).toBeDefined();

    for (const path of productionFilesOf("src/platform/redis")) {
      for (const specifier of readImports(read(path))) {
        expect(queueDriverPattern.test(specifier), path).toBe(false);
        expect(specifier.startsWith("@/platform/jobs"), path).toBe(false);
      }
    }
  });
});

describe("nothing is fire-and-forget", () => {
  const outsideJobs = repositorySources.filter(
    (path) =>
      !path.startsWith(`${jobsRoot}/`) && !path.startsWith("tests/contract/"),
  );

  it("adds to a queue only inside the jobs platform", () => {
    for (const path of outsideJobs) {
      // Test files legitimately inspect a queue, but they must not publish.
      expect(stripComments(read(path)), path).not.toMatch(
        /\bqueue\s*\.\s*add\s*\(/i,
      );
    }
  });

  it("constructs a Worker only inside the jobs platform", () => {
    for (const path of outsideJobs) {
      expect(stripComments(read(path)), path).not.toMatch(/new\s+Worker\s*\(/);
    }
  });

  it("never leaves a queue operation unawaited inside the jobs platform", () => {
    for (const path of jobsProduction) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/\bvoid\s+queue\s*\./);
      // A `queue.add` on its own line, with nothing awaiting it.
      expect(source, path).not.toMatch(/^\s*queue\s*\.\s*add\s*\(/m);
    }
  });

  it("launches no important work from a timer or from after()", () => {
    for (const path of [
      ...collectSourceFiles("src/app"),
      ...collectSourceFiles("src/modules"),
      ...productionFilesOf("src/platform/actions"),
      ...productionFilesOf("src/platform/http"),
    ]) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/\bsetImmediate\s*\(/);
      expect(source, path).not.toMatch(/\bsetInterval\s*\(/);
      expect(source, path).not.toMatch(/\bqueueMicrotask\s*\(/);
      // Next.js `after()` runs after the response, but not after the process.
      expect(source, path).not.toMatch(
        /\bimport\s*\{[^}]*\bafter\b[^}]*\}\s*from\s*["']next\//,
      );
    }
  });

  it("does not export the queue from the controlled entry point", () => {
    // If business code could reach `queue.add` it would eventually call it next
    // to a transaction rather than inside one. The prose above the exports
    // explains that, so the check reads the code rather than the comment.
    const entryPoint = stripComments(read(`${jobsRoot}/index.server.ts`));

    expect(entryPoint).not.toContain("getJobQueue");
    expect(entryPoint).not.toContain("requireJobQueue");
    expect(entryPoint).toContain("closeJobQueue");
    expect(entryPoint).toContain("writeOutboxMessage");
  });
});

describe("the outbox write is transactional", () => {
  const writer = `${jobsRoot}/outbox/write-outbox-message.server.ts`;

  it("takes a transaction client and refuses the singleton", () => {
    const source = read(writer);

    expect(source).toContain("tx: Prisma.TransactionClient");
    expect(source).toContain("assertTransactionClient");
    expect(stripComments(source)).not.toContain(
      "@/platform/database/index.server",
    );
  });

  it("makes no network call of any kind", () => {
    const source = stripComments(read(writer));

    for (const forbidden of [
      /\bfetch\s*\(/,
      /\baxios\b/,
      /\bhttps?\.request\b/,
    ]) {
      expect(source, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("generates the identifier before the insert", () => {
    const source = stripComments(read(writer));

    expect(source.indexOf("randomUUID()")).toBeLessThan(
      source.indexOf("tx.outboxMessage.create"),
    );
  });

  it("documents the pattern with the mutation inside the transaction", () => {
    expect(documentation).toContain("$transaction");
    expect(documentation).toContain("writeOutboxMessage(tx");
  });
});

describe("the dispatcher", () => {
  const dispatcher = `${jobsRoot}/outbox/outbox-dispatcher.server.ts`;

  it("claims with SKIP LOCKED and a total order", () => {
    const source = read(dispatcher);

    expect(source).toContain("FOR UPDATE SKIP LOCKED");
    expect(source).toContain('ORDER BY c."availableAt", c."createdAt", c."id"');
    expect(source).toContain("LIMIT ${batchSize}");
  });

  it("makes no Redis call while the claim transaction is open", () => {
    const source = stripComments(read(dispatcher));
    const claim = source.slice(
      source.indexOf("async function claim("),
      source.indexOf("async function deadLetter("),
    );

    expect(claim).not.toContain("requireJobQueue");
    expect(claim).not.toContain("queue.add");
  });

  it("publishes under the outbox row's own identifier", () => {
    expect(read(dispatcher)).toContain(
      "jobOptionsFor(row.id, runtime.attempts, runtime.backoff)",
    );
  });

  it("records only a code from a closed set", () => {
    const source = stripComments(read(dispatcher));

    expect(source).not.toMatch(
      /lastErrorCode:\s*(?:String\(|`|error\b|\w*\.message)/,
    );
    expect(source).toContain("OUTBOX_ERROR_CODE.");
  });

  it("keeps a dead-lettered row rather than deleting it", () => {
    const source = stripComments(read(dispatcher));

    expect(source).toContain("deadLetteredAt");
    expect(source).not.toMatch(/outboxMessage\.delete/);
  });
});

describe("the queue's retention", () => {
  it("keeps completed jobs longer than any outbox lease", () => {
    // The retention is load-bearing: a retained completed job is what stops a
    // crash between `queue.add` and the `publishedAt` update from delivering
    // twice.
    const source = read(`${jobsRoot}/queue/job-queue.server.ts`);

    expect(source).toContain("COMPLETED_JOB_RETENTION");
    expect(source).toContain("FAILED_JOB_RETENTION");
    expect(source).not.toContain("removeOnFail: true");
    expect(source).not.toContain("removeOnComplete: true");
  });

  it("treats the failed set as the dead-letter store rather than adding a queue", () => {
    const queueNames = jobsProduction.flatMap((path) =>
      [...stripComments(read(path)).matchAll(/new Queue\(([^,)]+)/g)].map(
        (match) => match[1],
      ),
    );

    expect(queueNames).toEqual(["JOBS_QUEUE_NAME"]);
    expect(documentation.toLowerCase()).toContain("failed set");
  });
});

describe("delivery is at-least-once, and says so", () => {
  it("promises exactly-once delivery nowhere", () => {
    // The phrase is allowed where it is being *denied* — the receipt makes an
    // effect exactly-once, which is a different claim — but never about
    // delivery.
    for (const path of [...jobsSources, ...workerSources, "README.md"]) {
      expect(read(path).toLowerCase(), path).not.toMatch(
        /exactly[- ]once\s+delivery/,
      );
    }

    expect(documentation.toLowerCase()).not.toMatch(
      /(?<!not )exactly[- ]once delivery/,
    );
  });

  it("says so in the documentation, next to the crash window", () => {
    expect(documentation).toContain("at-least-once");
    expect(documentation.toLowerCase()).toContain("crash window");
  });

  it("derives the execution key from the domain, not from a transport id", () => {
    const source = read(`${jobsRoot}/execution/execution-key.ts`);

    expect(source).toContain("jobName");
    expect(source).toContain("jobVersion");
    expect(source).toContain("domainKey");
    expect(stripComments(source)).not.toContain("jobId");
    expect(stripComments(source)).not.toContain("outboxId");
  });

  it("writes the receipt and the effect in one transaction", () => {
    const source = read(
      `${jobsRoot}/execution/run-database-job-once.server.ts`,
    );

    expect(source).toContain("database.$transaction");
    expect(source).toContain("skipDuplicates: true");
    // A caught constraint violation would leave the transaction aborted and the
    // effect unrunnable.
    expect(stripComments(source)).not.toContain("catch");
  });

  it("documents what a receipt does not cover", () => {
    expect(documentation).toContain("provider's own idempotency key");
  });
});

describe("no existing endpoint became job dependent", () => {
  const untouchedRoots = [
    "src/app",
    "src/ui",
    "src/i18n",
    "src/modules",
    "src/platform/auth",
    "src/platform/actions",
    "src/platform/http",
    "src/platform/proxy",
    "src/platform/cache",
    "src/platform/concurrency",
    "src/platform/database",
    "src/platform/observability",
    "src/platform/redis",
  ];

  it.each(untouchedRoots)(
    "%s imports neither the platform nor a driver",
    (root) => {
      for (const path of collectSourceFiles(root)) {
        for (const specifier of readImports(read(path))) {
          expect(
            specifier.startsWith("@/platform/jobs"),
            `${path} -> ${specifier}`,
          ).toBe(false);
          expect(
            specifier.startsWith("@/worker"),
            `${path} -> ${specifier}`,
          ).toBe(false);
          expect(
            queueDriverPattern.test(specifier),
            `${path} -> ${specifier}`,
          ).toBe(false);
        }
      }
    },
  );

  it("declares no job on any route or Action", () => {
    for (const path of collectSourceFiles("src/app")) {
      const source = stripComments(read(path));

      expect(source, path).not.toContain("writeOutboxMessage");
      expect(source, path).not.toContain("defineJob");
    }
  });

  it("ships an empty registry rather than a plausible business job", () => {
    // Read past the prose: the comment shows a worked example, and the example
    // names an imaginary job on purpose.
    const registry = stripComments(read(`${jobsRoot}/definitions/registry.ts`));
    const declaration = registry.slice(
      registry.indexOf("export const JOB_REGISTRY"),
    );

    expect(declaration).toContain("createJobRegistry([])");

    for (const word of [
      "email",
      "invoice",
      "report",
      "notification",
      "welcome",
    ]) {
      expect(declaration.toLowerCase(), word).not.toContain(word);
    }
  });
});

describe("the worker is a process, not part of Next.js", () => {
  it("lives outside the platform and reaches it through the entry point", () => {
    expect(exists(`${workerRoot}/jobs.worker.ts`)).toBe(true);

    for (const path of workerSources) {
      for (const specifier of readImports(read(path))) {
        if (!specifier.startsWith("@/platform/jobs")) {
          continue;
        }

        expect(specifier, path).toBe("@/platform/jobs/index.server");
      }
    }
  });

  it("registers signal handlers only in the entry point", () => {
    for (const path of [
      ...jobsProduction,
      ...productionFilesOf("src/platform/redis"),
    ]) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/process\.on\(/);
      expect(source, path).not.toMatch(/SIGTERM|SIGINT|beforeExit/);
    }

    const entryPoint = read(`${workerRoot}/jobs.worker.ts`);

    expect(entryPoint).toContain("SIGINT");
    expect(entryPoint).toContain("SIGTERM");
  });

  it("attempts a graceful stop before it exits", () => {
    const entryPoint = stripComments(read(`${workerRoot}/jobs.worker.ts`));

    expect(entryPoint).toContain("runtime.stop()");
    expect(entryPoint).not.toMatch(/process\.exit\s*\(/);
  });

  it("bounds the shutdown, because worker.close has no timeout of its own", () => {
    const runtime = read(`${jobsRoot}/runtime/worker-runtime.server.ts`);

    expect(runtime).toContain("workerShutdownTimeoutMs");
    expect(runtime).toContain("settledWithin");
    expect(runtime).toContain("worker.close(true)");
  });

  it("is never started by dev, build, or start", () => {
    for (const name of ["dev", "build", "start"]) {
      expect(packageJson.scripts[name], name).not.toContain("worker");
      expect(packageJson.scripts[name], name).not.toContain("jobs");
    }
  });

  it("has its own scripts, run through tsx", () => {
    expect(packageJson.scripts["jobs:worker"]).toBe(
      "tsx --conditions=react-server src/worker/jobs.worker.ts",
    );
    expect(packageJson.scripts["jobs:worker:dev"]).toContain("tsx watch");

    for (const name of ["jobs:outbox:once", "jobs:status"]) {
      expect(packageJson.scripts[name], name).toContain("tsx");
      expect(packageJson.scripts[name], name).toContain("src/worker/");
    }
  });

  it("runs no polling loop inside the Next.js process", () => {
    for (const path of [
      ...collectSourceFiles("src/app"),
      "src/proxy.ts",
      "src/instrumentation.ts",
    ]) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/\bsetInterval\s*\(/);
      expect(source, path).not.toContain("createOutboxDispatcher");
      expect(source, path).not.toContain("startJobsWorkerRuntime");
    }
  });

  it("opens no connection at module import", () => {
    for (const path of jobsProduction) {
      const source = stripComments(read(path));
      const topLevel = source
        .split("\n")
        .filter((line) => line.length > 0 && !/^[\s})\]]/.test(line));

      expect(topLevel.join("\n"), path).not.toMatch(/^\s*await /m);
      expect(source, path).not.toMatch(/^new (?:Redis|Queue|Worker)\s*\(/m);
    }

    expect(read(`${jobsRoot}/queue/connection.server.ts`)).toContain(
      "lazyConnect: true",
    );
  });

  it("marks every server module with the server-only guard", () => {
    const serverModules = jobsProduction.filter((path) =>
      path.includes(".server."),
    );

    expect(serverModules.length).toBeGreaterThan(0);

    for (const path of [...serverModules, `${jobsRoot}/index.server.ts`]) {
      expect(read(path).startsWith('import "server-only";'), path).toBe(true);
    }
  });
});

describe("secret hygiene", () => {
  it("logs no address, credential, payload, or raw error", () => {
    for (const path of [...jobsProduction, ...workerProduction]) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/logger\.\w+\([^)]*\burl\b/i);
      expect(source, path).not.toMatch(/password|credential/i);
      expect(source, path).not.toMatch(/logger\.\w+\(\s*\{[^}]*\berror\s*[},]/);
      expect(source, path).not.toMatch(/\bconsole\s*\./);
      expect(source, path).not.toMatch(/errorCode:\s*\w+\.message/);
    }
  });

  it("routes every jobs log line through the allowlist", () => {
    const callers = jobsProduction.filter((path) =>
      /\blogger\s*\.\s*(?:debug|info|warn|error)\s*\(/.test(
        stripComments(read(path)),
      ),
    );

    expect(callers).toEqual([]);
  });

  it("keeps the allowlist closed", () => {
    const fields = read(`${jobsRoot}/observability/job-log-fields.ts`);

    for (const forbidden of [
      "payload",
      "result",
      "email",
      "ip",
      "token",
      "headers",
      "baggage",
      "stack",
    ]) {
      expect(
        new RegExp(`^\\s*"?${forbidden}"?[?:]`, "im").test(fields),
        forbidden,
      ).toBe(false);
    }
  });

  it("stores no raw failure in the database", () => {
    // Field declarations only. The prose above them lists what must never be
    // stored, which is the opposite of storing it.
    const fields = jobsSchema
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("///"))
      .join("\n");

    for (const forbidden of [
      "stackTrace",
      "errorMessage",
      "rawError",
      "headers",
      "requestBody",
    ]) {
      expect(fields, forbidden).not.toContain(forbidden);
    }

    expect(fields).toContain("lastErrorCode");
    expect(fields).toContain("deadLetterCode");
  });
});

describe("tracing", () => {
  it("uses the API package and no SDK", () => {
    for (const path of jobsProduction) {
      for (const specifier of readImports(read(path))) {
        if (!specifier.startsWith("@opentelemetry/")) {
          continue;
        }

        expect(specifier, path).toBe("@opentelemetry/api");
      }
    }
  });

  it("carries the two W3C headers and never baggage", () => {
    const traceContext = read(`${jobsRoot}/observability/trace-context.ts`);

    expect(traceContext).toContain("traceparent");
    expect(traceContext).toContain("tracestate");
    expect(stripComments(traceContext)).not.toMatch(/^\s*baggage/m);

    for (const path of jobsProduction) {
      expect(stripComments(read(path)), path).not.toMatch(
        /\bpropagation\s*\.\s*(?:inject|extract)\b/,
      );
    }
  });

  it("validates and bounds what it stores", () => {
    const traceContext = read(`${jobsRoot}/observability/trace-context.ts`);

    expect(traceContext).toContain("MAX_TRACESTATE_LENGTH");
    expect(traceContext).toContain("sanitizeTraceContext");
    expect(jobsSchema).toContain("@db.VarChar(512)");
  });

  it("never fails a job", () => {
    const tracing = read(`${jobsRoot}/observability/tracing.ts`);

    expect(tracing.match(/catch/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});

describe("the schema", () => {
  it("carries everything the dispatcher needs and nothing more", () => {
    for (const field of [
      "jobName",
      "jobVersion",
      "payload",
      "correlationId",
      "causationId",
      "occurredAt",
      "availableAt",
      "publishAttempts",
      "lockedBy",
      "lockedUntil",
      "publishedAt",
      "deadLetteredAt",
      "deadLetterCode",
      "lastErrorCode",
    ]) {
      expect(jobsSchema, field).toContain(field);
    }
  });

  it("indexes the claim query and the lease recovery", () => {
    for (const index of [
      "outbox_message_dispatchable_idx",
      "outbox_message_locked_until_idx",
      "outbox_message_dead_lettered_at_idx",
    ]) {
      expect(jobsSchema, index).toContain(index);
    }
  });

  it("makes the execution key the receipt's identity", () => {
    const receipt = jobsSchema.slice(
      jobsSchema.indexOf("model JobExecutionReceipt"),
    );

    expect(receipt).toContain("executionKey String   @id");
  });

  it("ships as one migration", () => {
    const migrations = readdirSync(resolve(projectRoot, "prisma/migrations"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name.includes("background_jobs"));

    expect(migrations).toHaveLength(1);

    const sql = read(`prisma/migrations/${migrations[0]}/migration.sql`);

    expect(sql).toContain('CREATE TABLE "outbox_message"');
    expect(sql).toContain('CREATE TABLE "job_execution_receipt"');
    expect(sql).not.toMatch(/\bDROP TABLE\b/);
  });
});

describe("verification without a queue", () => {
  it("keeps the jobs suite out of the default configuration", () => {
    const vitestConfig = read("vitest.config.ts");

    // The default configuration may name the worker entry points as a coverage
    // exclusion; what it must never do is run the suite.
    expect(vitestConfig).not.toContain("tests/jobs");
    expect(vitestConfig).not.toContain("vitest.jobs.config");
    expect(exists("vitest.jobs.config.ts")).toBe(true);
    expect(read("vitest.jobs.config.ts")).toContain(
      "tests/jobs/**/*.jobs.test.ts",
    );
  });

  it("reaches the jobs suite only through its own script", () => {
    expect(packageJson.scripts["test:jobs:integration"]).toBe(
      "vitest run --config vitest.jobs.config.ts",
    );

    for (const name of [
      "verify",
      "check",
      "test",
      "test:unit",
      "test:coverage",
    ]) {
      expect(packageJson.scripts[name], name).not.toContain("jobs");
    }
  });

  it("runs the default suite with jobs disabled in CI", () => {
    expect(ciWorkflow).toContain('JOBS_ENABLED: "false"');

    const verifyStep = ciWorkflow.slice(
      ciWorkflow.indexOf("- name: Verify project"),
      ciWorkflow.indexOf("- name: Cache Playwright browsers"),
    );

    expect(verifyStep).not.toContain("JOBS_ENABLED");
    expect(verifyStep).not.toContain("JOBS_REDIS_URL");

    const e2eStep = ciWorkflow.slice(
      ciWorkflow.indexOf("- name: Run end-to-end tests"),
      ciWorkflow.indexOf("- name: Run Redis integration tests"),
    );

    expect(e2eStep).not.toContain("JOBS_ENABLED");
    expect(e2eStep).not.toContain("JOBS_REDIS_URL");
  });

  it("enables jobs in one dedicated step, with its own run identifier", () => {
    const step = ciWorkflow.slice(
      ciWorkflow.indexOf("- name: Run jobs integration tests"),
      ciWorkflow.indexOf("- name: Upload Playwright failure artifacts"),
    );

    expect(step).toContain('JOBS_ENABLED: "true"');
    expect(step).toContain("JOBS_REDIS_URL: redis://127.0.0.1:6379");
    expect(step).toContain("JOBS_TEST_RUN_ID: ci-");
    expect(step).toContain("pnpm test:jobs:integration");
  });

  it("starts no long-lived worker in CI", () => {
    expect(ciWorkflow).not.toContain("jobs:worker");
    expect(ciWorkflow).toContain("name: Verify");
  });

  it("leaves the Redis integration step unchanged", () => {
    expect(ciWorkflow).toContain("pnpm test:redis:integration");
    expect(ciWorkflow).toContain("REDIS_TEST_RUN_ID: ci-");
  });
});

describe("test discipline", () => {
  const jobsTests = collectSourceFiles("tests/jobs");

  it("has a suite", () => {
    expect(jobsTests.length).toBeGreaterThan(0);
  });

  it("skips nothing and focuses on nothing", () => {
    for (const path of jobsTests) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(
        /\b(?:it|test|describe)\.(?:only|skip|todo)\b/,
      );
      expect(source, path).not.toMatch(/\bretry:\s*\d/);
    }
  });

  it("never erases another run's keys", () => {
    for (const path of [...jobsTests, "tests/fixtures/jobs.fixture.ts"]) {
      const source = stripComments(read(path));

      expect(source, path).not.toMatch(/\bflushdb\b/i);
      expect(source, path).not.toMatch(/\bflushall\b/i);
      expect(source, path).not.toMatch(
        /\b(?:client|redis|queue)\s*\.\s*keys\s*\(/i,
      );
    }
  });

  it("scopes every run and bounds every wait", () => {
    const fixture = read("tests/fixtures/jobs.fixture.ts");

    expect(fixture).toContain("JOBS_TEST_RUN_ID");
    expect(fixture).toContain("DEFAULT_DEADLINE_MS");
    expect(fixture).toContain("obliterate");
  });

  it("raises no global timeout", () => {
    const config = read("vitest.jobs.config.ts");

    expect(config).not.toContain("testTimeout");
    expect(config).not.toContain("hookTimeout");
    expect(config).toContain("fileParallelism: false");
  });
});

describe("documentation and removal", () => {
  it("documents the platform", () => {
    const lowercase = documentation.toLowerCase();

    for (const topic of [
      "optionality",
      "when to use a job",
      "when not to use a job",
      "enabling jobs locally",
      "enabling jobs in a deployment",
      "configuration",
      "job definitions",
      "the transactional outbox",
      "the dispatcher",
      "retries, backoff, and timeouts",
      "idempotent execution",
      "poison messages and dead-letters",
      "logging and tracing",
      "the worker process",
      "connections",
      "boundaries",
      "testing",
      "what this change does not do",
      "removing background jobs from a generated project",
    ]) {
      expect(lowercase, topic).toContain(topic);
    }
  });

  it("lists a removal procedure that touches no business code", () => {
    const removal = documentation.slice(
      documentation.indexOf(
        "## Removing background jobs from a generated project",
      ),
    );

    for (const step of [
      "src/platform/jobs",
      "src/worker",
      "prisma/jobs.prisma",
      "vitest.jobs.config.ts",
      "tests/jobs",
      "package.json",
      "eslint.config.mjs",
      ".dependency-cruiser.js",
      ".github/workflows/ci.yml",
      ".env.example",
    ]) {
      expect(removal, step).toContain(step);
    }

    expect(removal).toContain("What survives");
    expect(removal).toContain("removable independently");
  });

  it("is linked from the architecture index and the module map", () => {
    for (const path of [
      "docs/architecture/README.md",
      "docs/architecture/module-map.md",
      "src/platform/README.md",
      "README.md",
    ]) {
      expect(read(path), path).toContain("background-jobs-and-outbox.md");
    }
  });

  it("documents the two levels wherever the variables are described", () => {
    for (const path of [".env.example", "src/config/README.md"]) {
      const source = read(path);

      expect(source, path).toContain("JOBS_ENABLED");
      expect(source, path).toContain("JOBS_REDIS_URL");
    }
  });
});

/**
 * Probe sources, linted once.
 *
 * Booting ESLint with the full flat config and the TypeScript parser costs
 * several seconds. Doing it inside the first `it` would spend the whole boot
 * against that one case's budget, so the probes are linted here, at module
 * scope, and each assertion below reads a precomputed result. One boot, five
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
  queueDriverOutsideJobs: await lintProbe(
    "src/platform/http/probe.ts",
    'import { Queue } from "bullmq";\n\nexport const value = Queue;\n',
  ),
  queueDriverInsideJobs: await lintProbe(
    `${jobsRoot}/probe.ts`,
    'import { Queue } from "bullmq";\n\nexport const value = Queue;\n',
  ),
  cacheDriverInsideJobs: await lintProbe(
    `${jobsRoot}/probe.ts`,
    'import { createClient } from "redis";\n\nexport const value = createClient;\n',
  ),
  jobsInApp: await lintProbe(
    "src/app/probe.ts",
    'import { writeOutboxMessage } from "@/platform/jobs/index.server";\n\nexport const value = writeOutboxMessage;\n',
  ),
  jobsInDomain: await lintProbe(
    "src/modules/probe/domain/probe.ts",
    'import { defineJob } from "@/platform/jobs/index.server";\n\nexport const value = defineJob;\n',
  ),
  workerReachingInternals: await lintProbe(
    `${workerRoot}/probe.ts`,
    'import { requireJobQueue } from "@/platform/jobs/queue/job-queue.server";\n\nexport const value = requireJobQueue;\n',
  ),
};

describe("the boundaries are enforced by the linter", () => {
  it("refuses the queue driver outside the jobs platform", () => {
    expect(probeResults.queueDriverOutsideJobs).toContain(
      "may only be imported inside src/platform/jobs/",
    );
  });

  it("allows it inside", () => {
    expect(probeResults.queueDriverInsideJobs).not.toContain(
      "may only be imported inside",
    );
  });

  it("refuses the cache driver inside the jobs platform", () => {
    // The two drivers are separate: `redis` belongs to the Redis foundation.
    expect(probeResults.cacheDriverInsideJobs).toContain(
      "may only be imported inside src/platform/redis/",
    );
  });

  it("refuses the jobs platform in routing", () => {
    expect(probeResults.jobsInApp).toContain(
      "must not depend on background jobs",
    );
  });

  it("refuses the jobs platform in domain code", () => {
    expect(probeResults.jobsInDomain).toContain(
      "must not depend on background jobs",
    );
  });

  it("refuses a worker reaching past the controlled entry point", () => {
    expect(probeResults.workerReachingInternals).toContain(
      "@/platform/jobs/index.server",
    );
  });
});

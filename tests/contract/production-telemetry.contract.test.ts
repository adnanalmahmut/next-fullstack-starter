import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DATABASE_OPERATIONS,
  METRIC_NAMES,
} from "@/platform/observability/index.server";
import {
  ERROR_BOUNDARY,
  EXPECTED_ERROR_CODES,
} from "@/platform/observability/error-monitoring/error-monitor";
import { STORAGE_OPERATIONS } from "@/platform/storage/provider/instrumented-storage-provider.server";

/**
 * The boundaries production telemetry is allowed to touch, asserted against the
 * repository's shape.
 *
 * The behavioural guarantees — a span that never fails a request, a metric that
 * never carries a payload, an error report rebuilt from an allowlist — are proved
 * by the unit and integration suites. What is asserted here is the structural half
 * that those cannot reach: *where* the SDKs may appear, what may not reach them,
 * and that the areas which must stay independent of telemetry still are.
 *
 * Every assertion below is a property of the tree, so it fails at review time
 * rather than after a deployment.
 */
const projectRoot = process.cwd();
const observabilityRoot = "src/platform/observability";
const telemetryRoot = `${observabilityRoot}/telemetry`;
const errorMonitoringRoot = `${observabilityRoot}/error-monitoring`;

function read(filePath: string): string {
  return readFileSync(resolve(projectRoot, filePath), "utf8");
}

function collectFiles(directory: string, extension: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      return collectFiles(entryPath, extension);
    }

    return entry.name.endsWith(extension) ? [entryPath] : [];
  });
}

function repositoryFiles(root: string): string[] {
  return collectFiles(resolve(projectRoot, root), ".ts")
    .map((path) => relative(projectRoot, path).replaceAll("\\", "/"))
    .sort();
}

const isTest = (path: string) => /\.(?:unit|contract)\.test\.ts$/.test(path);

const sourceFiles = [
  ...repositoryFiles("src"),
  ...repositoryFiles("tests"),
].filter((path) => !path.startsWith("src/generated/"));

const productionFiles = sourceFiles.filter(
  (path) => path.startsWith("src/") && !/\.test\.tsx?$/.test(path),
);

/**
 * Strips comments before matching.
 *
 * Every file in this area documents what it refuses to do, so a naive search finds
 * the prohibition in the prose that explains it.
 */
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
}

function readImports(source: string): string[] {
  return [
    ...source.matchAll(
      /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g,
    ),
  ].map((match) => match[1] ?? "");
}

/* -------------------------------------------------------------------------- */
/* Where the SDKs may appear                                                  */
/* -------------------------------------------------------------------------- */

const OTEL_SDK_PATTERN =
  /^@opentelemetry\/(?!api$)(?:resources|semantic-conventions|sdk-trace|sdk-metrics|core|context-async-hooks|exporter-)/;

describe("the OpenTelemetry SDK", () => {
  it("is imported only by the telemetry lifecycle", () => {
    const importers = productionFiles.filter((path) =>
      readImports(read(path)).some((specifier) =>
        OTEL_SDK_PATTERN.test(specifier),
      ),
    );

    // One file. That is what makes removing telemetry a deletion, and what keeps
    // thirty packages out of every process that logs a line.
    expect(importers).toEqual([`${telemetryRoot}/telemetry-sdk.server.ts`]);
  });

  it("is loaded dynamically, so a disabled deployment never evaluates it", () => {
    const source = read(`${telemetryRoot}/telemetry-sdk.server.ts`);

    const specifiers = readImports(source).filter((name) =>
      OTEL_SDK_PATTERN.test(name),
    );

    expect(specifiers.length).toBeGreaterThan(0);

    for (const specifier of specifiers) {
      const quoted = specifier.replaceAll("/", "\\/");

      // A dynamic import expression, and never a static one. A static import would
      // evaluate the module — constructing nothing, but still paying the load — in
      // a process that asked for no telemetry at all.
      expect(source, specifier).toMatch(
        new RegExp(`import\\(\\s*"${quoted}"\\s*\\)`),
      );
      expect(source, specifier).not.toMatch(
        new RegExp(`^import\\s[^\\n]*"${quoted}"`, "m"),
      );
    }
  });

  it("uses the API facade everywhere else", () => {
    for (const path of productionFiles) {
      if (path === `${telemetryRoot}/telemetry-sdk.server.ts`) {
        continue;
      }

      for (const specifier of readImports(read(path))) {
        if (!specifier.startsWith("@opentelemetry/")) {
          continue;
        }

        expect(specifier, path).toBe("@opentelemetry/api");
      }
    }
  });

  it("adds none of the packages this project refuses", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const installed = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };

    for (const forbidden of [
      // One import for six, and it depends on every transport and exporter this
      // project deliberately does not ship.
      "@opentelemetry/sdk-node",
      // Automatic instrumentation would produce spans nobody wrote, carrying full
      // URLs, query text, and connection details.
      "@opentelemetry/auto-instrumentations-node",
      "@opentelemetry/instrumentation-http",
      "@opentelemetry/instrumentation-pg",
      "@prisma/instrumentation",
      // A second transport for one wire format.
      "@opentelemetry/exporter-trace-otlp-grpc",
      "@opentelemetry/exporter-metrics-otlp-grpc",
      "@opentelemetry/exporter-trace-otlp-proto",
      "@opentelemetry/exporter-metrics-otlp-proto",
      // Signals and backends outside this PR's scope.
      "@opentelemetry/exporter-logs-otlp-http",
      "@opentelemetry/sdk-logs",
      "@opentelemetry/exporter-prometheus",
      "@opentelemetry/exporter-jaeger",
      "@opentelemetry/exporter-zipkin",
      // Browser telemetry, in any form.
      "@opentelemetry/sdk-trace-web",
      "@opentelemetry/instrumentation-document-load",
      "@vercel/otel",
      // Deprecated in favour of `@opentelemetry/sdk-trace`.
      "@opentelemetry/sdk-trace-base",
      "@opentelemetry/sdk-trace-node",
    ]) {
      expect(installed, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it("pins every telemetry dependency to an exact version", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };

    for (const [name, version] of Object.entries(manifest.dependencies)) {
      if (!name.startsWith("@opentelemetry/") && !name.startsWith("@sentry/")) {
        continue;
      }

      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe("the Sentry SDK", () => {
  it("is imported only by the error-monitoring adapter", () => {
    const importers = productionFiles.filter((path) =>
      readImports(read(path)).some((specifier) =>
        specifier.startsWith("@sentry/"),
      ),
    );

    expect(importers).toEqual([
      `${errorMonitoringRoot}/sentry-error-monitor.server.ts`,
    ]);
  });

  it("is loaded dynamically, so a disabled deployment never evaluates it", () => {
    const source = read(
      `${errorMonitoringRoot}/sentry-error-monitor.server.ts`,
    );

    expect(source).toContain('await import("@sentry/node")');
    expect(source).not.toMatch(/^import .*"@sentry\/node"/m);
  });

  it("installs only the server SDK", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const installed = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };

    expect(
      Object.keys(installed).filter((name) => name.startsWith("@sentry/")),
    ).toEqual(["@sentry/node"]);

    for (const forbidden of [
      "@sentry/nextjs",
      "@sentry/react",
      "@sentry/browser",
      "@sentry/replay",
      "@sentry/profiling-node",
      "@sentry/opentelemetry",
    ]) {
      expect(installed, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it("switches off tracing, instrumentation, and every enrichment", () => {
    const source = read(
      `${errorMonitoringRoot}/sentry-error-monitor.server.ts`,
    );

    for (const option of [
      "tracesSampleRate: 0",
      // The important one: left to itself the Node SDK replaces the global
      // OpenTelemetry providers, including the context manager and the propagator.
      "skipOpenTelemetrySetup: true",
      "defaultIntegrations: false",
      "integrations: []",
      "registerEsmLoaderHooks: false",
      "includeLocalVariables: false",
      "sendDefaultPii: false",
      "maxBreadcrumbs: 0",
      "beforeBreadcrumb: () => null",
      "beforeSendTransaction: () => null",
      "beforeSend:",
    ]) {
      expect(source, option).toContain(option);
    }
  });

  it("enables no session replay, profiling, or performance API", () => {
    const source = stripComments(
      read(`${errorMonitoringRoot}/sentry-error-monitor.server.ts`),
    );

    for (const forbidden of [
      "replayIntegration",
      "browserTracingIntegration",
      "nodeProfilingIntegration",
      "profilesSampleRate",
      "profileSessionSampleRate",
      "startSpan",
      "startInactiveSpan",
      "setUser",
      "captureMessage",
      "addBreadcrumb",
      "setContext",
      "setExtra",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("never sends an expected refusal", () => {
    expect([...EXPECTED_ERROR_CODES]).toEqual([
      "VALIDATION_FAILED",
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "NOT_FOUND",
      "CONFLICT",
      "RATE_LIMITED",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* No client and no edge telemetry                                            */
/* -------------------------------------------------------------------------- */

describe("client and edge runtimes", () => {
  it("has no client instrumentation file and no Sentry config files", () => {
    for (const path of [
      "src/instrumentation-client.ts",
      "instrumentation-client.ts",
      "sentry.client.config.ts",
      "sentry.server.config.ts",
      "sentry.edge.config.ts",
      "src/sentry.client.config.ts",
    ]) {
      expect(existsSync(resolve(projectRoot, path)), path).toBe(false);
    }
  });

  it("keeps the Next.js instrumentation entry free of both SDKs", () => {
    const source = read("src/instrumentation.ts");

    expect(source).toContain('process.env.NEXT_RUNTIME !== "nodejs"');
    expect(source).toContain("await import(");
    // The name of neither SDK appears here, so the edge bundle cannot reach one
    // even through a mistyped conditional.
    expect(source).not.toMatch(/sentry|opentelemetry/i);
  });

  it("keeps telemetry out of client components and the proxy", () => {
    const clientAndEdge = productionFiles.filter(
      (path) =>
        path.startsWith("src/ui/") ||
        path === "src/proxy.ts" ||
        path.startsWith("src/platform/proxy/"),
    );

    expect(clientAndEdge.length).toBeGreaterThan(0);

    for (const path of clientAndEdge) {
      for (const specifier of readImports(read(path))) {
        expect(specifier.startsWith("@opentelemetry/"), path).toBe(false);
        expect(specifier.startsWith("@sentry/"), path).toBe(false);
        expect(
          specifier.startsWith("@/platform/observability/telemetry"),
          path,
        ).toBe(false);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Health stays independent                                                   */
/* -------------------------------------------------------------------------- */

describe("operational health", () => {
  it("depends on no part of the telemetry area", () => {
    const healthFiles = productionFiles.filter((path) =>
      path.startsWith("src/platform/health/"),
    );

    expect(healthFiles.length).toBeGreaterThan(0);

    for (const path of healthFiles) {
      for (const specifier of readImports(read(path))) {
        for (const forbidden of [
          "@/platform/observability/telemetry",
          "@/platform/observability/error-monitoring",
          "@/platform/observability/metrics.server",
          "@/platform/observability/database-span.server",
          "@/platform/observability/tracing.server",
          "@opentelemetry/",
          "@sentry/",
        ]) {
          expect(
            specifier.startsWith(forbidden),
            `${path} → ${specifier}`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps the liveness route's import graph unchanged", () => {
    // The liveness endpoint must answer when everything is down, so its reachable
    // set is asserted exhaustively by the operational-health suite. What is checked
    // here is the one thing this PR could have broken: that no telemetry module
    // entered it.
    const source = read("src/app/api/health/live/route.ts");

    expect(readImports(source)).toEqual(["@/platform/health/liveness.server"]);
  });

  it("adds no readiness check for a collector or a vendor", () => {
    for (const path of productionFiles.filter((candidate) =>
      candidate.startsWith("src/platform/health/"),
    )) {
      const source = stripComments(read(path));

      for (const forbidden of [
        "TELEMETRY_ENABLED",
        "TELEMETRY_OTLP_ENDPOINT",
        "SENTRY_DSN",
        "ERROR_MONITORING_ENABLED",
      ]) {
        expect(source, `${path} → ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("does not make the outbox backlog a readiness condition", () => {
    for (const path of productionFiles.filter((candidate) =>
      candidate.startsWith("src/platform/health/"),
    )) {
      expect(stripComments(read(path)), path).not.toContain("backlog");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Closed vocabularies                                                        */
/* -------------------------------------------------------------------------- */

describe("the metric catalog", () => {
  it("is closed, namespaced, and free of business vocabulary", () => {
    expect(METRIC_NAMES.length).toBeGreaterThan(0);

    for (const name of METRIC_NAMES) {
      expect(name, name).toMatch(/^app\.[a-z]+(?:\.[a-z_]+)+$/);
    }
  });

  it("is the only source of instrument names", () => {
    const metricsSource = `${observabilityRoot}/metrics.server.ts`;
    const importers = productionFiles.filter(
      (path) =>
        path !== metricsSource &&
        readImports(read(path)).some(
          (specifier) =>
            specifier.endsWith("/metrics.server") ||
            specifier === "@/platform/observability/index.server",
        ),
    );

    // No call site names a metric: every one of them calls a typed recorder, and
    // the recorders are the only things that touch an instrument.
    for (const path of importers) {
      const source = stripComments(read(path));

      for (const name of METRIC_NAMES) {
        expect(source, `${path} → ${name}`).not.toContain(`"${name}"`);
      }
    }
  });

  it("creates instruments in exactly one file", () => {
    for (const path of productionFiles) {
      const source = stripComments(read(path));

      if (path === `${observabilityRoot}/metrics.server.ts`) {
        continue;
      }

      for (const forbidden of [
        "createCounter",
        "createHistogram",
        "createObservableGauge",
        "createUpDownCounter",
        "addBatchObservableCallback",
      ]) {
        expect(source, `${path} → ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("the database span registry", () => {
  it("names operational boundaries, never tables or statements", () => {
    expect(DATABASE_OPERATIONS.length).toBeGreaterThan(0);

    for (const operation of DATABASE_OPERATIONS) {
      expect(operation, operation).toMatch(/^[a-z][a-z_]*(?:\.[a-z][a-z_]*)+$/);
      expect(operation, operation).not.toMatch(
        /select|insert|update|delete|from|where|join/i,
      );
    }
  });

  it("covers the boundaries this application actually has", () => {
    for (const expected of [
      "audit.append",
      "audit.list",
      "outbox.write",
      "outbox.claim",
      "jobs.execution_receipt",
      "storage.upload_intent.create",
      "storage.finalize.claim",
      "storage.finalize.commit",
      "storage.cleanup.claim",
    ]) {
      expect(DATABASE_OPERATIONS, expected).toContain(expected);
    }
  });
});

describe("the storage span registry", () => {
  it("names the provider operations and not the health probe", () => {
    expect(STORAGE_OPERATIONS).toContain("storage.presign_upload");
    expect(STORAGE_OPERATIONS).not.toContain("storage.check_bucket");

    const source = read(
      "src/platform/storage/provider/instrumented-storage-provider.server.ts",
    );

    // A probe runs on a load balancer's schedule, so counting its failures would
    // make the storage failure metric a graph of probe noise.
    expect(source).toContain("checkBucket: () => provider.checkBucket()");
  });
});

describe("the error-monitoring boundaries", () => {
  it("are a closed set, each owning one class of failure", () => {
    expect(Object.values(ERROR_BOUNDARY).sort()).toEqual([
      "job",
      "outbox",
      "request",
      "route",
      "server_action",
    ]);
  });

  it("capture through the port and never through a vendor", () => {
    const capturers = productionFiles.filter((path) =>
      stripComments(read(path)).includes("captureUnexpectedError("),
    );

    expect(capturers.length).toBeGreaterThan(0);

    for (const path of capturers) {
      if (path === `${errorMonitoringRoot}/error-monitor.server.ts`) {
        continue;
      }

      for (const specifier of readImports(read(path))) {
        expect(specifier.startsWith("@sentry/"), path).toBe(false);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* What may never reach a span, a metric, or an error report                  */
/* -------------------------------------------------------------------------- */

const telemetryOwnedFiles = [
  ...repositoryFiles(observabilityRoot),
  "src/platform/http/route-telemetry.server.ts",
  "src/platform/actions/action-telemetry.server.ts",
  "src/platform/storage/provider/instrumented-storage-provider.server.ts",
  "src/platform/jobs/observability/tracing.ts",
  "src/platform/jobs/outbox/outbox-backlog.server.ts",
].filter((path) => !isTest(path));

describe("no payload, no identity, no secret", () => {
  it("records no exception on a span, anywhere", () => {
    for (const path of productionFiles) {
      // `recordException` copies the message and the stack onto the span, which is
      // the single most reliable way for a payload to reach a third party.
      expect(stripComments(read(path)), path).not.toContain("recordException");
    }
  });

  it("sets no span status message", () => {
    for (const path of telemetryOwnedFiles) {
      const source = stripComments(read(path));
      const statuses = [...source.matchAll(/setStatus\(\s*\{([^}]*)\}/g)];

      for (const status of statuses) {
        expect(status[1] ?? "", path).not.toContain("message");
      }
    }
  });

  it("reads no environment variable outside the configuration boundary", () => {
    const allowed = new Set([
      "src/config/env/read-telemetry.ts",
      "src/config/env/read-error-monitoring.ts",
      "src/instrumentation.ts",
    ]);

    for (const path of telemetryOwnedFiles) {
      if (allowed.has(path)) {
        continue;
      }

      expect(stripComments(read(path)), path).not.toContain("process.env");
    }
  });

  it("uses the structured logger and never the console", () => {
    for (const path of telemetryOwnedFiles) {
      expect(stripComments(read(path)), path).not.toMatch(/\bconsole\s*\./);
    }
  });

  it("never names a credential, a connection string, or a payload field", () => {
    for (const path of telemetryOwnedFiles) {
      const source = stripComments(read(path));

      for (const forbidden of [
        "DATABASE_URL",
        "REDIS_URL",
        "JOBS_REDIS_URL",
        "STORAGE_SECRET_ACCESS_KEY",
        "BETTER_AUTH_SECRET",
      ]) {
        expect(source, `${path} → ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("keeps the OTLP credential and the DSN out of every log allowlist", () => {
    for (const path of [
      `${telemetryRoot}/telemetry-log-fields.ts`,
      `${errorMonitoringRoot}/error-monitor.server.ts`,
    ]) {
      const source = stripComments(read(path));

      expect(source, path).not.toContain("dsn");
      expect(source, path).not.toContain("headers");
      expect(source, path).not.toContain("endpoint");
    }
  });

  it("reads no actor, request, or cookie to describe an operation", () => {
    /**
     * `onRequestError` is handed a request object by Next.js and reads exactly one
     * header from it — the correlation id — which predates this work and is already
     * constrained by the observability contract suite: that suite asserts the
     * reporter passes no raw request, headers, session, or error to Pino. It is
     * excluded here rather than the pattern loosened for every other file.
     */
    const requestBoundaryFiles = new Set([
      `${observabilityRoot}/request-error-reporter.server.ts`,
    ]);

    for (const path of telemetryOwnedFiles) {
      if (requestBoundaryFiles.has(path)) {
        continue;
      }

      const source = stripComments(read(path));

      for (const forbidden of [
        "actor.email",
        "actor.userId",
        "actor.roles",
        "request.headers",
        "request.body",
        "cookies()",
        "headers()",
      ]) {
        expect(source, `${path} → ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("names no attribute after a payload, an identity, or a credential", () => {
    /**
     * Every span attribute, metric dimension, and Sentry tag in this area is a
     * string literal in one of these files, so scanning the literals scans the
     * whole vocabulary at once — including the ones a future change adds.
     *
     * The redaction allowlist is the one file whose entire purpose is to name these
     * words, so it is excluded rather than the pattern weakened for everybody.
     */
    const redactionFiles = new Set([`${observabilityRoot}/redaction.ts`]);
    const forbiddenName =
      /payload|body|input|output|email|password|secret|token|cookie|authorization|actor|user_?id/i;

    for (const path of telemetryOwnedFiles) {
      if (redactionFiles.has(path)) {
        continue;
      }

      const literals = [
        ...stripComments(read(path)).matchAll(/"([^"\n]*)"/g),
      ].map((match) => match[1] ?? "");

      for (const literal of literals) {
        expect(forbiddenName.test(literal), `${path} → "${literal}"`).toBe(
          false,
        );
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Everything is server-only and controlled                                   */
/* -------------------------------------------------------------------------- */

describe("the observability platform's shape", () => {
  it("marks every Node module with the server-only guard", () => {
    const serverModules = repositoryFiles(observabilityRoot).filter(
      (path) => path.includes(".server.") && !isTest(path),
    );

    expect(serverModules.length).toBeGreaterThan(0);

    for (const path of serverModules) {
      expect(read(path).startsWith('import "server-only";'), path).toBe(true);
    }
  });

  it("publishes one controlled entry point with no broad re-export", () => {
    const source = read(`${observabilityRoot}/index.server.ts`);

    expect(source).toMatch(/^import "server-only";/);
    expect(source).not.toMatch(/export\s+\*/);
  });

  it("does not export the Sentry adapter", () => {
    const source = read(`${observabilityRoot}/index.server.ts`);

    // A boundary captures through the port. Exporting the adapter would let a call
    // site reach `Sentry.captureException` past the allowlist.
    expect(source).not.toContain("sentry-error-monitor");
    expect(source).not.toContain("createSentryErrorMonitor");
  });
});

/* -------------------------------------------------------------------------- */
/* No schema change                                                           */
/* -------------------------------------------------------------------------- */

describe("persistence", () => {
  it("adds no migration", () => {
    const migrations = readdirSync(resolve(projectRoot, "prisma/migrations"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    // Telemetry is operational and lossy. It stores nothing, so it needs no table,
    // no column, and no migration.
    for (const name of migrations) {
      expect(name, name).not.toMatch(/telemetry|otel|sentry|trace|metric/i);
    }
  });

  it("reuses the existing trace-context columns", () => {
    const schema = readdirSync(resolve(projectRoot, "prisma"), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".prisma"))
      .map((entry) => read(`prisma/${entry.name}`))
      .join("\n");

    expect(schema).toContain("traceparent");
    expect(schema).toContain("tracestate");
    // The bound the validator enforces is the bound the column carries.
    expect(schema).toContain("@db.VarChar(512)");
  });
});

/* -------------------------------------------------------------------------- */
/* Optionality, end to end                                                    */
/* -------------------------------------------------------------------------- */

describe("the optionality contract", () => {
  it("documents both switches as disabled in the example environment", () => {
    const example = read(".env.example");

    expect(example).toContain("TELEMETRY_ENABLED=false");
    expect(example).toContain("ERROR_MONITORING_ENABLED=false");
    // No endpoint and no DSN are set, even commented-in: there is no default
    // collector and no default vendor.
    expect(example).not.toMatch(/^TELEMETRY_OTLP_ENDPOINT=\S/m);
    expect(example).not.toMatch(/^SENTRY_DSN=\S/m);
  });

  it("uses no localhost fallback in production code", () => {
    for (const path of telemetryOwnedFiles) {
      const source = stripComments(read(path));

      expect(source, path).not.toContain("localhost:4318");
      expect(source, path).not.toContain("127.0.0.1:4318");
    }
  });

  it("runs the default verification with both switches off", () => {
    const workflow = read(".github/workflows/ci.yml");

    expect(workflow).toContain('TELEMETRY_ENABLED: "false"');
    expect(workflow).toContain('ERROR_MONITORING_ENABLED: "false"');
  });

  it("keeps the telemetry suite out of the default configuration", () => {
    const defaultConfig = read("vitest.config.ts");

    expect(defaultConfig).not.toContain("tests/telemetry");

    const telemetryConfig = read("vitest.telemetry.config.ts");

    expect(telemetryConfig).toContain("tests/telemetry/**");
    expect(telemetryConfig).toContain("fileParallelism: false");
  });

  it("gives the telemetry suite its own CI step and no external secret", () => {
    const workflow = read(".github/workflows/ci.yml");

    expect(workflow).toContain("pnpm test:telemetry:integration");
    expect(workflow).not.toContain("secrets.SENTRY_DSN");
    expect(workflow).not.toMatch(/SENTRY_DSN:\s*\S/);
  });
});

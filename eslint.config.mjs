import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import architecturePlugin from "./tools/eslint/architecture-plugin.mjs";

const restrictedImportPatterns = {
  next: {
    regex: "^next(?:/|$)",
    message: "Next.js APIs are not allowed in this architectural layer.",
  },
  react: {
    regex: "^(?:react|react-dom)(?:/|$)",
    message: "React APIs are not allowed in this architectural layer.",
  },
  prisma: {
    regex: "^(?:@prisma(?:/|$)|prisma$|@/generated/prisma(?:/|$))",
    message: "Prisma access is restricted to infrastructure adapters.",
  },
  database: {
    regex: "^@/platform/database(?:/|$)",
    message: "Direct database access is restricted to infrastructure adapters.",
  },
  postgres: {
    regex: "^pg(?:/|$)",
    message:
      "PostgreSQL driver access is restricted to infrastructure adapters.",
  },
  redis: {
    regex: "^(?:(?:redis|ioredis)(?:/|$)|@redis/)",
    message: "Redis access is restricted to infrastructure adapters.",
  },
  queue: {
    regex: "^bullmq(?:/|$)",
    message: "Queue access is restricted to infrastructure adapters.",
  },
  jobs: {
    regex: "^@/platform/jobs(?:/|$)",
    message:
      "This layer must not depend on background jobs. Work is recorded by writing an outbox row inside the transaction that earns it.",
  },
  worker: {
    regex: "^@/worker(?:/|$)",
    message:
      "The worker entry points are a process, not a library. Nothing may import them.",
  },
  audit: {
    regex: "^@/platform/audit(?:/|$)",
    message:
      "This layer must not depend on the audit platform. What is worth recording is a decision the call site makes, not something an adapter or an infrastructure client can know.",
  },
  storage: {
    regex: "^@/platform/storage(?:/|$)",
    message:
      "This layer must not depend on object storage. A module asks for an upload intent through a normal action; bytes never pass through an adapter, a cache, or a queue.",
  },
  awsSdk: {
    regex: "^(?:@aws-sdk/|aws-sdk(?:/|$))",
    message:
      "The AWS SDK belongs to src/platform/storage/provider. Above it the platform speaks a provider-neutral port, so the SDK and the provider can both be replaced without touching the upload lifecycle.",
  },
  cache: {
    regex: "^@/platform/cache(?:/|$)",
    message:
      "This layer must not depend on caching. A cached answer is not an authoritative one.",
  },
  concurrency: {
    regex: "^@/platform/concurrency(?:/|$)",
    message:
      "This layer must not depend on the concurrency controls. Correctness belongs to the database, not to a lock or a counter.",
  },
  betterAuth: {
    regex: "^better-auth(?:/|$)",
    message: "Better Auth must not be accessed from this architectural layer.",
  },
  authServer: {
    regex: "^@/platform/auth/(?:auth|session)\\.server(?:/|$)",
    message:
      "Server-only authentication modules must not be imported by this layer.",
  },
  serverEnvironment: {
    regex: "^@/config/env/index\\.server(?:/|$)",
    message:
      "Server environment configuration must not be imported by this layer.",
  },
  serverOnly: {
    regex: "^server-only$",
    message: "Server-only modules must not be imported by this layer.",
  },
  translations: {
    regex: "^(?:next-intl(?:/|$)|@/i18n(?:/|$))",
    message: "User-facing translation APIs do not belong in this layer.",
  },
};

function restrictImports(...patterns) {
  return [
    "error",
    {
      patterns,
    },
  ];
}

/**
 * The Next.js caching APIs this project does not use.
 *
 * `unstable_cache` predates Cache Components and coexists badly with it: it is a
 * second cache with its own key derivation and its own invalidation, so a project
 * that used both would have two answers to "is this stale?". `"use cache"` and
 * the profiles in `@/platform/cache` are the one way.
 */
const forbiddenCacheImports = {
  name: "next/cache",
  importNames: ["unstable_cache", "unstable_noStore"],
  message:
    "Use the `use cache` directive and @/platform/cache instead of the pre-Cache-Components APIs.",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    name: "architecture/client-components",
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      architecture: architecturePlugin,
    },
    rules: {
      "architecture/no-client-server-boundaries": "error",
    },
  },
  {
    name: "architecture/infrastructure-drivers",
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "tools/**/*.mjs"],
    // The storage test harness is the one exemption, and it is a deliberate
    // one. Creating a bucket, listing a prefix, and deleting in bulk are
    // capabilities the platform must not have — so the suite that needs them
    // builds its own client rather than the platform growing the operations.
    ignores: ["tests/fixtures/storage.fixture.ts", "tests/storage/**/*.ts"],
    // Its own rule rather than a `no-restricted-imports` entry: that option is
    // replaced wholesale by the later, more specific layer blocks, and this
    // boundary has to hold for every file in the repository. It covers all
    // three driver families — `redis` for the Redis platform, `ioredis` and
    // `bullmq` for the jobs platform, `@aws-sdk/*` for the storage provider —
    // and refuses each outside the directory that owns it, including inside
    // another one.
    plugins: {
      architecture: architecturePlugin,
    },
    rules: {
      "architecture/no-redis-driver-import": "error",
    },
  },
  {
    name: "architecture/redis-platform",
    files: ["src/platform/redis/**/*.{ts,tsx}"],
    // The Redis platform owns a connection and a key contract. It must not
    // reach persistence, business code, or rendering, and it must not build a
    // transport response.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.audit,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.react,
        restrictedImportPatterns.translations,
        restrictedImportPatterns.next,
        {
          regex: "^@/platform/(?:actions|http|proxy)(?:/|$)",
          message:
            "The Redis platform must not depend on an application adapter.",
        },
        {
          regex: "^@/(?:app|modules|ui)(?:/|$)",
          message:
            "The Redis platform must not depend on application routing, business modules, or UI code.",
        },
        {
          regex: "^(?:\\.\\.?/)+(?:[^/]+/)*(?:app|modules|ui)(?:/|$)",
          message:
            "The Redis platform must not reach application routing, business modules, or UI code through relative imports.",
        },
      ),
    },
  },
  {
    name: "architecture/no-legacy-cache-apis",
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { paths: [forbiddenCacheImports] }],
    },
  },
  {
    name: "architecture/cache-platform",
    files: ["src/platform/cache/**/*.{ts,tsx}"],
    // The cache platform owns identities, profiles, invalidation, and the
    // cache-aside read. It must not reach persistence — a cache that could read
    // the database itself would be the source of truth by accident — and it must
    // not know any business vocabulary.
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [forbiddenCacheImports],
          patterns: [
            restrictedImportPatterns.prisma,
            restrictedImportPatterns.database,
            restrictedImportPatterns.postgres,
            restrictedImportPatterns.queue,
            restrictedImportPatterns.audit,
            restrictedImportPatterns.jobs,
            restrictedImportPatterns.betterAuth,
            restrictedImportPatterns.react,
            restrictedImportPatterns.translations,
            restrictedImportPatterns.concurrency,
            {
              regex: "^next$|^next/(?!cache$)",
              message:
                "The cache platform may use only the Next.js cache APIs; it must not read a request, redirect, or build a response.",
            },
            {
              regex: "^@/platform/(?:actions|http|proxy|auth)(?:/|$)",
              message:
                "The cache platform must not depend on an application adapter or on authentication.",
            },
            {
              regex: "^@/(?:app|modules|ui)(?:/|$)",
              message:
                "The cache platform must not depend on application routing, business modules, or UI code.",
            },
            {
              regex: "^(?:\\.\\.?/)+(?:[^/]+/)*(?:app|modules|ui)(?:/|$)",
              message:
                "The cache platform must not reach application routing, business modules, or UI code through relative imports.",
            },
          ],
        },
      ],
    },
  },
  {
    name: "architecture/concurrency-platform",
    files: ["src/platform/concurrency/**/*.{ts,tsx}"],
    // The concurrency platform coordinates; it does not persist and it does not
    // decide business outcomes. It may speak the Route Handler contract, because
    // its adapters exist to be handed to `defineRoute`, and nothing else.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.audit,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.react,
        restrictedImportPatterns.translations,
        restrictedImportPatterns.next,
        restrictedImportPatterns.cache,
        {
          regex: "^@/platform/(?:actions|proxy|auth)(?:/|$)",
          message:
            "The concurrency platform must not depend on the Server Action factory, the proxy, or authentication.",
        },
        {
          regex: "^@/(?:app|modules|ui)(?:/|$)",
          message:
            "The concurrency platform must not depend on application routing, business modules, or UI code.",
        },
        {
          regex: "^(?:\\.\\.?/)+(?:[^/]+/)*(?:app|modules|ui)(?:/|$)",
          message:
            "The concurrency platform must not reach application routing, business modules, or UI code through relative imports.",
        },
      ),
    },
  },
  {
    name: "architecture/jobs-platform",
    files: ["src/platform/jobs/**/*.{ts,tsx}"],
    // The jobs platform owns the outbox, the queue, and the worker runtime. It
    // is one of the two areas allowed to reach persistence directly — the outbox
    // *is* a table, and the receipt that makes an effect idempotent has to be
    // written in the caller's transaction — so Prisma is deliberately not
    // restricted here.
    //
    // Everything else is. It must not render, must not read a request, must not
    // know a business module, and must not reach the Redis platform: BullMQ owns
    // its own key layout under its own prefix, and a job that borrowed the
    // cache's key builder would put queue keys inside the cache's namespace.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.react,
        restrictedImportPatterns.next,
        restrictedImportPatterns.translations,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.audit,
        restrictedImportPatterns.cache,
        restrictedImportPatterns.concurrency,
        restrictedImportPatterns.worker,
        {
          regex: "^(?:(?:redis)(?:/|$)|@redis/)",
          message:
            "The jobs platform runs on ioredis through BullMQ; the cache driver belongs to @/platform/redis.",
        },
        {
          regex: "^@/platform/redis(?:/|$)",
          message:
            "The jobs platform must not depend on the Redis platform. BullMQ manages its own namespace, and a queue key must never land in the cache's key space.",
        },
        {
          regex: "^@/platform/(?:actions|http|proxy|auth)(?:/|$)",
          message:
            "The jobs platform must not depend on an application adapter or on authentication.",
        },
        {
          regex: "^@/(?:app|modules|ui)(?:/|$)",
          message:
            "The jobs platform must not depend on application routing, business modules, or UI code.",
        },
        {
          regex: "^(?:\\.\\.?/)+(?:[^/]+/)*(?:app|modules|ui)(?:/|$)",
          message:
            "The jobs platform must not reach application routing, business modules, or UI code through relative imports.",
        },
      ),
    },
  },
  {
    name: "architecture/audit-platform",
    files: ["src/platform/audit/**/*.{ts,tsx}"],
    ignores: ["src/platform/audit/presentation/**/*.{ts,tsx}"],
    // The audit platform owns the record contract and the table behind it, so
    // Prisma is deliberately not restricted: an audit record has to be written
    // in the caller's transaction, and the reader is a keyset query.
    //
    // Everything else is restricted, and the direction of the dependency is the
    // reason. Authentication imports the audit platform; the audit platform must
    // never import authentication, or it would be unusable by a module that has
    // no opinion about how this application authenticates. It must not know a
    // business module, must not render, must not read a request, and must not
    // reach an infrastructure client: an audit write is a durable record, not
    // something to cache, queue, or coordinate with a lock.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.react,
        restrictedImportPatterns.next,
        restrictedImportPatterns.translations,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.worker,
        restrictedImportPatterns.cache,
        restrictedImportPatterns.concurrency,
        restrictedImportPatterns.postgres,
        {
          regex: "^@/platform/auth(?:/|$)",
          message:
            "The audit platform must not depend on authentication. It receives a generic actor; converting a verified session into one belongs to the area that owns the session.",
        },
        {
          regex: "^@/platform/(?:actions|http|proxy)(?:/|$)",
          message:
            "The audit platform must not depend on an application adapter.",
        },
        {
          regex: "^@/(?:app|modules|ui)(?:/|$)",
          message:
            "The audit platform must not depend on application routing, business modules, or UI code.",
        },
        {
          regex: "^(?:\\.\\.?/)+(?:[^/]+/)*(?:app|modules|ui)(?:/|$)",
          message:
            "The audit platform must not reach application routing, business modules, or UI code through relative imports.",
        },
      ),
    },
  },
  {
    name: "architecture/audit-presentation",
    files: ["src/platform/audit/presentation/**/*.{ts,tsx}"],
    // Rendering is the point of these files, so React is allowed. Persistence,
    // authentication, and translation are not: every piece of language arrives
    // as a prop from the composition root, which is what lets one component
    // render any module's actions.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.cache,
        restrictedImportPatterns.concurrency,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.translations,
        restrictedImportPatterns.serverOnly,
        {
          regex: "^@/platform/auth(?:/|$)",
          message:
            "The audit presentation must not depend on authentication; it renders a generic record.",
        },
        {
          regex: "^@/(?:app|modules)(?:/|$)",
          message:
            "The audit presentation must not depend on application routing or business modules.",
        },
      ),
    },
  },
  {
    name: "architecture/storage-platform",
    files: ["src/platform/storage/**/*.{ts,tsx}"],
    ignores: ["src/platform/storage/provider/**/*.{ts,tsx}"],
    // The storage platform owns the upload lifecycle and the two tables behind
    // it, so Prisma is deliberately not restricted: an intent and its object
    // are created in one transaction, and every claim is a conditional update.
    //
    // Everything else is restricted, and the direction is the reason. A future
    // module depends on storage; storage depends on no module, and on no other
    // platform area. It must not authenticate — who may upload is the calling
    // module's decision, not a question a byte store can answer. It must not
    // audit, because what is worth recording about a file is a business
    // judgement. It must not cache, queue, or lock: an object either exists in
    // the bucket or does not, and PostgreSQL is the only thing coordinating a
    // finalization. And it must not render or read a request, because the
    // browser talks to the provider directly and no byte passes through
    // Next.js.
    //
    // The AWS SDK is refused here too. It belongs one directory down, in
    // `provider/`, behind a port that names no AWS type.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.react,
        restrictedImportPatterns.next,
        restrictedImportPatterns.translations,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.audit,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.cache,
        restrictedImportPatterns.concurrency,
        restrictedImportPatterns.worker,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.awsSdk,
        {
          regex: "^@/platform/auth(?:/|$)",
          message:
            "The storage platform must not depend on authentication. Who may upload and who may download are decisions the calling module makes; the platform never receives an actor.",
        },
        {
          regex: "^@/platform/(?:actions|http|proxy)(?:/|$)",
          message:
            "The storage platform must not depend on an application adapter. Bytes never pass through a route handler or a server action.",
        },
        {
          regex: "^@/(?:app|modules|ui)(?:/|$)",
          message:
            "The storage platform must not depend on application routing, business modules, or UI code.",
        },
        {
          regex: "^(?:\\.\\.?/)+(?:[^/]+/)*(?:app|modules|ui)(?:/|$)",
          message:
            "The storage platform must not reach application routing, business modules, or UI code through relative imports.",
        },
      ),
    },
  },
  {
    name: "architecture/storage-provider",
    files: ["src/platform/storage/provider/**/*.{ts,tsx}"],
    // The one directory allowed to hold the AWS SDK, so it is the one block
    // that does not refuse it. Everything else it must not reach is refused for
    // the same reasons as above, and persistence is added to the list: the
    // adapter talks to a bucket and to nothing else, which is what makes "no
    // provider request inside a database transaction" structurally true.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.react,
        restrictedImportPatterns.next,
        restrictedImportPatterns.translations,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.audit,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.cache,
        restrictedImportPatterns.concurrency,
        restrictedImportPatterns.worker,
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        {
          regex: "^@/platform/auth(?:/|$)",
          message: "The storage adapter must not depend on authentication.",
        },
        {
          regex: "^@/platform/(?:actions|http|proxy)(?:/|$)",
          message:
            "The storage adapter must not depend on an application adapter.",
        },
        {
          regex: "^@/(?:app|modules|ui)(?:/|$)",
          message:
            "The storage adapter must not depend on application routing, business modules, or UI code.",
        },
      ),
    },
  },
  {
    name: "architecture/health-platform",
    files: ["src/platform/health/**/*.{ts,tsx}"],
    // The health platform asks three areas whether they are answering and turns
    // the results into one response. It owns no probe of its own, and that is
    // deliberate: the question "is PostgreSQL up" can only be asked by the area
    // that owns the client, so `@/platform/database` is the one persistence
    // import allowed here while Prisma, `pg`, and the Redis and AWS drivers are
    // all refused — a probe that built its own client would put a second
    // connection behind the endpoint a load balancer calls.
    //
    // Background jobs are refused too, and that one is worth stating plainly:
    // web readiness must not check the queue, and if this directory imported the
    // jobs area then deleting background jobs from a generated project would
    // mean editing the health platform. The worker readiness contract takes its
    // checks as arguments for exactly that reason.
    //
    // `next/server` is the one Next.js import allowed, and only for
    // `connection()`: with Cache Components enabled a GET handler that reads no
    // request data is prerendered at build time, and a prerendered liveness
    // answer is produced by `next build` rather than by the process being probed.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.awsSdk,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.worker,
        restrictedImportPatterns.audit,
        restrictedImportPatterns.cache,
        restrictedImportPatterns.concurrency,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.react,
        restrictedImportPatterns.translations,
        {
          regex: "^next$|^next/(?!server$)",
          message:
            "The health platform may use only `connection()` from next/server; it must not read a request, redirect, or mutate a cookie.",
        },
        {
          regex: "^@/platform/auth(?:/|$)",
          message:
            "The health platform must not depend on authentication. An operational probe is called by a load balancer with no credentials, and resolving a session would make the endpoint depend on the database it is trying to report on.",
        },
        {
          regex: "^@/platform/(?:actions|http|proxy)(?:/|$)",
          message:
            "The health platform must not depend on an application adapter. An operational probe answers a flat document and a dynamic 503, neither of which the versioned API contract can express.",
        },
        {
          regex: "^@/(?:app|modules|ui)(?:/|$)",
          message:
            "The health platform must not depend on application routing, business modules, or UI code.",
        },
        {
          regex: "^(?:\\.\\.?/)+(?:[^/]+/)*(?:app|modules|ui)(?:/|$)",
          message:
            "The health platform must not reach application routing, business modules, or UI code through relative imports.",
        },
      ),
    },
  },
  {
    name: "architecture/worker-entry-points",
    files: ["src/worker/**/*.ts"],
    // A worker entry point owns a process: signal handlers, an exit code, and
    // the lifetime of the Prisma connection. It reaches background jobs only
    // through the controlled entry point, so the queue driver stays inside the
    // platform even for the one process built to run it.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.react,
        restrictedImportPatterns.translations,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.audit,
        restrictedImportPatterns.cache,
        restrictedImportPatterns.concurrency,
        {
          regex: "^next(?!/env$)(?:/|$)|^@next/(?!env$)",
          message:
            "A worker is not a Next.js process; only the environment loader may be used.",
        },
        {
          regex: "^@/platform/jobs/(?!index\\.server(?:\\.[cm]?[jt]sx?)?$).+",
          message:
            "A worker entry point must use the controlled entry point @/platform/jobs/index.server.",
        },
        {
          regex: "^@/(?:app|modules|ui|i18n)(?:/|$)",
          message:
            "A worker entry point must not depend on application routing, business modules, UI code, or translations.",
        },
        {
          regex: "^@/platform/(?:actions|http|proxy|auth)(?:/|$)",
          message:
            "A worker serves no request and must not depend on an application adapter or on authentication.",
        },
      ),
    },
  },
  {
    name: "architecture/server-boundaries",
    files: [
      "src/**/index.server.{ts,tsx}",
      "src/modules/*/infrastructure/**/*.{ts,tsx}",
    ],
    rules: {
      "architecture/require-server-only": "error",
    },
  },
  {
    name: "quality/no-production-console",
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.{test,spec}.{ts,tsx}"],
    rules: {
      "no-console": "error",
    },
  },
  {
    name: "architecture/proxy",
    files: ["src/proxy.ts", "src/platform/proxy/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.cache,
        restrictedImportPatterns.concurrency,
        restrictedImportPatterns.react,
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.audit,
        restrictedImportPatterns.jobs,
        {
          regex: "^@/modules(?:/|$)",
          message:
            "The proxy request pipeline must not depend on business modules.",
        },
        {
          regex: "^@/ui(?:/|$)",
          message: "The proxy request pipeline must not depend on UI code.",
        },
        {
          regex: "^(?:\\.\\.?/)+(?:[^/]+/)*(?:modules|ui)(?:/|$)",
          message:
            "The proxy request pipeline must not reach business modules or UI code through relative imports.",
        },
        {
          regex: "^@/platform/auth(?:/|$)",
          message:
            "The proxy request pipeline is not an authorization boundary and must not read authentication state.",
        },
      ),
    },
  },
  {
    name: "architecture/server-actions",
    files: ["src/platform/actions/**/*.{ts,tsx}"],
    // The Action adapter validates, authorizes, normalizes errors, runs hooks,
    // logs, and builds an `ActionResult`. Business logic, persistence, and
    // transport belong to the use case and to the route respectively.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.audit,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.react,
        restrictedImportPatterns.translations,
        {
          regex: "^next$|^next/(?!cache$)",
          message:
            "The Server Action factory may use only the Next.js cache APIs; it must not redirect, mutate cookies, or build an HTTP response.",
        },
        {
          regex: "^@/platform/http(?:/|$)",
          message:
            "The Server Action factory must not build an HTTP response contract.",
        },
        {
          regex: "^@/modules(?:/|$)",
          message:
            "The Server Action factory must not depend on business modules.",
        },
        {
          regex: "^@/ui(?:/|$)",
          message: "The Server Action factory must not depend on UI code.",
        },
        {
          regex: "^(?:\\.\\.?/)+(?:[^/]+/)*(?:modules|ui)(?:/|$)",
          message:
            "The Server Action factory must not reach business modules or UI code through relative imports.",
        },
      ),
    },
  },
  {
    name: "architecture/route-handlers",
    files: ["src/platform/http/**/*.{ts,tsx}"],
    // The Route Handler adapter resolves request context, validates, authorizes,
    // orchestrates hooks, normalizes errors, serializes the envelope, and logs.
    // Business logic, persistence, and rendering belong elsewhere.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.audit,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.react,
        restrictedImportPatterns.translations,
        {
          regex: "^next$|^next/(?!server$)",
          message:
            "The Route Handler factory may use only the Next.js request type; it must not redirect, read ambient headers, or mutate cookies.",
        },
        restrictedImportPatterns.concurrency,
        {
          regex: "^@/platform/actions(?:/|$)",
          message:
            "The Route Handler factory must not depend on the Server Action factory.",
        },
        {
          regex: "^@/(?:app|modules|ui)(?:/|$)",
          message:
            "The Route Handler factory must not depend on application routing, business modules, or UI code.",
        },
        {
          regex: "^(?:\\.\\.?/)+(?:[^/]+/)*(?:app|modules|ui)(?:/|$)",
          message:
            "The Route Handler factory must not reach application routing, business modules, or UI code through relative imports.",
        },
      ),
    },
  },
  {
    name: "architecture/authorization-decisions",
    files: ["src/**/*.{ts,tsx}"],
    // Role names may only be named where roles are defined, where a stored role
    // is normalized, and where the last-administrator policy reasons about them.
    ignores: [
      "src/platform/auth/access-control.ts",
      "src/platform/auth/authorization/role.ts",
      "src/platform/auth/authorization/policies/*.ts",
      "src/**/*.{test,spec}.{ts,tsx}",
    ],
    rules: {
      "architecture/no-role-comparison": "error",
    },
  },
  {
    name: "architecture/auth-platform",
    files: ["src/platform/auth/**/*.{ts,tsx}"],
    // The Better Auth server instance is the single legal database consumer in
    // this area: it hands the shared client to the Prisma adapter. The two
    // repositories are the area's own data-access points and are restricted
    // separately.
    ignores: [
      "src/platform/auth/auth.server.ts",
      "src/platform/auth/authorization/audit/audit-repository.server.ts",
      "src/platform/auth/authorization/identity-read.repository.server.ts",
    ],
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.cache,
        restrictedImportPatterns.concurrency,
        {
          regex: "^@/modules(?:/|$)",
          message:
            "Authentication infrastructure must not depend on business modules.",
        },
      ),
    },
  },
  {
    name: "architecture/auth-server-instance",
    files: ["src/platform/auth/auth.server.ts"],
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.react,
        {
          regex: "^@/modules(?:/|$)",
          message:
            "Authentication infrastructure must not depend on business modules.",
        },
        {
          regex: "^@/ui(?:/|$)",
          message: "Authentication infrastructure must not depend on UI code.",
        },
      ),
    },
  },
  {
    name: "architecture/auth-repositories",
    files: [
      "src/platform/auth/authorization/audit/audit-repository.server.ts",
      "src/platform/auth/authorization/identity-read.repository.server.ts",
    ],
    // Data access is the point of these two files, so Prisma is allowed. Nothing
    // else is: they must not reach routing, UI, translations, or another
    // infrastructure client.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.react,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.translations,
        restrictedImportPatterns.cache,
        restrictedImportPatterns.concurrency,
        {
          regex: "^@/(?:app|ui)(?:/|$)",
          message:
            "A repository must not depend on application routing or UI code.",
        },
        {
          regex: "^@/modules(?:/|$)",
          message:
            "Authentication infrastructure must not depend on business modules.",
        },
      ),
    },
  },
  {
    name: "architecture/auth-client-boundary",
    files: [
      "src/platform/auth/auth-client.ts",
      "src/platform/auth/presentation/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.serverOnly,
        restrictedImportPatterns.authServer,
        restrictedImportPatterns.serverEnvironment,
      ),
    },
  },
  {
    name: "architecture/app-routing",
    files: ["src/app/**/*.{ts,tsx}"],
    // Object storage and the AWS SDK are refused here alongside persistence and
    // the queue. Bytes never pass through Next.js — a module asks for an upload
    // intent through a normal action and the browser uploads straight to the
    // provider — so a routing file that reached for a bucket would be building a
    // path that is not supposed to exist.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.storage,
        restrictedImportPatterns.awsSdk,
      ),
    },
  },
  {
    name: "architecture/versioned-api-adapters",
    files: ["src/app/api/v1/**/route.{ts,tsx}"],
    // A versioned endpoint is a declaration, not an implementation. Everything a
    // handler used to repeat — reading a body, parsing input, checking a
    // capability, catching an error, building a response — belongs to
    // `defineRoute`, and restating it here would create a second contract.
    //
    // This block replaces the `architecture/app-routing` restrictions for these
    // files rather than adding to them, so the persistence patterns are repeated
    // here; a contract test proves both sets still apply.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.storage,
        restrictedImportPatterns.awsSdk,
        restrictedImportPatterns.betterAuth,
        {
          regex: "^@/platform/http/(?!index\\.server(?:\\.[cm]?[jt]sx?)?$).+",
          message:
            "A Route Handler must use the controlled entry point @/platform/http/index.server.",
        },
        {
          regex:
            "^@/platform/auth/authorization/(?:require-permission|actor)\\.server(?:/|$)",
          message:
            "A Route Handler must declare its authorization mode instead of checking a capability itself.",
        },
        {
          regex: "^next/(?:headers|server)$",
          message:
            "A Route Handler must not read the request itself; the factory supplies validated input.",
        },
      ),
      "no-restricted-syntax": [
        "error",
        {
          selector: "TryStatement",
          message:
            "A Route Handler must not map errors itself; the factory normalizes every failure.",
        },
        {
          selector: "NewExpression[callee.name='Response']",
          message:
            "A Route Handler must not build a response; the factory serializes the envelope.",
        },
        {
          selector: "Identifier[name='NextResponse']",
          message:
            "A Route Handler must not build a response; the factory serializes the envelope.",
        },
        {
          selector: "CallExpression[callee.property.name='json']",
          message:
            "A Route Handler must not read a body or serialize a response; the factory owns both.",
        },
        {
          selector:
            "CallExpression[callee.property.name=/^(?:parse|parseAsync|safeParse|safeParseAsync)$/]",
          message:
            "A Route Handler must declare a schema instead of parsing input itself.",
        },
        {
          selector:
            "CallExpression[callee.name=/^require(?:Actor|Permission|AnyPermission|AllPermissions)$/]",
          message:
            "A Route Handler must declare its authorization mode instead of checking a capability itself.",
        },
      ],
    },
  },
  {
    name: "architecture/health-routes",
    files: ["src/app/api/health/**/route.{ts,tsx}"],
    // The two operational probes are the one exception to `defineRoute`, and the
    // exception is exactly two files wide. Each is a declaration: it names a path
    // and takes a handler the health platform built. Everything the factory would
    // otherwise do — reading a request, catching an error, choosing a status,
    // serializing a body — belongs to that adapter, so restating any of it here is
    // refused, and so is wrapping these routes in the factory.
    //
    // This block replaces the `architecture/app-routing` restrictions for these
    // files rather than adding to them, so the persistence patterns are repeated
    // here; a contract test proves both sets still apply.
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.jobs,
        restrictedImportPatterns.storage,
        restrictedImportPatterns.awsSdk,
        restrictedImportPatterns.betterAuth,
        {
          regex: "^@/platform/http(?:/|$)",
          message:
            "An operational probe is not a versioned endpoint and must not be wrapped in the Route Handler factory; it answers a flat document and a dynamic 503.",
        },
        {
          regex:
            "^@/platform/health/(?!(?:index|liveness|readiness)\\.server(?:\\.[cm]?[jt]sx?)?$).+",
          message:
            "A health route must use one of the controlled entry points @/platform/health/{index,liveness,readiness}.server.",
        },
        {
          regex: "^next/(?:headers|server)$",
          message:
            "A health probe must not read the request; the handler the platform builds takes no input at all.",
        },
      ),
      "no-restricted-syntax": [
        "error",
        {
          selector: "TryStatement",
          message:
            "A health route must not map errors itself; the health adapter contains every failure and answers the ordinary document.",
        },
        {
          selector: "NewExpression[callee.name='Response']",
          message:
            "A health route must not build a response; the health adapter serializes the document and sets no-store.",
        },
        {
          selector: "Identifier[name='NextResponse']",
          message:
            "A health route must not build a response; the health adapter serializes the document and sets no-store.",
        },
        {
          selector: "CallExpression[callee.property.name='json']",
          message:
            "A health route must not serialize a response; the health adapter owns the body and the headers.",
        },
      ],
    },
  },
  {
    name: "architecture/better-auth-catch-all",
    files: ["src/app/api/auth/**/*.{ts,tsx}"],
    // Better Auth owns every endpoint under this path. Wrapping it in the
    // application's own factory would validate, authorize, and re-serialize
    // responses the provider is responsible for.
    rules: {
      "no-restricted-imports": restrictImports({
        regex: "^@/platform/http(?:/|$)",
        message:
          "The Better Auth catch-all is provider owned and must not be wrapped in the Route Handler factory.",
      }),
    },
  },
  {
    name: "architecture/domain",
    files: ["src/modules/*/domain/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message:
            "Domain code must not access process or environment variables directly.",
        },
      ],
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.next,
        restrictedImportPatterns.react,
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.serverOnly,
        restrictedImportPatterns.translations,
        restrictedImportPatterns.cache,
        restrictedImportPatterns.concurrency,
        restrictedImportPatterns.jobs,
        {
          regex: "^@/(?:app|config|platform|ui)(?:/|$)",
          message:
            "Domain code may depend only on its own domain and stable shared primitives.",
        },
        {
          regex:
            "^(?:\\.\\.?/)+(?:[^/]+/)*(?:app|config|platform|ui|i18n)(?:/|$)",
          message:
            "Domain code must not escape its layer through relative imports.",
        },
        {
          regex:
            "^@/modules/[^/]+/(?:index\\.(?:server|client)|application|infrastructure|presentation)(?:/|$)",
          message:
            "Domain code must not depend on module entry points or outer layers.",
        },
        {
          regex:
            "^(?:\\.\\.?/)+(?:[^/]+/)*(?:application|infrastructure|presentation)(?:/|$)",
          message:
            "Domain code must not depend on application, infrastructure, or presentation.",
        },
      ),
    },
  },
  {
    name: "architecture/application",
    files: ["src/modules/*/application/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message:
            "Application code must not access process or environment variables directly.",
        },
      ],
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.next,
        restrictedImportPatterns.react,
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.betterAuth,
        restrictedImportPatterns.serverOnly,
        restrictedImportPatterns.translations,
        restrictedImportPatterns.cache,
        restrictedImportPatterns.concurrency,
        restrictedImportPatterns.jobs,
        {
          regex: "^@/(?:app|config|platform|ui)(?:/|$)",
          message:
            "Application code may depend only on domain code, application ports, shared primitives, and controlled module APIs.",
        },
        {
          regex:
            "^(?:\\.\\.?/)+(?:[^/]+/)*(?:app|config|platform|ui|i18n)(?:/|$)",
          message:
            "Application code must not escape its layer through relative imports.",
        },
        {
          regex: "^@/modules/[^/]+/(?:infrastructure|presentation)(?:/|$)",
          message:
            "Application code must not depend on infrastructure or presentation.",
        },
        {
          regex:
            "^(?:\\.\\.?/)+(?:[^/]+/)*(?:infrastructure|presentation)(?:/|$)",
          message:
            "Application code must not depend on infrastructure or presentation.",
        },
      ),
    },
  },
  {
    name: "architecture/infrastructure",
    files: ["src/modules/*/infrastructure/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message:
            "Infrastructure code must use validated configuration instead of accessing process directly.",
        },
      ],
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.next,
        restrictedImportPatterns.react,
        restrictedImportPatterns.translations,
        {
          regex: "^@/(?:app|ui)(?:/|$)",
          message:
            "Infrastructure code must not depend on application routing or UI code.",
        },
        {
          regex: "^(?:\\.\\.?/)+(?:[^/]+/)*(?:app|ui|i18n)(?:/|$)",
          message:
            "Infrastructure code must not reach routing, UI, or translations through relative imports.",
        },
        {
          regex: "^@/modules/[^/]+/presentation(?:/|$)",
          message: "Infrastructure code must not depend on presentation.",
        },
        {
          regex: "^(?:\\.\\.?/)+(?:[^/]+/)*presentation(?:/|$)",
          message: "Infrastructure code must not depend on presentation.",
        },
      ),
    },
  },
  {
    name: "architecture/presentation",
    files: ["src/modules/*/presentation/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "process",
          message:
            "Presentation code must use controlled configuration instead of accessing process directly.",
        },
      ],
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
        restrictedImportPatterns.jobs,
        {
          regex:
            "^@/config/env(?:$|/(?!index\\.client(?:\\.[cm]?[jt]sx?)?$).+)",
          message:
            "Presentation code must not access server environment configuration directly.",
        },
        {
          regex:
            "^(?:\\.\\.?/)+(?:[^/]+/)*(?:config/env|platform/(?:database|redis))(?:/|$)",
          message:
            "Presentation code must not reach environment or persistence infrastructure through relative imports.",
        },
        {
          regex: "^@/modules/[^/]+/infrastructure(?:/|$)",
          message:
            "Presentation code must use application use cases instead of infrastructure.",
        },
        {
          regex: "^(?:\\.\\.?/)+(?:[^/]+/)*infrastructure(?:/|$)",
          message:
            "Presentation code must use application use cases instead of infrastructure.",
        },
      ),
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "blob-report/**",
    "next-env.d.ts",
    "src/generated/prisma/**",
  ]),
]);

export default eslintConfig;

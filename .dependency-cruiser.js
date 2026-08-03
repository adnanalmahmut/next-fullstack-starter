/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular-dependencies",
      comment: "Circular dependencies are forbidden in project source code.",
      severity: "error",
      from: {
        path: "^(?:src|tests)/",
      },
      to: {
        circular: true,
      },
    },
    {
      name: "no-cross-module-internal-imports",
      comment:
        "A module may import another module only through index.server.ts or index.client.ts.",
      severity: "error",
      from: {
        path: "^src/modules/([^/]+)/",
      },
      to: {
        path: "^src/modules/(?!$1/)[^/]+/(?!index\\.(?:server|client)\\.(?:ts|tsx)$).+",
      },
    },
    {
      name: "no-outside-module-internal-imports",
      comment:
        "Code outside modules may access a module only through its controlled public entry points.",
      severity: "error",
      from: {
        path: "^src/(?!modules/|generated/)",
      },
      to: {
        path: "^src/modules/[^/]+/(?!index\\.(?:server|client)\\.(?:ts|tsx)$).+",
      },
    },
    {
      name: "no-queue-driver-outside-jobs",
      comment:
        "BullMQ and the ioredis connection it runs on belong to src/platform/jobs. Keeping every import inside that directory is what makes background jobs removable by deleting it.",
      severity: "error",
      from: {
        path: "^(?:src|tests)/",
        pathNot: "^src/platform/jobs/",
      },
      to: {
        path: "(?:^|/)node_modules/(?:bullmq|ioredis)/",
      },
    },
    {
      name: "no-jobs-platform-internal-imports",
      comment:
        "Background jobs are reached through @/platform/jobs/index.server. The queue itself is deliberately not exported there: work is enqueued by writing an outbox row inside a transaction.",
      severity: "error",
      from: {
        path: "^src/",
        pathNot: "^src/platform/jobs/",
      },
      to: {
        path: "^src/platform/jobs/(?!index\\.server\\.ts$).+",
      },
    },
    {
      name: "no-jobs-in-request-path",
      comment:
        "Routing, UI, and translations must not depend on background jobs. A request records work in its own transaction; it never touches a queue.",
      severity: "error",
      from: {
        path: "^src/(?:app|ui|i18n)/",
      },
      to: {
        path: "^src/(?:platform/jobs|worker)/",
      },
    },
    {
      name: "no-jobs-to-presentation",
      comment:
        "The jobs platform must not depend on routing, UI, translations, or business modules.",
      severity: "error",
      from: {
        path: "^src/(?:platform/jobs|worker)/",
      },
      to: {
        path: "^src/(?:app|ui|i18n|modules)/",
      },
    },
    {
      name: "no-jobs-to-redis-platform",
      comment:
        "BullMQ manages its own key namespace. A job that borrowed the cache's key builder would put queue keys inside the cache's key space, and would tie two independently removable areas together.",
      severity: "error",
      from: {
        path: "^src/platform/jobs/",
      },
      to: {
        path: "^src/platform/(?:redis|cache|concurrency)/",
      },
    },
    {
      name: "no-imports-of-worker-entry-points",
      comment:
        "src/worker holds processes, not libraries. Importing one would install its signal handlers and its exit code into the importing process.",
      severity: "error",
      from: {
        path: "^(?:src|tests)/",
        pathNot: "^src/worker/",
      },
      to: {
        path: "^src/worker/(?!bootstrap\\.ts$).+",
      },
    },
    {
      name: "no-audit-platform-internal-imports",
      comment:
        "The audit platform is reached through @/platform/audit/index.server, or through its presentation component. The repository stays private, so every write goes through the metadata policy and every read goes through the catalog.",
      severity: "error",
      from: {
        path: "^src/",
        pathNot: "^src/platform/audit/",
      },
      to: {
        path: "^src/platform/audit/(?!index\\.server\\.ts$|presentation/).+",
      },
    },
    {
      name: "no-audit-to-authentication",
      comment:
        "The audit platform must not depend on authentication. It receives a generic actor, so a business module can audit without inheriting an opinion about how this application signs people in. The dependency runs the other way.",
      severity: "error",
      from: {
        path: "^src/platform/audit/",
      },
      to: {
        path: "^src/platform/auth/",
      },
    },
    {
      name: "no-audit-to-presentation",
      comment:
        "The audit platform must not depend on routing, translations, or business modules. Its own presentation component receives every piece of language as a prop.",
      severity: "error",
      from: {
        path: "^src/platform/audit/",
      },
      to: {
        path: "^src/(?:app|i18n|modules)/",
      },
    },
    {
      name: "no-audit-to-infrastructure-clients",
      comment:
        "An audit record is durable and is written in the caller's transaction. Caching it, queueing it, or coordinating it with a lock would each weaken that, so the audit platform reaches none of those areas.",
      severity: "error",
      from: {
        path: "^src/platform/audit/",
      },
      to: {
        path: "^src/(?:platform/(?:redis|cache|concurrency|jobs)|worker)/",
      },
    },
    {
      name: "no-storage-driver-outside-provider",
      comment:
        "The AWS SDK belongs to src/platform/storage/provider. Everything above it is written against a provider-neutral port, which is what makes swapping the SDK or the provider a change to one directory. The two test paths build their own client on purpose: creating a bucket, listing a prefix, and deleting in bulk are capabilities production code must not have.",
      severity: "error",
      from: {
        path: "^(?:src|tests)/",
        pathNot:
          "^src/platform/storage/provider/|^tests/fixtures/storage\\.fixture\\.ts$|^tests/storage/",
      },
      to: {
        path: "(?:^|/)node_modules/(?:@aws-sdk/|aws-sdk/)",
      },
    },
    {
      name: "no-minio-sdk",
      comment:
        "MinIO speaks the S3 protocol, so a second client library would be a second code path for one wire format — and the one used only in development would be the one nobody tests against production.",
      severity: "error",
      from: {
        path: "^(?:src|tests)/",
      },
      to: {
        path: "(?:^|/)node_modules/minio/",
      },
    },
    {
      name: "no-storage-platform-internal-imports",
      comment:
        "Object storage is reached through @/platform/storage/index.server. The repository and the S3 client stay private, so no caller can mark an object ready without the verification that precedes it, or address a bucket the configuration did not choose.",
      severity: "error",
      from: {
        path: "^src/",
        pathNot: "^src/platform/storage/",
      },
      to: {
        path: "^src/platform/storage/(?!index\\.server\\.ts$).+",
      },
    },
    {
      name: "no-storage-to-application-areas",
      comment:
        "The storage platform must not depend on authentication, auditing, caching, queues, the worker, routing, UI, translations, or business modules. It stores bytes; who may upload and who may download are decisions the calling module makes.",
      severity: "error",
      from: {
        path: "^src/platform/storage/",
      },
      to: {
        path: "^src/(?:platform/(?:auth|audit|redis|cache|concurrency|jobs)|worker|app|modules|ui|i18n)/",
      },
    },
    {
      name: "no-storage-in-request-path",
      comment:
        "Routing, UI, and translations must not depend on object storage. Bytes never pass through Next.js: a module asks for an upload intent through a normal JSON action, and the browser uploads straight to the provider.",
      severity: "error",
      from: {
        path: "^src/(?:ui|i18n)/",
      },
      to: {
        path: "^src/platform/storage/",
      },
    },
    {
      name: "no-health-platform-internal-imports",
      comment:
        "Operational health is reached through one of its three controlled entry points: index.server.ts for the shared contracts, liveness.server.ts for the liveness handler, readiness.server.ts for the readiness handler. The split is by process — the shared entry point must stay free of Next.js and of the three platform areas a probe asks about, so a worker command can use the contracts without loading them.",
      severity: "error",
      from: {
        path: "^src/",
        pathNot: "^src/platform/health/",
      },
      to: {
        path: "^src/platform/health/(?!(?:index|liveness|readiness)\\.server\\.ts$).+",
      },
    },
    {
      name: "no-health-adapter-outside-health-routes",
      comment:
        "The health adapter is an exception to defineRoute, and the exception is exactly two files wide. Every other endpoint the application owns is built by the Route Handler factory; a third route reaching for this adapter would turn a narrow operational carve-out into a general escape hatch from validation, authorization, and the response envelope.",
      severity: "error",
      from: {
        path: "^src/app/",
        pathNot: "^src/app/api/health/(?:live|ready)/route\\.ts$",
      },
      to: {
        path: "^src/platform/health/",
      },
    },
    {
      name: "no-liveness-reaching-dependencies",
      comment:
        "The liveness endpoint must answer when every external service is down, so its import graph must not reach one — transitively included. Importing the database entry point alone would construct a Prisma client, and the endpoint would still answer 200 while quietly holding a connection pool, which is the failure nobody would ever notice.",
      severity: "error",
      from: {
        path: "^src/app/api/health/live/route\\.ts$",
      },
      to: {
        path: "^src/(?:platform/(?:database|redis|storage|jobs|auth|audit|cache|concurrency)|worker)/|(?:^|/)node_modules/(?:@prisma/|prisma/|pg/|redis/|ioredis/|bullmq/|@aws-sdk/|aws-sdk/|better-auth/)",
        reachable: true,
      },
    },
    {
      name: "no-readiness-reaching-the-queue",
      comment:
        "Web readiness must not depend on background jobs, transitively included. A request records work by writing an outbox row inside its own transaction, so a web instance with no queue and no worker anywhere is ready — and a probe that checked the queue would drain traffic from instances that were serving perfectly because a different deployment was down.",
      severity: "error",
      from: {
        path: "^src/app/api/health/ready/route\\.ts$",
      },
      to: {
        path: "^src/(?:platform/jobs|worker)/|(?:^|/)node_modules/(?:bullmq|ioredis)/",
        reachable: true,
      },
    },
    {
      name: "no-health-to-application-areas",
      comment:
        "The health platform must not depend on authentication, auditing, caching, the concurrency controls, background jobs, the worker, an application adapter, routing, UI, translations, or business modules. It asks three areas whether they are answering and reports the result; who is calling and what it means for a feature are not its questions. Keeping the jobs area out is what lets a generated project delete it without editing this directory.",
      severity: "error",
      from: {
        path: "^src/platform/health/",
      },
      to: {
        path: "^src/(?:platform/(?:auth|audit|cache|concurrency|jobs|actions|http|proxy)|worker|app|modules|ui|i18n)/",
      },
    },
    {
      name: "no-unresolvable-dependencies",
      comment: "All internal dependencies must resolve successfully.",
      severity: "error",
      from: {
        path: "^(?:src|tests)/",
      },
      to: {
        couldNotResolve: true,
      },
    },
  ],
  options: {
    exclude: {
      path: "^src/generated/",
    },
    doNotFollow: {
      path: "^node_modules",
    },
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      // Resolve package `exports` subpaths the way the bundler and TypeScript
      // do, so entries such as `better-auth/plugins/admin` are not reported as
      // unresolvable.
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
    tsPreCompilationDeps: true,
    detectProcessBuiltinModuleCalls: true,
    skipAnalysisNotInRules: true,
  },
};

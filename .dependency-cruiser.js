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

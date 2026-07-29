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
    tsPreCompilationDeps: true,
    detectProcessBuiltinModuleCalls: true,
    skipAnalysisNotInRules: true,
  },
};

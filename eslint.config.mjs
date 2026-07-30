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
  betterAuth: {
    regex: "^better-auth(?:/|$)",
    message: "Better Auth must not be accessed from this architectural layer.",
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

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
    name: "architecture/redis-driver",
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}", "tools/**/*.mjs"],
    // Its own rule rather than a `no-restricted-imports` entry: that option is
    // replaced wholesale by the later, more specific layer blocks, and this
    // boundary has to hold for every file in the repository.
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
    rules: {
      "no-restricted-imports": restrictImports(
        restrictedImportPatterns.prisma,
        restrictedImportPatterns.database,
        restrictedImportPatterns.postgres,
        restrictedImportPatterns.redis,
        restrictedImportPatterns.queue,
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

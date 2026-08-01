import { builtinModules } from "node:module";

const restrictedClientImports = [
  {
    regex: /^server-only$/,
    reason: "The server-only marker cannot be imported into a client module.",
  },
  {
    regex: /^better-auth$/,
    reason: "The Better Auth server entry cannot enter the client bundle.",
  },
  {
    regex: /^(?:@prisma(?:\/|$)|prisma$|@\/generated\/prisma(?:\/|$))/,
    reason: "Prisma is server-only.",
  },
  {
    regex: /^pg(?:\/|$)/,
    reason: "PostgreSQL drivers are server-only.",
  },
  {
    regex: /^(?:(?:redis|ioredis)(?:\/|$)|@redis\/)/,
    reason: "Redis clients are server-only.",
  },
  {
    regex: /^@\/platform\/(?:database|redis)(?:\/|$)/,
    reason: "Infrastructure clients cannot be imported into client modules.",
  },
  {
    regex: /^@\/config\/env(?:$|\/(?!index\.client(?:\.[cm]?[jt]sx?)?$).+)/,
    reason: "Client modules must use the client-safe environment entry point.",
  },
  {
    regex: /^@\/modules\/[^/]+\/index\.server(?:\/|$)/,
    reason: "Client modules must use client-safe module entry points.",
  },
  {
    regex:
      /^(?:@\/modules\/[^/]+\/|(?:\.\.?\/)+(?:[^/]+\/)*)infrastructure(?:\/|$)/,
    reason: "Infrastructure modules cannot enter the client bundle.",
  },
  {
    regex: /(?:^|\/)[^/]+\.server(?:\.[cm]?[jt]sx?)?$/,
    reason: "Files marked as server modules cannot enter the client bundle.",
  },
  {
    regex: /^next\/(?:headers|cache|server)$/,
    reason: "This Next.js API is server-only.",
  },
];

function hasUseClientDirective(program) {
  for (const statement of program.body) {
    if (
      statement.type !== "ExpressionStatement" ||
      statement.expression.type !== "Literal" ||
      typeof statement.expression.value !== "string"
    ) {
      return false;
    }

    if (statement.expression.value === "use client") {
      return true;
    }
  }

  return false;
}

function isClientEntryPoint(filename) {
  const normalizedFilename = filename.replaceAll("\\", "/");

  return /(?:^|\/)index\.client\.[cm]?[jt]sx?$/.test(normalizedFilename);
}

function getStaticString(node) {
  if (!node) {
    return null;
  }

  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }

  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }

  return null;
}

function hasServerOnlyImport(program) {
  return program.body.some(
    (statement) =>
      statement.type === "ImportDeclaration" &&
      statement.specifiers.length === 0 &&
      getStaticString(statement.source) === "server-only",
  );
}

function getMemberPropertyName(node) {
  if (!node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }

  if (
    node.computed &&
    node.property.type === "Literal" &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }

  return null;
}

function isProcessEnvironment(node) {
  return (
    node?.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === "process" &&
    getMemberPropertyName(node) === "env"
  );
}

function getRestrictedImportReason(specifier) {
  if (
    specifier.startsWith("node:") ||
    builtinModules.some(
      (builtinModule) =>
        specifier === builtinModule ||
        specifier.startsWith(`${builtinModule}/`),
    )
  ) {
    return "Node.js built-in modules cannot enter the client bundle.";
  }

  return (
    restrictedClientImports.find(({ regex }) => regex.test(specifier))
      ?.reason ?? null
  );
}

const requireServerOnlyRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        'Require server entry points and infrastructure modules to import "server-only".',
    },
    schema: [],
    messages: {
      missingImport:
        'Server entry points and infrastructure modules must import "server-only".',
    },
  },

  create(context) {
    return {
      Program(node) {
        if (hasServerOnlyImport(node)) {
          return;
        }

        context.report({
          node,
          messageId: "missingImport",
        });
      },
    };
  },
};

const noClientServerBoundariesRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Prevent client modules from importing server-only dependencies or private environment variables.",
    },
    schema: [],
    messages: {
      restrictedImport:
        'Client module must not import "{{specifier}}". {{reason}}',
      privateEnvironment:
        'Client module must not access "{{name}}". Only statically named NEXT_PUBLIC_ variables are allowed.',
    },
  },

  create(context) {
    const filename = context.getFilename();
    let isClientModule = false;

    function checkImportSource(sourceNode) {
      if (!isClientModule) {
        return;
      }

      const specifier = getStaticString(sourceNode);

      if (!specifier) {
        return;
      }

      const reason = getRestrictedImportReason(specifier);

      if (!reason) {
        return;
      }

      context.report({
        node: sourceNode,
        messageId: "restrictedImport",
        data: {
          specifier,
          reason,
        },
      });
    }

    function checkEnvironmentAccess(node) {
      if (!isClientModule) {
        return;
      }

      if (isProcessEnvironment(node)) {
        if (
          node.parent?.type === "MemberExpression" &&
          node.parent.object === node
        ) {
          return;
        }

        context.report({
          node,
          messageId: "privateEnvironment",
          data: {
            name: "process.env",
          },
        });

        return;
      }

      if (!isProcessEnvironment(node.object)) {
        return;
      }

      const variableName = getMemberPropertyName(node);

      if (variableName?.startsWith("NEXT_PUBLIC_")) {
        return;
      }

      context.report({
        node,
        messageId: "privateEnvironment",
        data: {
          name: variableName
            ? `process.env.${variableName}`
            : "dynamic process.env access",
        },
      });
    }

    return {
      Program(node) {
        isClientModule =
          hasUseClientDirective(node) || isClientEntryPoint(filename);
      },

      ImportDeclaration(node) {
        checkImportSource(node.source);
      },

      ExportNamedDeclaration(node) {
        checkImportSource(node.source);
      },

      ExportAllDeclaration(node) {
        checkImportSource(node.source);
      },

      ImportExpression(node) {
        checkImportSource(node.source);
      },

      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length === 1
        ) {
          checkImportSource(node.arguments[0]);
        }
      },

      MemberExpression(node) {
        checkEnvironmentAccess(node);
      },
    };
  },
};

/**
 * The role names an authorization decision must never be based on.
 *
 * The list mirrors `AUTHORIZATION_ROLE_NAMES` in
 * `src/platform/auth/authorization/role.ts`. A contract test asserts the two stay
 * in step, because a role added there without being added here would silently
 * stop being caught.
 */
export const ROLE_LITERALS = ["user", "admin"];

const roleComparisonCallees = new Set([
  "includes",
  "indexOf",
  "some",
  "startsWith",
  "endsWith",
]);

const equalityOperators = new Set(["==", "===", "!=", "!=="]);

function isRoleLiteral(node) {
  return (
    node?.type === "Literal" &&
    typeof node.value === "string" &&
    ROLE_LITERALS.includes(node.value)
  );
}

const noRoleComparisonRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Prevent authorization decisions based on a role name instead of a capability permission.",
    },
    schema: [],
    messages: {
      roleComparison:
        'Do not decide access by comparing the role "{{role}}". Require a capability permission through the centralized authorization helpers.',
    },
  },

  create(context) {
    function report(node) {
      context.report({
        node,
        messageId: "roleComparison",
        data: {
          role: node.value,
        },
      });
    }

    return {
      BinaryExpression(node) {
        if (!equalityOperators.has(node.operator)) {
          return;
        }

        for (const side of [node.left, node.right]) {
          if (isRoleLiteral(side)) {
            report(side);
          }
        }
      },

      CallExpression(node) {
        if (
          node.callee.type !== "MemberExpression" ||
          getMemberPropertyName(node.callee) === null ||
          !roleComparisonCallees.has(getMemberPropertyName(node.callee))
        ) {
          return;
        }

        for (const argument of node.arguments) {
          if (isRoleLiteral(argument)) {
            report(argument);
          }
        }
      },
    };
  },
};

/**
 * The one directory allowed to import a Redis driver.
 *
 * Redis is optional, and staying optional is a property of where its driver is
 * reachable from. Keeping every import inside one directory is what makes
 * removing Redis a matter of deleting that directory rather than auditing the
 * repository for stray imports.
 */
export const REDIS_DRIVER_DIRECTORY = "src/platform/redis/";

const redisDriverPattern = /^(?:(?:redis|ioredis)(?:\/|$)|@redis\/)/;

const noRedisDriverImportRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Restrict Redis driver imports to the Redis platform directory.",
    },
    schema: [],
    messages: {
      restrictedDriver:
        'Do not import "{{specifier}}" here. A Redis driver may only be imported inside {{directory}}; use the controlled entry point @/platform/redis/index.server.',
    },
  },

  create(context) {
    const filename = context.getFilename().replaceAll("\\", "/");

    if (filename.includes(REDIS_DRIVER_DIRECTORY)) {
      return {};
    }

    function check(sourceNode) {
      const specifier = getStaticString(sourceNode);

      if (!specifier || !redisDriverPattern.test(specifier)) {
        return;
      }

      context.report({
        node: sourceNode,
        messageId: "restrictedDriver",
        data: { specifier, directory: REDIS_DRIVER_DIRECTORY },
      });
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length === 1
        ) {
          check(node.arguments[0]);
        }
      },
    };
  },
};

const architecturePlugin = {
  meta: {
    name: "next-fullstack-architecture",
    version: "0.1.0",
  },

  rules: {
    "no-client-server-boundaries": noClientServerBoundariesRule,
    "no-redis-driver-import": noRedisDriverImportRule,
    "no-role-comparison": noRoleComparisonRule,
    "require-server-only": requireServerOnlyRule,
  },
};

export default architecturePlugin;

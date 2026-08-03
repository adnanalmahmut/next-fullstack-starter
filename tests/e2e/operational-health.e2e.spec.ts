import { expect, test } from "@playwright/test";

/**
 * The two probes, through a real server.
 *
 * This is the one place the guarantees can be checked end to end, and it earns its
 * place by catching a class of failure no route or contract test can see.
 *
 * With Cache Components enabled, a `GET` Route Handler that reads no request data
 * is prerendered at build time. Both handlers call `connection()` to prevent that,
 * but whether it actually works is a fact about `next build` and the server — and
 * if it silently stopped working, liveness would become a static document produced
 * by the build, readiness would freeze whatever the build machine could reach, and
 * every unit test would still pass. Asking a running server for the body, the
 * status, and the headers is the only way to know.
 *
 * It also proves the proxy leaves both paths alone: `/api` is a non-localized
 * subtree, so a probe must not be answered with a `307` to `/ar/api/health/live`,
 * which no load balancer would follow.
 */
const livenessPath = "/api/health/live";
const readinessPath = "/api/health/ready";

test.describe("operational health", () => {
  test.describe("liveness", () => {
    test("answers 200 with the constant document", async ({ request }) => {
      const response = await request.get(livenessPath);

      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({
        status: "live",
        code: "PROCESS_ALIVE",
      });
    });

    test("answers no-store and JSON", async ({ request }) => {
      const response = await request.get(livenessPath);
      const headers = response.headers();

      expect(headers["cache-control"]).toBe("no-store");
      expect(headers["content-type"]).toContain("application/json");
    });

    test("is not prerendered: the body is produced per request", async ({
      request,
    }) => {
      // A prerendered handler would be served from the build output with whatever
      // headers the static path chose. `no-store` surviving a production build is
      // the observable consequence of `connection()` doing its job.
      const response = await request.get(livenessPath);
      const headers = response.headers();

      expect(headers["cache-control"]).toBe("no-store");
      expect(headers["etag"]).toBeUndefined();
      expect(headers["last-modified"]).toBeUndefined();
    });

    test("answers byte-identical bodies", async ({ request }) => {
      const first = await (await request.get(livenessPath)).text();
      const second = await (await request.get(livenessPath)).text();

      expect(first).toBe(second);
      expect(first).toBe('{"status":"live","code":"PROCESS_ALIVE"}');
    });

    test("describes neither the machine nor the environment", async ({
      request,
    }) => {
      const body = await (await request.get(livenessPath)).text();

      for (const forbidden of [
        "timestamp",
        "uptime",
        "hostname",
        "pid",
        "memory",
        "version",
        "commit",
        "checks",
        "database",
        "redis",
        "storage",
      ]) {
        expect(body, forbidden).not.toContain(forbidden);
      }
    });

    test("is not redirected into a locale", async ({ request }) => {
      const response = await request.get(livenessPath, { maxRedirects: 0 });

      expect(response.status()).toBe(200);
    });

    test("needs no credentials", async ({ request }) => {
      // No cookie is sent by this fixture, and the probe still answers. A load
      // balancer has no session.
      const response = await request.get(livenessPath);

      expect(response.status()).toBe(200);
    });
  });

  test.describe("readiness", () => {
    test("answers 200 with a total document on the default deployment", async ({
      request,
    }) => {
      const response = await request.get(readinessPath);

      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({
        status: "ready",
        code: "READY",
        checks: {
          database: { status: "healthy" },
          redis: { status: "disabled" },
          storage: { status: "disabled" },
        },
      });
    });

    test("answers no-store and JSON", async ({ request }) => {
      const response = await request.get(readinessPath);
      const headers = response.headers();

      expect(headers["cache-control"]).toBe("no-store");
      expect(headers["content-type"]).toContain("application/json");
    });

    test("reports a disabled optional dependency rather than omitting it", async ({
      request,
    }) => {
      const body = (await (await request.get(readinessPath)).json()) as {
        checks: Record<string, unknown>;
      };

      // Omitting them would make "we do not run Redis here" and "the check was
      // never wired up" look identical during an incident.
      expect(Object.keys(body.checks).sort()).toEqual([
        "database",
        "redis",
        "storage",
      ]);
    });

    test("never reports on the queue, the worker, or the outbox", async ({
      request,
    }) => {
      const body = await (await request.get(readinessPath)).text();

      for (const forbidden of ["queue", "worker", "outbox", "jobs"]) {
        expect(body, forbidden).not.toContain(forbidden);
      }
    });

    test("carries no latency, timestamp, or infrastructure detail", async ({
      request,
    }) => {
      const body = await (await request.get(readinessPath)).text();

      for (const forbidden of [
        "latencyMs",
        "durationMs",
        "timestamp",
        "message",
        "postgresql",
        "5432",
        "127.0.0.1",
        "bucket",
        "endpoint",
      ]) {
        expect(body, forbidden).not.toContain(forbidden);
      }
    });

    test("is answered per request rather than from a build artefact", async ({
      request,
    }) => {
      // The checks genuinely run: a prerendered answer would have been produced by
      // `next build`, where this database was not necessarily reachable.
      const response = await request.get(readinessPath);
      const headers = response.headers();

      expect(response.status()).toBe(200);
      expect(headers["cache-control"]).toBe("no-store");
      expect(headers["etag"]).toBeUndefined();
    });

    test("is not redirected into a locale", async ({ request }) => {
      const response = await request.get(readinessPath, { maxRedirects: 0 });

      expect(response.status()).toBe(200);
    });

    test("needs no credentials", async ({ request }) => {
      const response = await request.get(readinessPath);

      expect(response.status()).toBe(200);
    });
  });

  test.describe("the surface", () => {
    test("answers no probe under the versioned API", async ({ request }) => {
      for (const path of ["/api/v1/health/live", "/api/v1/health/ready"]) {
        const response = await request.get(path, { maxRedirects: 0 });

        expect(response.status(), path).toBe(404);
      }
    });

    test("answers no probe under a locale prefix", async ({ request }) => {
      for (const path of ["/ar/api/health/live", "/en/api/health/ready"]) {
        const response = await request.get(path, { maxRedirects: 0 });

        expect(response.status(), path).toBe(404);
      }
    });

    test("refuses a method neither probe implements", async ({ request }) => {
      // Only `GET` is exported, so Next.js answers 405 for anything else.
      const response = await request.post(livenessPath, { maxRedirects: 0 });

      expect(response.status()).toBe(405);
    });
  });
});

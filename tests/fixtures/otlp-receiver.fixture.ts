import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An ephemeral OTLP/HTTP receiver, for the telemetry integration suite.
 *
 * It exists so the suite can exercise the *real* exporters — the ones a deployment
 * runs — rather than an in-memory one, and still assert on exactly what left the
 * process. An in-memory exporter proves that spans were produced; only a receiver
 * proves that they were serialized, batched, addressed, authenticated, and sent.
 *
 * It is deliberately not an OpenTelemetry Collector. A collector would be a
 * container to provision, a port to wait for, and a process that can be left
 * running after a failed test; this is fifty lines of `node:http` that binds to an
 * ephemeral loopback port and is closed in `finally`. It also lets a test inspect
 * the request headers, which is how "the OTLP credential is sent as a header and
 * never inside the payload" becomes an assertion rather than a claim.
 *
 * `@opentelemetry/exporter-*-otlp-http` sends JSON, so the bodies are parsed as
 * JSON. A batch arrives as one POST per signal.
 */
export type OtlpRequest = Readonly<{
  path: string;
  headers: Readonly<Record<string, string>>;
  /** The parsed OTLP JSON document, or `null` when the body was not JSON. */
  body: Record<string, unknown> | null;
  /** The raw body, for assertions about what must not appear anywhere in it. */
  raw: string;
}>;

export type OtlpReceiver = Readonly<{
  /** The base endpoint to configure `TELEMETRY_OTLP_ENDPOINT` with. */
  endpoint: string;
  traceRequests: () => readonly OtlpRequest[];
  metricRequests: () => readonly OtlpRequest[];
  allRequests: () => readonly OtlpRequest[];
  /** Resolves once at least `count` requests have arrived for `path`, or times out. */
  waitFor: (
    path: string,
    count: number,
    timeoutMs?: number,
  ) => Promise<boolean>;
  reset: () => void;
  close: () => Promise<void>;
}>;

export const OTLP_TRACES_PATH = "/v1/traces";
export const OTLP_METRICS_PATH = "/v1/metrics";

/** How long a `waitFor` will wait before answering `false`. */
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

/**
 * How often `waitFor` re-checks.
 *
 * A poll rather than an event listener, because a test wants to wait for "two
 * batches" without knowing whether the second one has already arrived. It is short
 * enough not to dominate the wait and is not a sleep standing in for a condition:
 * the loop ends on the condition, and the timeout is the failure path.
 */
const WAIT_POLL_INTERVAL_MS = 25;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function toHeaderRecord(
  headers: IncomingMessage["headers"],
): Record<string, string> {
  const record: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      record[name.toLowerCase()] = value;
    }
  }

  return record;
}

/**
 * A receiver that accepts everything, or one that refuses everything.
 *
 * `status` is a parameter so a test can prove that an exporter which cannot deliver
 * changes nothing about the application: the spans are produced, the export fails,
 * the flush resolves, and the operation's result is the same.
 */
export type StartOtlpReceiverOptions = Readonly<{
  status?: number;
  /** Delays each response, for a test that bounds the export timeout. */
  delayMs?: number;
}>;

export async function startOtlpReceiver(
  options: StartOtlpReceiverOptions = {},
): Promise<OtlpReceiver> {
  const { status = 200, delayMs = 0 } = options;
  const requests: OtlpRequest[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const server: Server = createServer((request, response) => {
    void (async () => {
      const raw = await readBody(request);
      let body: Record<string, unknown> | null = null;

      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = null;
      }

      requests.push({
        path: request.url ?? "",
        headers: toHeaderRecord(request.headers),
        body,
        raw,
      });

      const respond = () => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end("{}");
      };

      if (delayMs === 0) {
        respond();

        return;
      }

      // Tracked so `close` can clear it: a pending timer here is exactly the kind
      // of open handle that makes a suite hang after its last assertion.
      const timer = setTimeout(() => {
        timers.delete(timer);
        respond();
      }, delayMs);

      timers.add(timer);
    })();
  });

  await new Promise<void>((resolve) => {
    // Port 0 is an ephemeral port on the loopback interface, so two suites — or two
    // CI runs on one machine — cannot collide.
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}`;

  const requestsFor = (path: string) =>
    requests.filter((entry) => entry.path === path);

  return {
    endpoint,
    traceRequests: () => requestsFor(OTLP_TRACES_PATH),
    metricRequests: () => requestsFor(OTLP_METRICS_PATH),
    allRequests: () => [...requests],
    waitFor: async (
      path: string,
      count: number,
      timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    ) => {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() < deadline) {
        if (requestsFor(path).length >= count) {
          return true;
        }

        await new Promise<void>((resolve) => {
          setTimeout(resolve, WAIT_POLL_INTERVAL_MS);
        });
      }

      return requestsFor(path).length >= count;
    },
    reset: () => {
      requests.length = 0;
    },
    close: async () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }

      timers.clear();

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** Every resource attribute in an OTLP document, flattened to a plain record. */
export function resourceAttributesOf(
  body: Record<string, unknown> | null,
  collection: "resourceSpans" | "resourceMetrics",
): Record<string, string> {
  const resources = (body?.[collection] ?? []) as readonly {
    resource?: {
      attributes?: readonly {
        key?: string;
        value?: { stringValue?: string; intValue?: string };
      }[];
    };
  }[];
  const attributes: Record<string, string> = {};

  for (const entry of resources) {
    for (const attribute of entry.resource?.attributes ?? []) {
      if (attribute.key === undefined) {
        continue;
      }

      attributes[attribute.key] =
        attribute.value?.stringValue ?? attribute.value?.intValue ?? "";
    }
  }

  return attributes;
}

/** Every span in an OTLP trace document, flattened. */
export function spansOf(
  body: Record<string, unknown> | null,
): readonly Record<string, unknown>[] {
  const resourceSpans = (body?.resourceSpans ?? []) as readonly {
    scopeSpans?: readonly { spans?: readonly Record<string, unknown>[] }[];
  }[];

  return resourceSpans.flatMap((entry) =>
    (entry.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
  );
}

/** Every metric name in an OTLP metrics document. */
export function metricNamesOf(
  body: Record<string, unknown> | null,
): readonly string[] {
  const resourceMetrics = (body?.resourceMetrics ?? []) as readonly {
    scopeMetrics?: readonly { metrics?: readonly { name?: string }[] }[];
  }[];

  return resourceMetrics.flatMap((entry) =>
    (entry.scopeMetrics ?? []).flatMap((scope) =>
      (scope.metrics ?? []).flatMap((metric) =>
        metric.name === undefined ? [] : [metric.name],
      ),
    ),
  );
}

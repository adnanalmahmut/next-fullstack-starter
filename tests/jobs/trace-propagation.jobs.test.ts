import { randomUUID } from "node:crypto";

import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  context as otelContext,
  metrics as otelMetrics,
  propagation,
  trace,
} from "@opentelemetry/api";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import { database } from "@/platform/database/index.server";
import {
  createJobRegistry,
  createOutboxDispatcher,
  defineJob,
  JOB_BACKOFF_TYPE,
  writeOutboxMessage,
} from "@/platform/jobs/index.server";
import {
  resetTelemetryInstruments,
  withActiveSpan,
} from "@/platform/observability/index.server";

import {
  cleanupJobsRun,
  configureJobsForTest,
  waitFor,
} from "../fixtures/jobs.fixture";

/**
 * One request, one outbox row, one job — and one trace across all three.
 *
 * This is the property the trace-context columns exist for, and it cannot be
 * asserted anywhere smaller: the request commits a row in PostgreSQL, another
 * process claims it, publishes it to Redis, and a third piece of code executes it
 * minutes later. So this suite uses the real database, the real queue, and a real
 * tracer provider — with an in-memory exporter, because what is being asserted is
 * the *shape* of the trace rather than the wire format, and the wire format has its
 * own suite.
 *
 * The chain under test:
 *
 *     request span  →  outbox row (traceparent, tracestate)
 *                   →  jobs.outbox.publish  →  envelope trace context
 *                   →  jobs.execute
 *
 * Every hop is a real parent/child edge, not a shared correlation id, and every
 * span belongs to the trace the request started.
 */
const CORRELATION = `trace-${randomUUID()}`;

configureJobsForTest({
  OUTBOX_BATCH_SIZE: "10",
  OUTBOX_POLL_INTERVAL_MS: "50",
  OUTBOX_LEASE_MS: "2000",
});

const payloadSchema = z.object({ subject: z.string().min(1) }).strict();

const executed = new Set<string>();

const tracedJob = defineJob({
  name: "fixture.traced",
  version: 1,
  payloadSchema,
  attempts: 2,
  backoff: { type: JOB_BACKOFF_TYPE.FIXED, delayMs: 100 },
  timeoutMs: 5_000,
  timeoutRetryable: true,
  idempotency: { key: (payload) => payload.subject },
  handle: async ({ payload }) => {
    executed.add(payload.subject);
  },
});

const registry = createJobRegistry([tracedJob]);

const exporter = new InMemorySpanExporter();
let provider: TracerProvider | undefined;
let contextManager: AsyncLocalStorageContextManager | undefined;

/**
 * Registers a real tracer provider with an in-memory exporter.
 *
 * A `SimpleSpanProcessor` rather than a batching one, so a span is exportable the
 * moment it ends and no test has to wait for a batch interval it does not care
 * about. The propagator and the context manager are both registered, because
 * without them `inject` has nothing to read and `extract` has nowhere to put what
 * it read — which is exactly the failure this suite would otherwise not notice.
 */
beforeAll(() => {
  provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  contextManager = new AsyncLocalStorageContextManager().enable();

  otelContext.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  resetTelemetryInstruments();
});

/**
 * Starts each test from a drained outbox and an empty exporter.
 *
 * Draining first is what makes the assertions order-independent: a claim collects
 * *every* due row, so a row another test left behind would produce a second publish
 * span and the first one found would belong to the wrong trace.
 */
beforeEach(async () => {
  await createOutboxDispatcher({ registry }).runOnce();

  exporter.reset();
  executed.clear();
});

afterEach(() => {
  exporter.reset();
  executed.clear();
});

afterAll(async () => {
  // Every global is released and every provider is shut down, so this file leaves
  // no tracer, no context manager, and no processor behind for the next one.
  trace.disable();
  otelMetrics.disable();
  propagation.disable();
  otelContext.disable();
  contextManager?.disable();
  resetTelemetryInstruments();

  await provider?.shutdown();
  await cleanupJobsRun(CORRELATION);
});

type SpanShape = Readonly<{
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
}>;

function finishedSpans(): readonly SpanShape[] {
  return exporter.getFinishedSpans().map((span) => ({
    name: span.name,
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId,
  }));
}

function spanNamed(name: string): SpanShape {
  const found = finishedSpans().find((span) => span.name === name);

  expect(found, `expected a span named ${name}`).toBeDefined();

  return found as SpanShape;
}

/**
 * Writes an outbox row inside a request-shaped span, then publishes it.
 *
 * The write and the publish are deliberately separated: the row is committed
 * inside the request's span, and the dispatcher runs *outside* it, which is what
 * makes the parent restoration real rather than an artefact of the two happening
 * in the same context.
 */
async function recordWorkInsideRequestSpan(subject: string): Promise<{
  outboxId: string;
  requestSpanId: string;
  traceId: string;
}> {
  let outboxId = "";
  let requestSpanId = "";
  let traceId = "";

  await withActiveSpan(
    "route.fixture.record",
    { "app.operation.name": "fixture.record" },
    async (span) => {
      span.setOutcome("succeeded");

      const active = trace.getActiveSpan()?.spanContext();

      requestSpanId = active?.spanId ?? "";
      traceId = active?.traceId ?? "";

      const written = await database.$transaction((tx) =>
        writeOutboxMessage(tx, {
          job: tracedJob,
          payload: { subject },
          correlationId: CORRELATION,
        }),
      );

      outboxId = written.outboxId;
    },
  );

  return { outboxId, requestSpanId, traceId };
}

describe("the outbox row", () => {
  it("captures the request's trace context at commit time", async () => {
    const { outboxId, traceId, requestSpanId } =
      await recordWorkInsideRequestSpan(`capture-${randomUUID()}`);

    const row = await database.outboxMessage.findUniqueOrThrow({
      where: { id: outboxId },
      select: { traceparent: true, tracestate: true },
    });

    // The stored value is the W3C header the propagator produced, and it names the
    // request's own span — which is what makes the worker's span a descendant of
    // the request rather than merely tagged with the same id.
    expect(row.traceparent).toBe(`00-${traceId}-${requestSpanId}-01`);
    expect(row.tracestate).toBeNull();
  });
});

describe("request, publish, and execute", () => {
  it("share one trace id and a real parent chain", async () => {
    const subject = `chain-${randomUUID()}`;
    const { outboxId, traceId, requestSpanId } =
      await recordWorkInsideRequestSpan(subject);

    // The dispatcher runs outside the request's span, so the only way it can join
    // the trace is by restoring the context the row stored.
    const summary = await createOutboxDispatcher({ registry }).runOnce();

    expect(summary.published).toBeGreaterThanOrEqual(1);

    const publish = spanNamed("jobs.outbox.publish");

    expect(publish.traceId).toBe(traceId);
    expect(publish.parentSpanId).toBe(requestSpanId);

    // The envelope carries the publish span's context, not the request's, so the
    // execute span becomes a child of the publish rather than a second child of the
    // request.
    const envelope = await waitFor("the queued envelope", async () => {
      const queue = await import("@/platform/jobs/queue/job-queue.server").then(
        (module) => module.requireJobQueue(),
      );
      const job = await queue.getJob(outboxId);

      return job?.data ?? null;
    });

    expect(envelope).toEqual(
      expect.objectContaining({
        traceContext: { traceparent: `00-${traceId}-${publish.spanId}-01` },
      }),
    );
  });

  it("makes the execute span a child of the publish span", async () => {
    const subject = `execute-${randomUUID()}`;
    const { traceId } = await recordWorkInsideRequestSpan(subject);

    await createOutboxDispatcher({ registry }).runOnce();

    const publish = spanNamed("jobs.outbox.publish");

    // The processor is invoked directly rather than through a worker, because what
    // is under test is the parentage the envelope carries — not BullMQ's delivery,
    // which the lifecycle suite covers.
    const { createJobProcessor } =
      await import("@/platform/jobs/execution/job-processor.server");
    const queueModule = await import("@/platform/jobs/queue/job-queue.server");
    const queue = await queueModule.requireJobQueue();
    const queued = await waitFor("the queued job", async () => {
      const jobs = await queue.getJobs(["waiting", "delayed", "prioritized"]);

      return jobs.find((entry) => entry.name === "fixture.traced.v1") ?? null;
    });

    await createJobProcessor(registry)(queued);

    expect(executed.has(subject)).toBe(true);

    const execute = spanNamed("jobs.execute");

    expect(execute.traceId).toBe(traceId);
    expect(execute.parentSpanId).toBe(publish.spanId);
  });
});

describe("malformed stored trace context", () => {
  it("is dropped, and the row is still published", async () => {
    const subject = `dropped-${randomUUID()}`;
    const { outboxId } = await recordWorkInsideRequestSpan(subject);

    // A row written by an older release, or mangled in transit. Refusing to publish
    // it would make observability a correctness dependency.
    await database.outboxMessage.update({
      where: { id: outboxId },
      data: { traceparent: "not-a-traceparent", tracestate: null },
    });

    exporter.reset();

    const summary = await createOutboxDispatcher({ registry }).runOnce();

    expect(summary.published).toBeGreaterThanOrEqual(1);

    const publish = spanNamed("jobs.outbox.publish");

    // A root span rather than a refusal: the work is still recorded, simply
    // without a parent.
    expect(publish.parentSpanId).toBeUndefined();
  });
});

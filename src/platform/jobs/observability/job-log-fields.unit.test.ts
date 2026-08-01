import { describe, expect, it } from "vitest";

import {
  JOB_LOG_FIELD_NAMES,
  JOB_OUTCOME,
  toJobLogFields,
  type JobLogInput,
} from "./job-log-fields";
import { JOBS_LOG_EVENTS } from "./log-event";

describe("the field allowlist", () => {
  it("keeps every allowed field", () => {
    const fields = toJobLogFields({
      jobName: "identity.user-deleted",
      jobVersion: 1,
      jobId: "j-1",
      outboxId: "o-1",
      queueName: "jobs",
      attempt: 2,
      maxAttempts: 3,
      correlationId: "c-1",
      causationId: "c-0",
      durationMs: 12,
      outcome: JOB_OUTCOME.SUCCEEDED,
      errorCode: "handler-failed",
      delayMs: 1_000,
      batchSize: 5,
    });

    expect(Object.keys(fields).sort()).toEqual([...JOB_LOG_FIELD_NAMES].sort());
  });

  it("drops anything outside it", () => {
    const fields = toJobLogFields({
      jobName: "identity.user-deleted",
      payload: { userId: "u-1" },
      result: { deleted: 1 },
      email: "person@example.com",
      ip: "203.0.113.7",
      token: "secret",
      headers: { authorization: "Bearer x" },
      stack: "at handler (...)",
      message: "connection to redis://127.0.0.1:6379 refused",
    } as JobLogInput);

    expect(fields).toEqual({ jobName: "identity.user-deleted" });
  });

  it("omits an absent field rather than serializing null", () => {
    // A line that says `durationMs: null` claims to know something it does not.
    const fields = toJobLogFields({ jobName: "a.b", durationMs: undefined });

    expect("durationMs" in fields).toBe(false);
  });

  it("returns an empty object for an empty input", () => {
    expect(toJobLogFields({})).toEqual({});
  });
});

describe("the event names", () => {
  it("are unique", () => {
    expect(new Set(JOBS_LOG_EVENTS).size).toBe(JOBS_LOG_EVENTS.length);
  });

  it("are language-neutral identifiers rather than sentences", () => {
    for (const event of JOBS_LOG_EVENTS) {
      expect(event, event).toMatch(/^[a-z][a-z_]*(?:\.[a-z][a-z_]*)+$/);
    }
  });

  it("cover the whole path a message takes", () => {
    for (const event of [
      "outbox.written",
      "outbox.claimed",
      "outbox.published",
      "outbox.publish_failed",
      "outbox.dead_lettered",
      "job.queued",
      "job.started",
      "job.succeeded",
      "job.failed",
      "job.retrying",
      "job.timed_out",
      "job.dead_lettered",
      "job.stalled",
      "worker.started",
      "worker.ready",
      "worker.stopping",
      "worker.stopped",
    ]) {
      expect(JOBS_LOG_EVENTS, event).toContain(event);
    }
  });
});

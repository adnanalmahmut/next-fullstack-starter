import { describe, expect, it } from "vitest";

import { readJobsEnvironment } from "./read-jobs";
import { DEFAULT_OUTBOX_BATCH_SIZE } from "./schema";

describe("reading the jobs environment", () => {
  it("treats an empty source as a valid, disabled configuration", () => {
    const values = readJobsEnvironment({});

    expect(values.JOBS_ENABLED).toBe(false);
    expect(values.JOBS_REDIS_URL).toBeUndefined();
  });

  it("ignores every unrelated variable in the source", () => {
    // `process.env` is passed in directly, so the reader has to pick out the
    // names it owns rather than handing the whole environment to a strict
    // schema.
    const values = readJobsEnvironment({
      DATABASE_URL: "postgresql://127.0.0.1:5432/db",
      REDIS_URL: "redis://127.0.0.1:6379",
      PATH: "/usr/bin",
      JOBS_ENABLED: "true",
    });

    expect(values.JOBS_ENABLED).toBe(true);
  });

  it("omits an absent variable rather than passing undefined", () => {
    // Passing `undefined` explicitly would override a schema default with
    // nothing and turn a missing variable into a parse failure.
    const values = readJobsEnvironment({ OUTBOX_BATCH_SIZE: undefined });

    expect(values.OUTBOX_BATCH_SIZE).toBe(DEFAULT_OUTBOX_BATCH_SIZE);
  });

  it("reports the scope in a failure so the operator knows where to look", () => {
    expect(() => readJobsEnvironment({ JOBS_ENABLED: "yes" })).toThrow(
      /Invalid jobs environment variables/,
    );
  });

  it("names the variable and never the value it refused", () => {
    // A rejected `JOBS_REDIS_URL` is a credential. The message may say which
    // variable is wrong; it may not quote it.
    const secret = "rediss://user:hunter2@queue.example:6380";

    try {
      readJobsEnvironment({ JOBS_REDIS_URL: secret.replace("rediss", "http") });
      expect.unreachable("An invalid URL must be refused.");
    } catch (error) {
      expect(String(error)).toContain("JOBS_REDIS_URL");
      expect(String(error)).not.toContain("hunter2");
    }
  });
});

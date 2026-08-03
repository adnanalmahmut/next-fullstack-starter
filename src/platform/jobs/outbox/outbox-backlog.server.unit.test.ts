import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn();

vi.mock("@/platform/database/index.server", () => ({
  database: {
    get $queryRaw() {
      return queryRaw;
    },
  },
}));

const {
  readOutboxBacklog,
  startOutboxBacklogMetrics,
  MAX_OUTBOX_BACKLOG_SAMPLE,
} = await import("./outbox-backlog.server");
const { resetJobsConfiguration } = await import("../config/jobs-config");

beforeEach(() => {
  queryRaw.mockReset();
  resetJobsConfiguration();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetJobsConfiguration();
});

describe("reading the backlog", () => {
  it("converts the four counts, which PostgreSQL returns as bigints", async () => {
    queryRaw.mockResolvedValue([
      {
        pending: BigInt(7),
        due: BigInt(5),
        leased: BigInt(2),
        deadLettered: BigInt(1),
      },
    ]);

    await expect(readOutboxBacklog()).resolves.toEqual({
      pending: 7,
      due: 5,
      leased: 2,
      deadLettered: 1,
    });
  });

  it("answers four zeros when the aggregate returns no row", async () => {
    queryRaw.mockResolvedValue([]);

    await expect(readOutboxBacklog()).resolves.toEqual({
      pending: 0,
      due: 0,
      leased: 0,
      deadLettered: 0,
    });
  });

  it("bounds the statement to a sample of interesting rows", async () => {
    queryRaw.mockResolvedValue([
      {
        pending: BigInt(0),
        due: BigInt(0),
        leased: BigInt(0),
        deadLettered: BigInt(0),
      },
    ]);

    await readOutboxBacklog();

    const [template, ...values] = queryRaw.mock.calls[0] as [
      readonly string[],
      ...unknown[],
    ];
    const statement = template.join("?");

    // Published history is never scanned, and the sample has a ceiling, so the
    // metric cannot become more expensive than the work it measures.
    expect(statement).toContain('"publishedAt" IS NULL OR');
    expect(statement).toContain("LIMIT");
    expect(values).toContain(MAX_OUTBOX_BACKLOG_SAMPLE);
  });

  it("evaluates the clock in the database, so the counts agree", async () => {
    queryRaw.mockResolvedValue([
      {
        pending: BigInt(0),
        due: BigInt(0),
        leased: BigInt(0),
        deadLettered: BigInt(0),
      },
    ]);

    await readOutboxBacklog();

    const [template] = queryRaw.mock.calls[0] as [readonly string[]];

    expect(template.join("?")).toContain("now()");
  });

  it("names no queue, no Redis address, and no payload", async () => {
    queryRaw.mockResolvedValue([
      {
        pending: BigInt(0),
        due: BigInt(0),
        leased: BigInt(0),
        deadLettered: BigInt(0),
      },
    ]);

    await readOutboxBacklog();

    const [template] = queryRaw.mock.calls[0] as [readonly string[]];
    const statement = template.join("?");

    for (const forbidden of ["redis", "payload", "bull", "queue"]) {
      expect(statement.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});

describe("arming the gauges", () => {
  it("registers nothing when background jobs are disabled", async () => {
    const registration = startOutboxBacklogMetrics();

    registration.unregister();

    // A deployment that never enabled the outbox never queries it.
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("registers an observer when jobs are enabled", () => {
    vi.stubEnv("JOBS_ENABLED", "true");
    resetJobsConfiguration();

    const registration = startOutboxBacklogMetrics();

    expect(typeof registration.unregister).toBe("function");
    expect(() => registration.unregister()).not.toThrow();
  });
});

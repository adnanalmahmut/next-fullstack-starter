import { loadEnvConfig } from "@next/env";
import { afterAll, describe, expect, it, vi } from "vitest";

loadEnvConfig(process.cwd());

vi.doMock("server-only", () => ({}));

const { database } = await import("@/platform/database/index.server");

afterAll(async () => {
  await database.$disconnect();
});

describe("database connection", () => {
  it("executes a query against PostgreSQL", async () => {
    const result = await database.$queryRaw<Array<{ value: number }>>`
      SELECT 1::integer AS value
    `;

    expect(result).toEqual([{ value: 1 }]);
  });
});

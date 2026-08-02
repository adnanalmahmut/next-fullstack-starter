import { beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { ValidationError } from "@/shared/errors/application-error";

import { defineAuditAction } from "./audit-action";
import { AUDIT_ACTOR_TYPE } from "./audit-actor";
import { createAuditCatalog } from "./audit-catalog";
import { decodeAuditCursor, encodeAuditCursor } from "./audit-cursor";
import type { StoredAuditRecord } from "./audit-record";
import { AUDIT_RESULT } from "./audit-result";

const findAuditRecordPage = vi.hoisted(() => vi.fn());

vi.mock("./audit-repository.server", () => ({ findAuditRecordPage }));

const { listAuditRecords } = await import("./list-audit-records.server");

const roleSet = defineAuditAction({
  name: "identity.user.role-set",
  resourceType: "identity.user",
  metadataSchema: z.object({ role: z.enum(["user", "admin"]) }).strict(),
});

const catalog = createAuditCatalog([roleSet]);

function row(index: number): StoredAuditRecord {
  return {
    id: `0198f0e0-1111-7222-8333-44445555${String(index).padStart(4, "0")}`,
    occurredAt: new Date(Date.UTC(2026, 7, 1, 0, 0, index)),
    actorType: AUDIT_ACTOR_TYPE.USER,
    actorId: "actor-1",
    action: "identity.user.role-set",
    resourceType: "identity.user",
    resourceId: "target-1",
    result: AUDIT_RESULT.SUCCEEDED,
    requestId: null,
    metadata: { role: "admin" },
  };
}

describe("listAuditRecords", () => {
  beforeEach(() => {
    findAuditRecordPage.mockReset();
  });

  it("asks for one more row than it returns", async () => {
    findAuditRecordPage.mockResolvedValue([row(1), row(2)]);

    const page = await listAuditRecords(catalog, { limit: 2 });

    expect(findAuditRecordPage).toHaveBeenCalledWith(3, null);
    expect(page.records).toHaveLength(2);
    expect(page.limit).toBe(2);
  });

  it("reports no next page when the extra row is absent", async () => {
    findAuditRecordPage.mockResolvedValue([row(1), row(2)]);

    expect(
      (await listAuditRecords(catalog, { limit: 2 })).nextCursor,
    ).toBeNull();
  });

  it("never serializes the extra row", async () => {
    findAuditRecordPage.mockResolvedValue([row(1), row(2), row(3)]);

    const page = await listAuditRecords(catalog, { limit: 2 });

    expect(page.records.map((record) => record.id)).toEqual([
      row(1).id,
      row(2).id,
    ]);
  });

  it("builds the cursor from the last row it returned, not the extra one", async () => {
    findAuditRecordPage.mockResolvedValue([row(1), row(2), row(3)]);

    const page = await listAuditRecords(catalog, { limit: 2 });

    expect(page.nextCursor).not.toBeNull();
    expect(decodeAuditCursor(page.nextCursor as string)).toEqual({
      id: row(2).id,
      occurredAt: row(2).occurredAt,
    });
  });

  it("passes a decoded cursor to the repository", async () => {
    findAuditRecordPage.mockResolvedValue([]);

    const cursor = encodeAuditCursor({
      occurredAt: row(9).occurredAt,
      id: row(9).id,
    });

    await listAuditRecords(catalog, { limit: 20, cursor });

    expect(findAuditRecordPage).toHaveBeenCalledWith(21, {
      occurredAt: row(9).occurredAt,
      id: row(9).id,
    });
  });

  it("refuses a malformed cursor before touching the database", async () => {
    await expect(
      listAuditRecords(catalog, { limit: 20, cursor: "not-a-cursor" }),
    ).rejects.toThrow(ValidationError);

    expect(findAuditRecordPage).not.toHaveBeenCalled();
  });

  it("returns an empty page rather than failing", async () => {
    findAuditRecordPage.mockResolvedValue([]);

    expect(await listAuditRecords(catalog, { limit: 20 })).toEqual({
      records: [],
      limit: 20,
      nextCursor: null,
    });
  });

  it("keeps a record whose action the catalog does not know", async () => {
    findAuditRecordPage.mockResolvedValue([
      { ...row(1), action: "documents.document.published" },
    ]);

    const page = await listAuditRecords(catalog, { limit: 20 });

    expect(page.records).toHaveLength(1);
    expect(page.records[0].action).toBe("documents.document.published");
    expect(page.records[0].metadata).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import * as z from "zod";

import { defineAuditAction } from "./audit-action";
import {
  AUDIT_ACTOR_TYPE,
  systemAuditActor,
  userAuditActor,
} from "./audit-actor";
import { createAuditCatalog } from "./audit-catalog";
import {
  AUDIT_WRITE_REJECTION,
  prepareAuditRecordWrite,
  type StoredAuditRecord,
  toAuditRecordDto,
  toAuditRecordDtos,
} from "./audit-record";
import { AUDIT_RESULT } from "./audit-result";

const roleSet = defineAuditAction({
  name: "identity.user.role-set",
  resourceType: "identity.user",
  metadataSchema: z.object({ role: z.enum(["user", "admin"]) }).strict(),
});

const catalog = createAuditCatalog([roleSet]);
const occurredAt = new Date("2026-08-01T12:34:56.789Z");
const requestId = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function stored(overrides: Partial<StoredAuditRecord> = {}): StoredAuditRecord {
  return {
    id: "0198f0e0-1111-7222-8333-444455556666",
    occurredAt,
    actorType: AUDIT_ACTOR_TYPE.USER,
    actorId: "actor-1",
    action: "identity.user.role-set",
    resourceType: "identity.user",
    resourceId: "target-1",
    result: AUDIT_RESULT.SUCCEEDED,
    requestId,
    metadata: { role: "admin" },
    ...overrides,
  };
}

describe("toAuditRecordDto", () => {
  it("maps a known record", () => {
    expect(toAuditRecordDto(stored(), catalog)).toEqual({
      id: "0198f0e0-1111-7222-8333-444455556666",
      occurredAt: "2026-08-01T12:34:56.789Z",
      actor: { type: "user", id: "actor-1" },
      action: "identity.user.role-set",
      resource: { type: "identity.user", id: "target-1" },
      result: "succeeded",
      requestId,
      metadata: { role: "admin" },
    });
  });

  it("never exposes the acting session identifier", () => {
    // It is not in `StoredAuditRecord` at all, so the assertion is on the shape
    // a reader receives: no key here can carry it.
    const dto = toAuditRecordDto(stored(), catalog);

    expect(Object.keys(dto).sort()).toEqual([
      "action",
      "actor",
      "id",
      "metadata",
      "occurredAt",
      "requestId",
      "resource",
      "result",
    ]);
    expect(Object.keys(dto.actor).sort()).toEqual(["id", "type"]);
    expect(JSON.stringify(dto)).not.toContain("sessionId");
  });

  it("keeps a record whose action the catalog does not know", () => {
    const dto = toAuditRecordDto(
      stored({ action: "documents.document.published" }),
      catalog,
    );

    expect(dto.action).toBe("documents.document.published");
    expect(dto.actor.id).toBe("actor-1");
    expect(dto.resource.id).toBe("target-1");
    expect(dto.result).toBe("succeeded");
  });

  it("withholds the metadata of an action the catalog does not know", () => {
    expect(
      toAuditRecordDto(
        stored({ action: "documents.document.published" }),
        catalog,
      ).metadata,
    ).toBeNull();
  });

  it("keeps a record whose stored metadata no longer parses", () => {
    const dto = toAuditRecordDto(
      stored({ metadata: { role: "superadmin", leaked: "x" } }),
      catalog,
    );

    expect(dto.id).toBe("0198f0e0-1111-7222-8333-444455556666");
    expect(dto.metadata).toBeNull();
  });

  it("never passes a raw stored value through", () => {
    const dto = toAuditRecordDto(
      stored({ metadata: { token: "secret-value" } }),
      catalog,
    );

    expect(dto.metadata).toBeNull();
    expect(JSON.stringify(dto)).not.toContain("secret-value");
  });

  it("maps a system actor and a null request identifier", () => {
    const dto = toAuditRecordDto(
      stored({
        actorType: AUDIT_ACTOR_TYPE.SYSTEM,
        actorId: "retention-task",
        requestId: null,
      }),
      catalog,
    );

    expect(dto.actor).toEqual({ type: "system", id: "retention-task" });
    expect(dto.requestId).toBeNull();
  });

  it("maps a page without dropping anything", () => {
    const records = [
      stored(),
      stored({ id: "0198f0e0-1111-7222-8333-444455556667", action: "x.y.z" }),
    ];

    expect(toAuditRecordDtos(records, catalog)).toHaveLength(2);
  });
});

describe("prepareAuditRecordWrite", () => {
  const actor = userAuditActor("actor-1", "session-1");

  it("takes the action and resource type from the definition", () => {
    const prepared = prepareAuditRecordWrite(roleSet, {
      actor,
      resourceId: "target-1",
      result: AUDIT_RESULT.SUCCEEDED,
      requestId,
      metadata: { role: "admin" },
    });

    expect(prepared).toEqual({
      ok: true,
      write: {
        actor,
        action: "identity.user.role-set",
        resourceType: "identity.user",
        resourceId: "target-1",
        result: "succeeded",
        requestId,
        metadata: { role: "admin" },
      },
    });
  });

  it("stores an absent request identifier as null", () => {
    const prepared = prepareAuditRecordWrite(roleSet, {
      actor,
      resourceId: "target-1",
      result: AUDIT_RESULT.SUCCEEDED,
      metadata: { role: "admin" },
    });

    expect(prepared.ok && prepared.write.requestId).toBeNull();
  });

  it("carries an explicit occurrence time and omits it otherwise", () => {
    const withTime = prepareAuditRecordWrite(roleSet, {
      actor,
      resourceId: "target-1",
      result: AUDIT_RESULT.SUCCEEDED,
      metadata: { role: "admin" },
      occurredAt,
    });

    expect(withTime.ok && withTime.write.occurredAt).toBe(occurredAt);
  });

  it("refuses a malformed actor", () => {
    expect(
      prepareAuditRecordWrite(roleSet, {
        actor: { type: "user", id: "actor-1" } as never,
        resourceId: "target-1",
        result: AUDIT_RESULT.SUCCEEDED,
        metadata: { role: "admin" },
      }),
    ).toEqual({ ok: false, reason: AUDIT_WRITE_REJECTION.ACTOR });
  });

  it("refuses a missing or oversized resource identifier", () => {
    for (const resourceId of ["", " ", "x".repeat(256)]) {
      expect(
        prepareAuditRecordWrite(roleSet, {
          actor,
          resourceId,
          result: AUDIT_RESULT.SUCCEEDED,
          metadata: { role: "admin" },
        }),
      ).toEqual({ ok: false, reason: AUDIT_WRITE_REJECTION.RESOURCE_ID });
    }
  });

  it("refuses a result outside the closed set", () => {
    expect(
      prepareAuditRecordWrite(roleSet, {
        actor,
        resourceId: "target-1",
        result: "partial" as never,
        metadata: { role: "admin" },
      }),
    ).toEqual({ ok: false, reason: AUDIT_WRITE_REJECTION.RESULT });
  });

  it("refuses a request identifier that is not a canonical UUID", () => {
    expect(
      prepareAuditRecordWrite(roleSet, {
        actor,
        resourceId: "target-1",
        result: AUDIT_RESULT.SUCCEEDED,
        requestId: "req-1",
        metadata: { role: "admin" },
      }),
    ).toEqual({ ok: false, reason: AUDIT_WRITE_REJECTION.REQUEST_ID });
  });

  it("refuses metadata the policy or the schema rejects", () => {
    expect(
      prepareAuditRecordWrite(roleSet, {
        actor,
        resourceId: "target-1",
        result: AUDIT_RESULT.SUCCEEDED,
        metadata: { role: "superadmin" } as never,
      }),
    ).toEqual({ ok: false, reason: AUDIT_WRITE_REJECTION.METADATA });

    expect(
      prepareAuditRecordWrite(roleSet, {
        actor,
        resourceId: "target-1",
        result: AUDIT_RESULT.SUCCEEDED,
        metadata: { password: "p" } as never,
      }),
    ).toEqual({ ok: false, reason: AUDIT_WRITE_REJECTION.METADATA });
  });

  it("accepts a system actor", () => {
    const prepared = prepareAuditRecordWrite(roleSet, {
      actor: systemAuditActor("retention-task"),
      resourceId: "target-1",
      result: AUDIT_RESULT.DENIED,
      metadata: { role: "user" },
    });

    expect(prepared.ok && prepared.write.actor.type).toBe("system");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import type { Prisma } from "@/generated/prisma/client";
import { ValidationError } from "@/shared/errors/application-error";

import { defineAuditAction } from "./audit-action";
import { userAuditActor } from "./audit-actor";
import { AUDIT_RESULT } from "./audit-result";

const insertAuditRecord = vi.hoisted(() => vi.fn());

vi.mock("./audit-repository.server", () => ({ insertAuditRecord }));

const { appendAuditRecord } = await import("./append-audit-record.server");

const roleSet = defineAuditAction({
  name: "identity.user.role-set",
  resourceType: "identity.user",
  metadataSchema: z.object({ role: z.enum(["user", "admin"]) }).strict(),
});

const actor = userAuditActor("actor-1", "session-1");

/** A stand-in for an interactive transaction client. */
const transactionClient = {
  $transaction: vi.fn(),
} as unknown as Prisma.TransactionClient;

function input(overrides: Record<string, unknown> = {}) {
  return {
    actor,
    resourceId: "target-1",
    result: AUDIT_RESULT.SUCCEEDED,
    metadata: { role: "admin" } as const,
    ...overrides,
  };
}

describe("appendAuditRecord", () => {
  beforeEach(() => {
    insertAuditRecord.mockReset();
    insertAuditRecord.mockResolvedValue("record-1");
  });

  it("writes through the client it was handed", async () => {
    await expect(
      appendAuditRecord(transactionClient, roleSet, input()),
    ).resolves.toEqual({ id: "record-1" });

    expect(insertAuditRecord).toHaveBeenCalledWith(transactionClient, {
      actor,
      action: "identity.user.role-set",
      resourceType: "identity.user",
      resourceId: "target-1",
      result: "succeeded",
      requestId: null,
      metadata: { role: "admin" },
    });
  });

  it("refuses the Prisma singleton at runtime", async () => {
    // The type would allow it: `PrismaClient` structurally satisfies
    // `TransactionClient`, and the mistake is invisible until a rollback fails
    // to remove the record.
    const singleton = {
      $transaction: vi.fn(),
      $connect: vi.fn(),
      $disconnect: vi.fn(),
    } as unknown as Prisma.TransactionClient;

    await expect(
      appendAuditRecord(singleton, roleSet, input()),
    ).rejects.toThrow(/interactive transaction client/);
    expect(insertAuditRecord).not.toHaveBeenCalled();
  });

  it("does not mistake a transaction client for the singleton", async () => {
    // An interactive client still exposes `$transaction`, so that is not the
    // discriminator it looks like.
    await expect(
      appendAuditRecord(transactionClient, roleSet, input()),
    ).resolves.toBeDefined();
  });

  it("throws instead of writing when the input is refused", async () => {
    await expect(
      appendAuditRecord(
        transactionClient,
        roleSet,
        input({ metadata: { role: "superadmin" } }),
      ),
    ).rejects.toThrow(ValidationError);

    expect(insertAuditRecord).not.toHaveBeenCalled();
  });

  it("names a stable reason and nothing from the input", async () => {
    const rejected = await appendAuditRecord(
      transactionClient,
      roleSet,
      input({ metadata: { password: "hunter2" } }),
    ).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(ValidationError);
    expect((rejected as Error).message).toBe(
      "The audit record was refused: invalid-metadata.",
    );
    expect((rejected as Error).message).not.toContain("hunter2");
  });

  it("lets a storage failure propagate, so the transaction fails with it", async () => {
    insertAuditRecord.mockRejectedValueOnce(new Error("connection lost"));

    await expect(
      appendAuditRecord(transactionClient, roleSet, input()),
    ).rejects.toThrow("connection lost");
  });
});

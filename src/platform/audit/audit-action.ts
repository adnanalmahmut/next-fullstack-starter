import * as z from "zod";

import {
  asAuditMetadata,
  type AuditMetadata,
  checkAuditMetadata,
} from "./audit-metadata";

/**
 * What an auditable action is, declared once by whoever owns it.
 *
 * The platform deliberately holds no action of its own. `identity.user.role-set`
 * belongs to authentication, `documents.document.published` would belong to a
 * documents module, and each one is declared in the area that performs it. What
 * the platform owns is the *shape*: a stable name, the resource type the action
 * acts on, and a closed schema for the metadata it records.
 *
 * A call site passes a definition object, never a bare action string. That is
 * the difference between a typed contract and a magic string: an unregistered
 * name cannot be written, and the metadata the writer is allowed to attach is
 * decided by the same declaration that named the action.
 */
export const MAX_AUDIT_ACTION_LENGTH = 96;
export const MAX_AUDIT_RESOURCE_TYPE_LENGTH = 64;

/**
 * One dot-separated part of a name.
 *
 * Lowercase ASCII, starting with a letter, hyphen allowed inside. No spaces, no
 * wildcards, no empty parts. The names end up in a database column, in log
 * lines, and in a URL-visible filter one day, so they are constrained to a shape
 * that is safe in all three.
 */
const segmentPattern = /^[a-z][a-z0-9-]*$/;

function hasValidSegments(value: string, count: number): boolean {
  const segments = value.split(".");

  return (
    segments.length === count &&
    segments.every((segment) => segmentPattern.test(segment))
  );
}

/** `<owner>.<resource>.<action>`, for example `identity.user.role-set`. */
export function isValidAuditActionName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_AUDIT_ACTION_LENGTH &&
    hasValidSegments(value, 3)
  );
}

/** `<owner>.<resource>`, for example `identity.user`. */
export function isValidAuditResourceType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_AUDIT_RESOURCE_TYPE_LENGTH &&
    hasValidSegments(value, 2)
  );
}

/**
 * The type-erased half of a definition.
 *
 * A catalog holds definitions whose metadata types all differ, and a reader
 * re-parses stored metadata without knowing which action it belongs to until it
 * has looked. Zod's schema type is invariant in its input, so a heterogeneous
 * list of typed schemas has no useful common supertype. The definition therefore
 * carries a closure that has already captured its own schema: everything the
 * catalog and the DTO mapper need, with nothing left to infer.
 */
export type AuditActionRuntime = Readonly<{
  name: string;
  resourceType: string;
  /**
   * Re-reads a value that came back from storage.
   *
   * `null` when the stored value no longer matches the schema — because the
   * schema changed, or because the row was written by something that should not
   * have written it. The record is still shown; only the metadata is withheld.
   */
  readStoredMetadata: (value: unknown) => AuditMetadata | null;
}>;

/**
 * A definition, with the metadata types its owner declared.
 *
 * `TMetadataInput` is separate from `TMetadata` because a schema with defaults
 * accepts less than it produces, and a writer should not have to spell out a
 * value the schema is about to supply.
 */
export type AuditActionDefinition<
  TMetadata extends object,
  TMetadataInput = TMetadata,
> = AuditActionRuntime &
  Readonly<{
    metadataSchema: z.ZodType<TMetadata, TMetadataInput>;
  }>;

export type AuditActionDefinitionInput<
  TMetadata extends object,
  TMetadataInput,
> = Readonly<{
  name: string;
  resourceType: string;
  /**
   * The closed shape of this action's metadata.
   *
   * An object schema must be `.strict()`. It is not checked here — Zod does not
   * expose the mode in a stable way — so a contract test asserts it across the
   * repository instead, where it can also see the schemas that are declared
   * inline.
   */
  metadataSchema: z.ZodType<TMetadata, TMetadataInput>;
}>;

/**
 * Declares an auditable action.
 *
 * It throws rather than returning a result: a malformed action name is a
 * programming error in a module's own declaration, it is discovered the moment
 * the module is imported, and there is no runtime path that could sensibly
 * recover from it.
 */
export function defineAuditAction<
  TMetadata extends object,
  TMetadataInput = TMetadata,
>(
  input: AuditActionDefinitionInput<TMetadata, TMetadataInput>,
): AuditActionDefinition<TMetadata, TMetadataInput> {
  if (!isValidAuditActionName(input.name)) {
    throw new Error(
      `The audit action name "${input.name}" is not a valid <owner>.<resource>.<action> name.`,
    );
  }

  if (!isValidAuditResourceType(input.resourceType)) {
    throw new Error(
      `The audit resource type "${input.resourceType}" is not a valid <owner>.<resource> name.`,
    );
  }

  const { metadataSchema } = input;

  return {
    name: input.name,
    resourceType: input.resourceType,
    metadataSchema,
    readStoredMetadata(value: unknown): AuditMetadata | null {
      const parsed = metadataSchema.safeParse(value);

      // Parsing is not enough on its own. A schema could produce a value the
      // storage policy would refuse — a transform that returns a `Date`, say —
      // and a reader must never receive something a writer could not have
      // written.
      return parsed.success ? asAuditMetadata(parsed.data) : null;
    },
  };
}

/**
 * Prepares metadata for storage.
 *
 * The order matters. The policy runs on the value the caller handed in, so a
 * forbidden key is reported as a forbidden key rather than as a schema
 * mismatch; the schema then decides whether the value is this action's
 * metadata; and the policy runs once more on what the schema produced, because
 * a default or a transform can change the value that actually travels.
 */
export function parseAuditMetadataForWrite<
  TMetadata extends object,
  TMetadataInput,
>(
  definition: AuditActionDefinition<TMetadata, TMetadataInput>,
  metadata: TMetadataInput,
):
  | Readonly<{ ok: true; metadata: AuditMetadata }>
  | Readonly<{ ok: false; reason: string }> {
  const rejection = checkAuditMetadata(metadata);

  if (rejection !== null) {
    return { ok: false, reason: rejection };
  }

  const parsed = definition.metadataSchema.safeParse(metadata);

  if (!parsed.success) {
    return { ok: false, reason: "schema-mismatch" };
  }

  const stored = asAuditMetadata(parsed.data);

  return stored === null
    ? { ok: false, reason: "not-storable" }
    : { ok: true, metadata: stored };
}

import { createJobRegistry, type JobRegistry } from "./job-registry";

/**
 * The registry the worker entry point runs.
 *
 * It is deliberately empty. This change establishes the mechanism — an outbox, a
 * dispatcher, a worker, retries, timeouts, and idempotent execution — and a
 * starter that shipped a plausible-looking `email.send` or `report.generate`
 * would be shipping a business decision disguised as infrastructure, along with
 * a table, a provider, and a failure mode nobody asked for.
 *
 * A project adds its own definitions here:
 *
 * ```ts
 * import { SEND_INVOICE_JOB } from "@/modules/billing/index.server";
 *
 * export const JOB_REGISTRY = createJobRegistry([SEND_INVOICE_JOB]);
 * ```
 *
 * Until then a worker starts, reports readiness, drains the outbox, and refuses
 * anything it does not recognise — which is the correct behaviour for a queue
 * with no jobs in it, and is exercised by the integration suite with registries
 * of its own.
 */
export const JOB_REGISTRY: JobRegistry = createJobRegistry([]);

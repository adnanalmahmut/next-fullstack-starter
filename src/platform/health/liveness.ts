import { HEALTH_CODE } from "./health-code";
import { LIVENESS_STATUS } from "./health-status";

/**
 * The liveness answer, which is a constant.
 *
 * That is the contract, not a simplification of it. A liveness probe answers one
 * question — is this process running and able to serve — and a process that
 * produced this body has answered it by producing it. There is nothing to
 * compute, nothing to check, and nothing that could make the answer different.
 *
 * What is absent is as deliberate as what is present. No timestamp, because it
 * would make the body change on every request for no operational gain and would
 * defeat any byte comparison a monitor might do. No hostname, no process id, no
 * memory figure, no uptime, no version, no commit: every one of those is
 * infrastructure detail on an endpoint that is, by design, reachable without
 * authentication. And no dependency status, because a liveness probe that
 * reported on a database would eventually be wired to a restart policy, and an
 * orchestrator would start killing healthy processes because something they do
 * not own went away.
 *
 * Frozen because it is a module-level value handed to every response. A caller
 * that mutated it would change what every later probe answers.
 */
export type LivenessReport = Readonly<{
  status: typeof LIVENESS_STATUS.LIVE;
  code: typeof HEALTH_CODE.PROCESS_ALIVE;
}>;

export const LIVENESS_REPORT: LivenessReport = Object.freeze({
  status: LIVENESS_STATUS.LIVE,
  code: HEALTH_CODE.PROCESS_ALIVE,
});

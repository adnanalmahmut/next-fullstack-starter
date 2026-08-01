import { describe, expect, it } from "vitest";

import {
  AVAILABILITY_POLICIES,
  AVAILABILITY_POLICY,
  RATE_LIMIT_FALLBACK,
  RATE_LIMIT_FALLBACKS,
} from "./availability-policy";

describe("the policy vocabulary", () => {
  it("offers exactly two answers, and no default among them", () => {
    // A third member would be a default in disguise. The point of the type is
    // that a call site has to choose.
    expect(AVAILABILITY_POLICIES).toEqual(["required", "best-effort"]);
  });

  it("keeps the rate-limit fallback a separate question", () => {
    // "Required" and "best-effort" would read as the wrong question for a
    // limiter: it is asked to decide, and the two honest decisions are to let
    // everything through or to let nothing through.
    expect(RATE_LIMIT_FALLBACKS).toEqual(["allow", "deny"]);
  });

  it("names the two vocabularies distinctly", () => {
    const shared = RATE_LIMIT_FALLBACKS.filter((fallback) =>
      (AVAILABILITY_POLICIES as readonly string[]).includes(fallback),
    );

    expect(shared).toEqual([]);
    expect(AVAILABILITY_POLICY.REQUIRED).not.toBe(RATE_LIMIT_FALLBACK.DENY);
  });
});

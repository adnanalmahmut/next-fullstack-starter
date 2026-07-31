import { describe, expect, it } from "vitest";

import { isEmailRegistrationEnabled } from "./registration-policy";

describe("isEmailRegistrationEnabled", () => {
  it.each([
    { appEnvironment: "development", expected: true },
    { appEnvironment: "test", expected: true },
    { appEnvironment: "staging", expected: false },
    { appEnvironment: "production", expected: false },
  ] as const)(
    "returns $expected for $appEnvironment",
    ({ appEnvironment, expected }) => {
      expect(isEmailRegistrationEnabled(appEnvironment)).toBe(expected);
    },
  );

  it("disables sign-up in every deployed environment", () => {
    const deployed = ["staging", "production"] as const;

    for (const appEnvironment of deployed) {
      expect(isEmailRegistrationEnabled(appEnvironment)).toBe(false);
    }
  });
});

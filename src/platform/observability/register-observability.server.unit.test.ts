import type { DestinationStream } from "pino";
import { describe, expect, it } from "vitest";

import { createApplicationLogger } from "./create-logger.server";
import { registerObservability } from "./register-observability.server";

describe("observability registration", () => {
  it("emits the startup event only once", () => {
    const output: string[] = [];
    const destination: DestinationStream = {
      write(message) {
        output.push(message);
      },
    };
    const logger = createApplicationLogger({
      environment: "test",
      level: "info",
      destination,
    });

    registerObservability(logger);
    registerObservability(logger);

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? "{}")).toEqual(
      expect.objectContaining({
        msg: "application.started",
      }),
    );
  });
});

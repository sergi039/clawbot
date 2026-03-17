import { beforeAll, describe, expect, it } from "vitest";
import { createDoctorRuntime, mockDoctorConfigSnapshot, note } from "./doctor.e2e-harness.js";
import "./doctor.fast-path-mocks.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;

describe("doctor command gateway SecretRef auth", () => {
  beforeAll(async () => {
    ({ doctorCommand } = await import("./doctor.js"));
  });

  it("skips the unavailable warning when gateway SecretRef token resolves", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: {
          mode: "local",
          auth: {
            token: {
              source: "env",
              provider: "default",
              id: "CUSTOM_GATEWAY_TOKEN",
            },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      },
    });

    const prevToken = process.env.CUSTOM_GATEWAY_TOKEN;
    process.env.CUSTOM_GATEWAY_TOKEN = "secret-ref-token-1234567890";
    note.mockClear();

    try {
      await doctorCommand(createDoctorRuntime(), {
        nonInteractive: true,
        workspaceSuggestions: false,
      });
    } finally {
      if (prevToken === undefined) {
        delete process.env.CUSTOM_GATEWAY_TOKEN;
      } else {
        process.env.CUSTOM_GATEWAY_TOKEN = prevToken;
      }
    }

    const warned = note.mock.calls.some(([message, title]) => {
      return (
        title === "Gateway auth" &&
        String(message).includes(
          "Gateway token is managed via SecretRef and is currently unavailable",
        )
      );
    });
    expect(warned).toBe(false);
  });
});

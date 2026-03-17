import { describe, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "./doctor-prompter.js";

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("createDoctorPrompter", () => {
  it("applies recommended repairs in non-interactive repair mode", async () => {
    const prompter = createDoctorPrompter({
      runtime: createRuntime() as never,
      options: {
        nonInteractive: true,
        repair: true,
      },
    });

    await expect(prompter.confirmRepair({ message: "repair me" })).resolves.toBe(true);
    await expect(
      prompter.confirmSkipInNonInteractive({ message: "skip in non-interactive" }),
    ).resolves.toBe(false);
  });

  it("does not apply recommended repairs in plain non-interactive mode", async () => {
    const prompter = createDoctorPrompter({
      runtime: createRuntime() as never,
      options: {
        nonInteractive: true,
      },
    });

    await expect(prompter.confirmRepair({ message: "repair me" })).resolves.toBe(false);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { runGatewayUpdate } from "./update-runner.js";

describe("runGatewayUpdate staging mode", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let tempDir = "";

  beforeEach(async () => {
    if (!fixtureRoot) {
      fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-staging-"));
    }
    tempDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(tempDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "openclaw", version: "1.0.0", packageManager: "pnpm@8.0.0" }),
      "utf-8",
    );
    await fs.writeFile(path.join(tempDir, "openclaw.mjs"), "export {};\n", "utf-8");
    const uiIndexPath = path.join(tempDir, "dist", "control-ui", "index.html");
    await fs.mkdir(path.dirname(uiIndexPath), { recursive: true });
    await fs.writeFile(uiIndexPath, "<html></html>", "utf-8");
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("uses non-repair doctor mode when OPENCLAW_UPDATE_STAGING=1", async () => {
    const calls: string[] = [];
    const doctorCalls: string[] = [];
    const runCommand = async (argv: string[]) => {
      const key = argv.join(" ");
      calls.push(key);
      if (key === `git -C ${tempDir} rev-parse --show-toplevel`) {
        return { stdout: `${tempDir}\n`, stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} rev-parse HEAD`) {
        return { stdout: "abc123\n", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} status --porcelain -- :!dist/control-ui/`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} fetch --all --prune --tags`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} tag --list v* --sort=-v:refname`) {
        return { stdout: "v1.0.1\n", stderr: "", code: 0 };
      }
      if (key === `git -C ${tempDir} checkout --detach v1.0.1`) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (
        key === "pnpm install --frozen-lockfile" ||
        key === "pnpm build" ||
        key === "pnpm ui:build"
      ) {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (key.includes(" doctor --non-interactive")) {
        doctorCalls.push(key);
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const result = await withEnvAsync(
      { OPENCLAW_UPDATE_STAGING: "1" },
      async () =>
        await runGatewayUpdate({
          cwd: tempDir,
          channel: "stable",
          timeoutMs: 5000,
          runCommand: async (argv) => await runCommand(argv),
        }),
    );

    expect(result.status).toBe("ok");
    expect(doctorCalls).toHaveLength(1);
    expect(doctorCalls[0]).toContain("doctor --non-interactive");
    expect(doctorCalls[0]).not.toContain("--fix");
    expect(calls.some((call) => call === "pnpm ui:build")).toBe(true);
  });
});

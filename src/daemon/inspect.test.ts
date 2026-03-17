import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findExtraGatewayServices } from "./inspect.js";

const { execSchtasksMock } = vi.hoisted(() => ({
  execSchtasksMock: vi.fn(),
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

function makeLaunchAgentPlist(params: { label: string; programArguments: string[] }): string {
  const programArguments = params.programArguments
    .map((entry) => `        <string>${entry}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${params.label}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
</dict>
</plist>
`;
}

describe("findExtraGatewayServices (darwin)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("ignores non-gateway moltbot launch agents but keeps legacy gateway services", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-inspect-darwin-"));
    const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(launchAgentsDir, { recursive: true });

    fs.writeFileSync(
      path.join(launchAgentsDir, "com.moltbot.backup.dev.plist"),
      makeLaunchAgentPlist({
        label: "com.moltbot.backup.dev",
        programArguments: ["/Users/ss/moltbot/scripts/backup-openclaw.sh", "--profile", "dev"],
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(launchAgentsDir, "com.moltbot.gateway.prod.plist"),
      makeLaunchAgentPlist({
        label: "com.moltbot.gateway.prod",
        programArguments: [
          "/opt/homebrew/bin/node",
          "/Users/ss/openclaw-prod/openclaw.mjs",
          "gateway",
          "run",
        ],
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(launchAgentsDir, "ai.openclaw.gateway.plist"),
      makeLaunchAgentPlist({
        label: "ai.openclaw.gateway",
        programArguments: [
          "/opt/homebrew/bin/node",
          "/Users/ss/openclaw-prod/openclaw.mjs",
          "gateway",
          "run",
        ],
      }),
      "utf-8",
    );

    try {
      const result = await findExtraGatewayServices({ HOME: home });

      expect(result).toEqual([
        {
          platform: "darwin",
          label: "com.moltbot.gateway.prod",
          detail: `plist: ${path.join(launchAgentsDir, "com.moltbot.gateway.prod.plist")}`,
          scope: "user",
          marker: "openclaw",
          legacy: true,
        },
      ]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("findExtraGatewayServices (win32)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    execSchtasksMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("skips schtasks queries unless deep mode is enabled", async () => {
    const result = await findExtraGatewayServices({});
    expect(result).toEqual([]);
    expect(execSchtasksMock).not.toHaveBeenCalled();
  });

  it("returns empty results when schtasks query fails", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "error",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([]);
  });

  it("collects only non-openclaw marker tasks from schtasks output", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 0,
      stdout: [
        "TaskName: OpenClaw Gateway",
        "Task To Run: C:\\Program Files\\OpenClaw\\openclaw.exe gateway run",
        "",
        "TaskName: Clawdbot Legacy",
        "Task To Run: C:\\clawdbot\\clawdbot.exe run",
        "",
        "TaskName: Other Task",
        "Task To Run: C:\\tools\\helper.exe",
        "",
        "TaskName: MoltBot Legacy",
        "Task To Run: C:\\moltbot\\moltbot.exe run",
        "",
      ].join("\n"),
      stderr: "",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([
      {
        platform: "win32",
        label: "Clawdbot Legacy",
        detail: "task: Clawdbot Legacy, run: C:\\clawdbot\\clawdbot.exe run",
        scope: "system",
        marker: "clawdbot",
        legacy: true,
      },
      {
        platform: "win32",
        label: "MoltBot Legacy",
        detail: "task: MoltBot Legacy, run: C:\\moltbot\\moltbot.exe run",
        scope: "system",
        marker: "moltbot",
        legacy: true,
      },
    ]);
  });
});

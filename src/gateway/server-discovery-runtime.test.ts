import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startGatewayBonjourAdvertiser: vi.fn(),
  resolveTailnetDnsHint: vi.fn(),
  resolveBonjourCliPath: vi.fn(),
  formatBonjourInstanceName: vi.fn(),
  pickPrimaryTailnetIPv4: vi.fn(),
  pickPrimaryTailnetIPv6: vi.fn(),
  resolveWideAreaDiscoveryDomain: vi.fn(),
  writeWideAreaGatewayZone: vi.fn(),
}));

vi.mock("../infra/bonjour.js", () => ({
  startGatewayBonjourAdvertiser: mocks.startGatewayBonjourAdvertiser,
}));

vi.mock("./server-discovery.js", () => ({
  resolveTailnetDnsHint: mocks.resolveTailnetDnsHint,
  resolveBonjourCliPath: mocks.resolveBonjourCliPath,
  formatBonjourInstanceName: mocks.formatBonjourInstanceName,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
  pickPrimaryTailnetIPv6: mocks.pickPrimaryTailnetIPv6,
}));

vi.mock("../infra/widearea-dns.js", () => ({
  resolveWideAreaDiscoveryDomain: mocks.resolveWideAreaDiscoveryDomain,
  writeWideAreaGatewayZone: mocks.writeWideAreaGatewayZone,
}));

import { startGatewayDiscovery } from "./server-discovery-runtime.js";

describe("startGatewayDiscovery", () => {
  beforeEach(() => {
    mocks.startGatewayBonjourAdvertiser.mockReset();
    mocks.startGatewayBonjourAdvertiser.mockResolvedValue({ stop: async () => {} });
    mocks.resolveTailnetDnsHint.mockReset();
    mocks.resolveTailnetDnsHint.mockResolvedValue(undefined);
    mocks.resolveBonjourCliPath.mockReset();
    mocks.resolveBonjourCliPath.mockReturnValue("/opt/homebrew/bin/openclaw");
    mocks.formatBonjourInstanceName.mockReset();
    mocks.formatBonjourInstanceName.mockImplementation((name: string) => name);
    mocks.pickPrimaryTailnetIPv4.mockReset();
    mocks.pickPrimaryTailnetIPv6.mockReset();
    mocks.resolveWideAreaDiscoveryDomain.mockReset();
    mocks.writeWideAreaGatewayZone.mockReset();
    delete process.env.OPENCLAW_DISABLE_BONJOUR;
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";
  });

  test("skips bonjour advertising for loopback-only gateways", async () => {
    await startGatewayDiscovery({
      machineDisplayName: "Test Mac",
      port: 18789,
      bindHost: "127.0.0.1",
      wideAreaDiscoveryEnabled: false,
      tailscaleMode: "off",
      logDiscovery: { info: vi.fn(), warn: vi.fn() },
    });

    expect(mocks.startGatewayBonjourAdvertiser).not.toHaveBeenCalled();
  });

  test("starts bonjour advertising for non-loopback gateways", async () => {
    await startGatewayDiscovery({
      machineDisplayName: "Test Mac",
      port: 18789,
      bindHost: "192.168.50.10",
      wideAreaDiscoveryEnabled: false,
      tailscaleMode: "off",
      logDiscovery: { info: vi.fn(), warn: vi.fn() },
    });

    expect(mocks.startGatewayBonjourAdvertiser).toHaveBeenCalledTimes(1);
  });

  test("respects explicit mdns off even on non-loopback gateways", async () => {
    await startGatewayDiscovery({
      machineDisplayName: "Test Mac",
      port: 18789,
      bindHost: "192.168.50.10",
      wideAreaDiscoveryEnabled: false,
      tailscaleMode: "off",
      mdnsMode: "off",
      logDiscovery: { info: vi.fn(), warn: vi.fn() },
    });

    expect(mocks.startGatewayBonjourAdvertiser).not.toHaveBeenCalled();
  });
});

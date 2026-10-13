import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/base-plugin/gimi/payment-confirmed/route";

const mocks = vi.hoisted(() => ({ item: vi.fn(), existing: vi.fn(), save: vi.fn(), notify: vi.fn() }));
vi.mock("@/lib/rentableItems", () => ({ getRentableItem: mocks.item }));
vi.mock("@/lib/rentalIntentsRepository", () => ({ newRentalIntentId: () => "intent_base", getRentalIntentsRepository: () => ({ getByProviderPaymentId: mocks.existing, save: mocks.save }) }));
vi.mock("@/lib/notificationsRepository", () => ({ getNotificationsRepository: () => ({ save: mocks.notify }), newNotification: (v: unknown) => v }));

function request(token?: string, overrides = {}) {
  return new NextRequest("http://localhost/api/base-plugin/gimi/payment-confirmed", {
    method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ itemId: "item_1", renterWallet: `0x${"a".repeat(40)}`, txHash: `0x${"1".repeat(64)}`, chain: "base-sepolia", hours: 2, ...overrides }),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("BASE_MCP_CONFIRMATION_SECRET", "");
  mocks.item.mockResolvedValue({ id: "item_1", name: "Camera", status: "available", owner: "owner", ratePerHour: 2, minimumFee: 2, buyoutCap: 30, expectedHours: 2 });
  mocks.save.mockImplementation(async (v) => v);
});
afterEach(() => vi.unstubAllEnvs());

describe("Base confirmation boundary", () => {
  it.each(["", "   "])("fails closed in production with an unconfigured secret", async (secret) => {
    vi.stubEnv("BASE_MCP_CONFIRMATION_SECRET", secret);
    expect((await POST(request())).status).toBe(503);
    expect(mocks.item).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("also fails closed on deployed previews", async () => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("VERCEL", "1");
    expect((await POST(request())).status).toBe(503);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects the wrong bearer and accepts the configured caller", async () => {
    vi.stubEnv("BASE_MCP_CONFIRMATION_SECRET", "test-only-secret");
    expect((await POST(request("wrong"))).status).toBe(401);
    expect(mocks.save).not.toHaveBeenCalled();
    const response = await POST(request("test-only-secret"));
    expect(response.status).toBe(200);
    expect((await response.json()).verificationMode).toBe("bearer_authorized_caller_attested");
  });
  it("retains explicitly local demo behavior", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).verificationMode).toBe("caller_attested_demo");
  });
  it("does not reserve an unavailable item", async () => {
    vi.stubEnv("BASE_MCP_CONFIRMATION_SECRET", "test-only-secret");
    mocks.item.mockResolvedValue({ id: "item_1", status: "paused" });
    expect((await POST(request("test-only-secret"))).status).toBe(409);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it("keeps matching payment retries idempotent even after inventory changes", async () => {
    vi.stubEnv("BASE_MCP_CONFIRMATION_SECRET", "test-only-secret");
    mocks.item.mockResolvedValue({ id: "item_1", status: "rented" });
    const existing = { id: "intent_base", itemId: "item_1", renterWallet: `0x${"a".repeat(40)}` };
    mocks.existing.mockResolvedValue(existing);
    const response = await POST(request("test-only-secret"));
    expect(response.status).toBe(200);
    expect((await response.json()).idempotent).toBe(true);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects reuse of a payment for another item or renter", async () => {
    vi.stubEnv("BASE_MCP_CONFIRMATION_SECRET", "test-only-secret");
    mocks.existing.mockResolvedValue({ itemId: "other_item", renterWallet: `0x${"a".repeat(40)}` });
    expect((await POST(request("test-only-secret"))).status).toBe(409);
    mocks.existing.mockResolvedValue({ itemId: "item_1", renterWallet: `0x${"b".repeat(40)}` });
    expect((await POST(request("test-only-secret"))).status).toBe(409);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

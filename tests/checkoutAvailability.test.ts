import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as intent } from "@/app/api/rentals/intent/route";
import { POST as solana } from "@/app/api/solana-pay/start-rental/route";
import { GET as base } from "@/app/api/base-plugin/gimi/prepare-deposit/route";
import { POST as mcp } from "@/app/api/mcp/route";
import { POST as voice } from "@/app/api/elevenlabs/tools/route";

const mocks = vi.hoisted(() => ({ item: vi.fn(), save: vi.fn(), funding: vi.fn(), preflight: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/rentableItems", () => ({ getRentableItem: mocks.item, getRentableItems: async () => [] }));
vi.mock("@/lib/rentalIntentsRepository", () => ({ getRentalIntentsRepository: () => ({ save: mocks.save }), newRentalIntentId: () => "intent_test" }));
vi.mock("@/lib/rentalExecutionEvents", () => ({ executionProvenanceReady: () => true, initialIntentExecutionEvents: () => [], recordExecutionEventsSafely: vi.fn() }));
vi.mock("@/lib/rentproofProgram", () => ({
  AUTO_BUYOUT_GRACE_SECONDS: 0, PLATFORM_FEE_BPS: 500,
  ensureDemoRenterUsdc: mocks.funding, preflightStartRental: mocks.preflight, buildStartRentalTransaction: mocks.transaction,
  deriveRentProofAccounts: () => ({ accounts: {} }), ratePerSecondBaseUnits: () => 1, usdcBaseUnits: () => 1,
  DEMO_RENTER_WALLET: "wallet", publicKeyOrFallback: () => ({ toBase58: () => "wallet" }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockImplementation(async (v) => v);
  mocks.preflight.mockResolvedValue({ ok: true });
  mocks.transaction.mockResolvedValue({ transactionBase64: "unsigned", rentProof: { accounts: {} } });
});

const routes = [
  ["card intent", () => intent(new NextRequest("http://localhost/api/rentals/intent", { method: "POST", body: JSON.stringify({ itemId: "item_1", paymentMethod: "card" }) }))],
  ["Solana funding", () => solana(new NextRequest("http://localhost/api/solana-pay/start-rental", { method: "POST", body: JSON.stringify({ itemId: "item_1", renterWallet: "wallet" }) }))],
  ["Base funding", () => base(new NextRequest(`http://localhost/api/base-plugin/gimi/prepare-deposit?itemId=item_1&escrow=0x${"a".repeat(40)}`))],
  ["MCP funding", () => mcp(new NextRequest("http://localhost/api/mcp", { method: "POST", body: JSON.stringify({ tool: "rentproof.create_rental_request", itemId: "item_1" }) }))],
  ["voice funding", () => voice(new NextRequest("http://localhost/api/elevenlabs/tools", { method: "POST", body: JSON.stringify({ tool: "rentproof.create_rental_request", itemId: "item_1" }) }))],
] as const;

describe.each(routes)("%s availability", (_, call) => {
  it.each(["paused", "rented", "return_requested", "buyout", "disputed"])("rejects %s inventory before funding or persistence", async (status) => {
    mocks.item.mockResolvedValue({ id: "item_1", status, minimumFee: 1, ratePerHour: 1, buyoutCap: 10, expectedHours: 2 });
    expect((await call()).status).toBe(409);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.funding).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("continues to accept available inventory", async () => {
    mocks.item.mockResolvedValue({ id: "item_1", status: "available", name: "Camera", owner: "owner", minimumFee: 1, ratePerHour: 1, buyoutCap: 10, expectedHours: 2 });
    expect((await call()).status).toBe(200);
  });
});

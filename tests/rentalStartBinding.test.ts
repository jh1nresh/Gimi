import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/rentals/start/route";
import type { PersistedRentalIntent } from "@/lib/rentalIntentsRepository";

const mocks = vi.hoisted(() => ({ item: vi.fn(), intent: vi.fn(), compare: vi.fn(), saveIntent: vi.fn(), account: vi.fn(), saveSession: vi.fn(), signature: vi.fn() }));
const key = "11111111111111111111111111111111";
vi.mock("@solana/web3.js", async (original) => {
  const actual = await original<typeof import("@solana/web3.js")>();
  return { ...actual, Connection: class { getAccountInfo = mocks.account; } };
});
vi.mock("@/lib/rentableItems", () => ({ getRentableItem: mocks.item }));
vi.mock("@/lib/listingsRepository", () => ({ getListingsRepository: () => ({ getById: async () => undefined }) }));
vi.mock("@/lib/rentalIntentsRepository", () => ({ getRentalIntentsRepository: () => ({ getById: mocks.intent, compareAndSave: mocks.compare, save: mocks.saveIntent }) }));
vi.mock("@/lib/rentalSessionsRepository", () => ({ getRentalSessionsRepository: () => ({ save: mocks.saveSession }) }));
vi.mock("@/lib/rentproofProgram", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  const address = "11111111111111111111111111111111";
  return {
    RENTAL_ITEM_STATUS_RENTED: 1, RENTAL_SESSION_STATUS_ACTIVE: 1,
    RENTAL_SESSION_PROGRAM_ID: new PublicKey(address), SOLANA_RPC_URL: "http://localhost:8899",
    assertConfirmedSignature: mocks.signature, usdcBaseUnits: () => 30,
    deriveRentProofAccounts: () => ({ rentalIdHash: "hash", accounts: { item: address, session: address, owner: address, renter: address, paymentMint: address, rentalToken: address, escrowTokenAccount: address } }),
    decodeRentalItemAccount: () => ({ status: 1, activeSession: address, owner: address, paymentMint: address }),
    decodeRentalSessionAccount: () => ({ status: 1, item: address, owner: address, renter: address, paymentMint: address, rentalIdHash: "hash", escrowAmount: BigInt(30), startTs: BigInt(1), dueTs: BigInt(2), expectedFeeAtStart: BigInt(1) }),
  };
});

let intent: PersistedRentalIntent;
beforeEach(async () => {
  vi.resetAllMocks();
  const { PublicKey } = await import("@solana/web3.js");
  intent = { id: "intent_1", itemId: "item_1", itemName: "Camera", ownerWallet: key, renterWallet: key, rentalId: "rental_1", paymentMethod: "solana_wallet", provider: "solana", paymentStatus: "created", escrowStatus: "not_funded", sessionStatus: "intent", receiptStatus: "none", currency: "USDC", durationHours: 2, rentAmount: 4, depositAmount: 30, platformFeeEstimate: 0.2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };
  mocks.item.mockResolvedValue({ id: "item_1", owner: key, buyoutCap: 30 });
  mocks.intent.mockImplementation(async () => ({ ...intent }));
  mocks.account.mockResolvedValue({ owner: new PublicKey(key), data: Buffer.alloc(0) });
  mocks.saveSession.mockImplementation(async (v) => v);
  mocks.saveIntent.mockImplementation(async (v) => v);
  mocks.compare.mockImplementation(async (v) => v);
});

function request(withIntent = true) {
  return new NextRequest("http://localhost/api/rentals/start", { method: "POST", body: JSON.stringify({ itemId: "item_1", rentalId: "rental_1", renterWallet: key, startRentalSignature: "1".repeat(88), intentId: withIntent ? "intent_1" : undefined }) });
}

describe("Solana rental intent binding", () => {
  it.each([
    { paymentMethod: "card", provider: "moonpay_commerce" },
    { itemId: "other_item" }, { renterWallet: "other_renter" }, { ownerWallet: "other_owner" },
    { rentalId: "other_rental" }, { sessionStatus: "returned" }, { sessionStatus: "cancelled" },
  ] as Partial<PersistedRentalIntent>[])("rejects unrelated or closed intent %j", async (overrides) => {
    Object.assign(intent, overrides);
    expect((await POST(request())).status).toBe(409);
    expect(mocks.account).not.toHaveBeenCalled();
    expect(mocks.saveSession).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
    expect(mocks.saveIntent).not.toHaveBeenCalled();
  });
  it("rejects a missing intent instead of silently syncing the rental", async () => {
    mocks.intent.mockResolvedValue(undefined);
    expect((await POST(request())).status).toBe(404);
    expect(mocks.saveSession).not.toHaveBeenCalled();
  });
  it("syncs the matching intent only after checking the on-chain session", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.signature).toHaveBeenCalled();
    expect(mocks.account).toHaveBeenCalledTimes(2);
    expect(mocks.compare).toHaveBeenCalledWith(expect.objectContaining({ id: "intent_1", rentalId: "rental_1", escrowStatus: "onchain_locked", sessionStatus: "active" }), intent.updatedAt);
  });
  it("does not overwrite a concurrent intent change", async () => {
    mocks.compare.mockResolvedValue(undefined);
    expect((await POST(request())).status).toBe(409);
    expect(mocks.saveIntent).not.toHaveBeenCalled();
  });
  it("preserves wallet-only rentals that do not have a payment intent", async () => {
    expect((await POST(request(false))).status).toBe(200);
    expect(mocks.intent).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
  });
});

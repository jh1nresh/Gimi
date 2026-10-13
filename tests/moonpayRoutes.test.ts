import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedRentalIntent } from "@/lib/rentalIntentsRepository";
import { POST as webhook } from "@/app/api/payments/moonpay/webhook/route";
import { POST as checkout } from "@/app/api/payments/moonpay/checkout/route";

const mocks = vi.hoisted(() => ({ get: vi.fn(), byPayment: vi.fn(), save: vi.fn(), compare: vi.fn(), checkout: vi.fn(), events: vi.fn(), item: vi.fn() }));
vi.mock("@/lib/rentalIntentsRepository", () => ({ getRentalIntentsRepository: () => ({ getById: mocks.get, getByProviderPaymentId: mocks.byPayment, save: mocks.save, compareAndSave: mocks.compare }) }));
vi.mock("@/lib/moonpayCommerce", async (original) => ({ ...await original<typeof import("@/lib/moonpayCommerce")>(), createMoonPayCheckout: mocks.checkout }));
vi.mock("@/lib/rentableItems", () => ({ getRentableItem: mocks.item }));
vi.mock("@/lib/rentalExecutionEvents", () => ({ executionProvenanceReady: () => true, recordExecutionEventsSafely: mocks.events }));

let stored: PersistedRentalIntent;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MOONPAY_COMMERCE_WEBHOOK_SECRET", "local-test-secret");
  stored = { id: "intent_1", itemId: "item_1", itemName: "Camera", ownerWallet: "owner", paymentMethod: "card", provider: "moonpay_commerce", providerPaymentId: "payment_1", paymentStatus: "requires_action", escrowStatus: "not_funded", sessionStatus: "intent", receiptStatus: "none", currency: "USD", durationHours: 2, rentAmount: 4, depositAmount: 30, platformFeeEstimate: 0.2, expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  mocks.get.mockImplementation(async (id) => id === stored.id ? { ...stored } : undefined);
  mocks.byPayment.mockImplementation(async (id) => id === stored.providerPaymentId ? { ...stored } : undefined);
  mocks.save.mockImplementation(async (value) => (stored = value));
  mocks.compare.mockImplementation(async (value, expected) => stored.updatedAt === expected ? (stored = value) : undefined);
  mocks.checkout.mockResolvedValue({ providerPaymentId: "payment_2", checkoutUrl: "https://checkout.example/test" });
  mocks.item.mockResolvedValue({ id: "item_1", status: "available" });
});
afterEach(() => vi.unstubAllEnvs());

function event(paymentId = "payment_1", intentId: string | null = "intent_1") {
  return new NextRequest("http://localhost/api/payments/moonpay/webhook", { method: "POST", headers: { authorization: "Bearer local-test-secret" }, body: JSON.stringify({ id: paymentId, status: "completed", metadata: intentId ? { rentalIntentId: intentId } : {} }) });
}
function checkoutRequest() {
  return new NextRequest("http://localhost/api/payments/moonpay/checkout", { method: "POST", body: JSON.stringify({ intentId: stored.id }) });
}

describe("MoonPay webhook binding", () => {
  it.each([["solana_wallet", "solana"], ["base_mcp", "base_mcp"], ["card", "stripe"]] as const)("rejects %s / %s intents", async (method, provider) => {
    stored.paymentMethod = method; stored.provider = provider;
    expect((await webhook(event())).status).toBe(409);
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it("rejects replacing an existing provider payment", async () => {
    expect((await webhook(event("payment_other"))).status).toBe(409);
    expect(stored.paymentStatus).toBe("requires_action");
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it("does not fall back to another intent when metadata conflicts", async () => {
    expect((await webhook(event("payment_1", "nonexistent_intent"))).status).toBe(409);
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it("rejects binding an already-used provider payment to a second intent", async () => {
    stored.providerPaymentId = undefined;
    mocks.byPayment.mockResolvedValue({ ...stored, id: "intent_other", providerPaymentId: "payment_1" });
    expect((await webhook(event())).status).toBe(409);
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it.each(["intent_1", null])("confirms matching canonical payment (metadata %s)", async (id) => {
    expect((await webhook(event("payment_1", id))).status).toBe(200);
    expect(stored.paymentStatus).toBe("confirmed");
    expect(stored.providerPaymentId).toBe("payment_1");
    const duplicate = await webhook(event("payment_1", id));
    expect((await duplicate.json()).ignored).toBe(true);
    expect(mocks.compare).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "moonpay_hosted_intent_1", "moonpay_intent_1"])("supports first binding from %s with matching metadata", async (placeholder) => {
    stored.providerPaymentId = placeholder;
    expect((await webhook(event())).status).toBe(200);
    expect(stored.providerPaymentId).toBe("payment_1");
  });
});

describe("MoonPay checkout state", () => {
  it("does not erase funding that arrives while checkout is being prepared", async () => {
    stored.providerPaymentId = undefined;
    mocks.checkout.mockImplementation(async () => {
      stored = { ...stored, paymentStatus: "confirmed", escrowStatus: "provider_captured", sessionStatus: "reserved", updatedAt: "2026-01-02T00:00:00.000Z" };
      return { providerPaymentId: "payment_2", checkoutUrl: "https://checkout.example/test" };
    });
    expect((await checkout(checkoutRequest())).status).toBe(409);
    expect(stored.paymentStatus).toBe("confirmed");
    expect(stored.escrowStatus).toBe("provider_captured");
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.events).not.toHaveBeenCalled();
  });
  it("updates an eligible intent when its version has not changed", async () => {
    stored.providerPaymentId = undefined;
    expect((await checkout(checkoutRequest())).status).toBe(200);
    expect(stored.providerPaymentId).toBe("payment_2");
    expect(mocks.compare).toHaveBeenCalledTimes(1);
  });
  it("reuses an open checkout so its original payment can still confirm after retry", async () => {
    stored.providerCheckoutUrl = "https://checkout.example/original";
    const response = await checkout(checkoutRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ idempotent: true, providerPaymentId: "payment_1", checkoutUrl: stored.providerCheckoutUrl });
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
    expect((await webhook(event())).status).toBe(200);
    expect(stored.paymentStatus).toBe("confirmed");
  });
  it("does not replace a bound payment when its checkout URL is unavailable", async () => {
    expect((await checkout(checkoutRequest())).status).toBe(409);
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it("does not route a Stripe intent to MoonPay", async () => {
    stored.provider = "stripe";
    expect((await checkout(checkoutRequest())).status).toBe(409);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it.each(["reserved", "active", "returned", "cancelled"] as const)("does not reopen a %s intent", async (status) => {
    stored.sessionStatus = status;
    expect((await checkout(checkoutRequest())).status).toBe(409);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it("does not open checkout for newly paused inventory", async () => {
    mocks.item.mockResolvedValue({ id: "item_1", status: "paused" });
    expect((await checkout(checkoutRequest())).status).toBe(409);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
});

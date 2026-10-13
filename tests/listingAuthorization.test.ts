import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOwnerActionMessage } from "@/lib/ownerActionProof";
import { PATCH } from "@/app/api/listings/route";

const repository = vi.hoisted(() => ({ getById: vi.fn(), updateStatusForOwner: vi.fn() }));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/listingsRepository", () => ({ getListingsRepository: () => repository }));
vi.mock("@/lib/notificationsRepository", () => ({ getNotificationsRepository: () => ({ save: notify }), newNotification: (v: unknown) => v }));

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const address = bs58.encode(publicKey.export({ format: "der", type: "spki" }).subarray(-32));

function proof(action = "pause_listing", id = "item_1", issuedAt = new Date().toISOString()) {
  // The wire format is shared with the existing owner-approval bridge.
  const message = buildOwnerActionMessage({ action: action as Parameters<typeof buildOwnerActionMessage>[0]["action"], intentId: id, ownerWallet: address, issuedAt });
  return { address, message, signature: bs58.encode(sign(null, Buffer.from(message), privateKey)) };
}

function request(ownerProof?: unknown, status = "paused") {
  return new NextRequest("http://localhost/api/listings", {
    method: "PATCH", body: JSON.stringify({ id: "item_1", ownerWallet: address, status, ownerProof }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  repository.getById.mockResolvedValue({ id: "item_1", ownerWallet: address, status: "available" });
  repository.updateStatusForOwner.mockImplementation(async (id, ownerWallet, status) => ({ id, ownerWallet, status, name: "Camera" }));
});

describe("listing owner authorization", () => {
  it("rejects a public wallet address without its signature", async () => {
    expect((await PATCH(request())).status).toBe(403);
    expect(repository.updateStatusForOwner).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    ["different listing", () => proof("pause_listing", "item_2")],
    ["different action", () => proof("make_listing_available")],
    ["expired proof", () => proof("pause_listing", "item_1", new Date(Date.now() - 360_000).toISOString())],
    ["forged signature", () => ({ ...proof(), signature: bs58.encode(Buffer.alloc(64)) })],
  ])("rejects %s without mutating inventory", async (_, makeProof) => {
    expect((await PATCH(request(makeProof()))).status).toBe(403);
    expect(repository.updateStatusForOwner).not.toHaveBeenCalled();
  });

  it.each([["paused", "pause_listing"], ["available", "make_listing_available"]])("allows the owner to set %s", async (status, action) => {
    repository.getById.mockResolvedValue({ id: "item_1", ownerWallet: address, status: status === "paused" ? "available" : "paused" });
    expect((await PATCH(request(proof(action), status))).status).toBe(200);
    expect(repository.updateStatusForOwner).toHaveBeenCalledWith("item_1", address, status);
  });

  it("keeps rented inventory locked even with a valid owner signature", async () => {
    repository.getById.mockResolvedValue({ id: "item_1", ownerWallet: address, status: "rented" });
    expect((await PATCH(request(proof()))).status).toBe(409);
    expect(repository.updateStatusForOwner).not.toHaveBeenCalled();
  });
});

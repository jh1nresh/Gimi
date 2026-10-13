import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const html = readFileSync(new URL("../public/gimi.html", import.meta.url), "utf8");
const source = html.match(/async function updateOwnerListingStatus\([\s\S]*?\n\}/)?.[0];
if (!source) throw new Error("Owner listing handler is missing");

function context() {
  const ctx = {
    connectedWallet: "owner_wallet",
    requestOwnerActionProof: vi.fn(),
    fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ listing: { status: "paused" } }) }),
    setListingStatus: vi.fn(), refreshOwnerInventory: vi.fn(),
    button: { disabled: false, textContent: "Pause listing" },
  };
  return ctx;
}

describe("owner inventory approval UI", () => {
  it.each([["paused", "pause_listing"], ["available", "make_listing_available"]])("sends the signed %s action to the API", async (status, action) => {
    const ctx = context();
    const proof = { address: "owner_wallet", message: "signed action", signature: "signature" };
    ctx.requestOwnerActionProof.mockResolvedValue(proof);
    await runInNewContext(`${source}\nupdateOwnerListingStatus('item_1', '${status}', button)`, ctx);
    expect(ctx.requestOwnerActionProof).toHaveBeenCalledWith(action, "item_1", "owner_wallet");
    expect(JSON.parse(ctx.fetch.mock.calls[0][1].body)).toEqual({ id: "item_1", ownerWallet: "owner_wallet", status, ownerProof: proof });
  });

  it("sends no mutation when wallet approval is rejected and allows retry", async () => {
    const ctx = context();
    ctx.requestOwnerActionProof.mockRejectedValue(new Error("User rejected approval"));
    await runInNewContext(`${source}\nupdateOwnerListingStatus('item_1', 'paused', button)`, ctx);
    expect(ctx.fetch).not.toHaveBeenCalled();
    expect(ctx.button).toEqual({ disabled: false, textContent: "Pause listing" });
    expect(ctx.setListingStatus).toHaveBeenLastCalledWith(expect.any(String), "error");
  });
});

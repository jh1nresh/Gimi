import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMUNITY_ITEMS, DEMO_OWNER_WALLET } from "@/lib/store";
import { DEMO_OWNER_WALLET as PROGRAM_DEMO_OWNER_WALLET } from "@/lib/rentproofProgram";
import { getRentableItems } from "@/lib/rentableItems";

const html = readFileSync(new URL("../public/gimi.html", import.meta.url), "utf8");

function catalogIds() {
  const source = html.match(/const ITEMS = \[([\s\S]*?)\n\];/)?.[1] ?? "";
  return [...source.matchAll(/\bid:'([^']+)'/g)].map((match) => match[1]);
}

describe("demo rental catalog", () => {
  it("maps every displayed product one-to-one to an available canonical item", () => {
    const displayed = catalogIds();
    const available = COMMUNITY_ITEMS.filter((item) => item.status === "available").map((item) => item.id);

    expect(displayed).toEqual(available);
    expect(new Set(displayed).size).toBe(displayed.length);
    expect(html).toContain("Object.fromEntries(ITEMS.map((item) => [item.id, item.id]))");
    expect(html).toContain("`${ITEMS.length} items`");
    expect(html).not.toContain("metaEl.textContent = '24 items'");
    expect(html).toContain('data-q="Wireless mic for an interview"');
    expect(html).not.toContain('data-q="Camping gear for two"');
    expect(html).not.toContain(">24 items<");
    expect(html).not.toContain("|| 'power_bank_18'");
  });

  it("uses the same signable devnet owner across store and program defaults", () => {
    expect(PROGRAM_DEMO_OWNER_WALLET.toBase58()).toBe(DEMO_OWNER_WALLET);
  });

  it("never exposes unavailable static items to renter search", async () => {
    const items = await getRentableItems();

    expect(items.every((item) => item.status === "available")).toBe(true);
    expect(items.map((item) => item.id)).not.toContain("umbrella_02");
    expect(items.map((item) => item.id)).not.toContain("badge_printer_01");
  });
});

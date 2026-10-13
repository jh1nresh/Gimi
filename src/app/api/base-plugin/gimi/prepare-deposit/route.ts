import { NextRequest, NextResponse } from "next/server";
import { buildBaseDepositCall } from "@/lib/baseMcp";
import { getRentableItem } from "@/lib/rentableItems";

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;
  const itemId = searchParams.get("itemId")?.trim();

  if (!itemId) {
    return NextResponse.json({ error: "itemId is required" }, { status: 400 });
  }

  const item = await getRentableItem(itemId);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  if (item.status !== "available") {
    return NextResponse.json({ error: "Item is not available for rental" }, { status: 409 });
  }

  try {
    const prepared = buildBaseDepositCall({
      item,
      hours: searchParams.get("hours"),
      from: searchParams.get("from"),
      escrowAddress: searchParams.get("escrow"),
      chain: searchParams.get("chain"),
    });

    return NextResponse.json({
      reservation: {
        reservationId: `base_${item.id}_${crypto.randomUUID()}`,
        itemId: item.id,
        pickup: item.locationLabel,
        ownerName: item.ownerName,
        status: "prepared",
      },
      quote: prepared.quote,
      baseMcp: {
        executor: "send_calls",
        userApprovalRequired: true,
        calls: [
          {
            chainId: prepared.call.chainId,
            to: prepared.call.to,
            value: prepared.call.value,
            data: prepared.call.data,
          },
        ],
      },
      call: prepared.call,
      settlementModel:
        "This first Base rail prepares deposit funding only. Gimi should later replace the escrow wallet transfer with a Base escrow contract call for return/refund automation.",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to prepare Base deposit call",
        configuration: {
          required: ["BASE_RENTAL_ESCROW_ADDRESS or escrow query parameter"],
          optional: ["BASE_MCP_CHAIN", "BASE_USDC_ADDRESS", "BASE_SEPOLIA_USDC_ADDRESS"],
        },
      },
      { status: 400 }
    );
  }
}

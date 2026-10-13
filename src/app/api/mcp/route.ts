import { NextRequest, NextResponse } from "next/server";
import { getRentableItem, getRentableItems } from "@/lib/rentableItems";
import {
  buildRequestReturnTransaction,
  buildSettleRentalTransaction,
  buildStartRentalTransaction,
  DEMO_RENTER_WALLET,
  preflightRequestReturn,
  preflightSettleRental,
  preflightStartRental,
  publicKeyOrFallback,
} from "@/lib/rentproofProgram";

const tools = [
  "rentproof.find_offers",
  "rentproof.draft_terms",
  "rentproof.quote_funding",
  "rentproof.create_rental_request",
  "rentproof.get_session",
  "rentproof.prepare_return_request",
  "rentproof.prepare_return_confirmation",
  "rentproof.prepare_auto_buyout",
  "rentproof.get_receipt",
];

export async function GET() {
  return NextResponse.json({
    name: "rentproof-mcp",
    mode: "read_prepare_only",
    safety: "MCP never signs transactions, custodies keys, or moves funds.",
    tools,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const tool = body.tool as string;

  if (!tools.includes(tool)) {
    return NextResponse.json({ error: "Unknown tool", tools }, { status: 400 });
  }

  if (tool === "rentproof.find_offers") {
    const items = await getRentableItems();
    return NextResponse.json({
      offers: items.map((item) => ({
        itemId: item.id,
        name: item.name,
        ratePerHour: item.ratePerHour,
        buyoutCap: item.buyoutCap,
        ownerScore: item.ownerScore,
        locationLabel: item.locationLabel,
      })),
    });
  }

  if (tool === "rentproof.draft_terms") {
    const items = await getRentableItems();
    const item = (await getRentableItem(body.itemId ?? "power_bank_18")) ?? items[0];
    if (!item) {
      return NextResponse.json({ error: "No rentable inventory is available" }, { status: 404 });
    }
    const hours = Number(body.hours ?? item.expectedHours);
    return NextResponse.json({
      draft: {
        itemId: item.id,
        expectedFee: Math.max(item.minimumFee, hours * item.ratePerHour),
        refundableEscrow: item.buyoutCap,
        sourceChain: body.sourceChain ?? "base",
        targetChain: "solana",
        riskSummary: "Low-value item, full buyout cap escrow, owner score above threshold.",
      },
    });
  }

  if (tool === "rentproof.create_rental_request") {
    const items = await getRentableItems();
    const item = (await getRentableItem(body.itemId ?? "power_bank_18")) ?? items[0];
    if (!item) {
      return NextResponse.json({ error: "No rentable inventory is available" }, { status: 404 });
    }
    if (item.status !== "available") {
      return NextResponse.json({ error: "Item is not available for rental" }, { status: 409 });
    }
    const renter = publicKeyOrFallback(body.renterWallet, DEMO_RENTER_WALLET);
    const hours = Number(body.hours ?? item.expectedHours);
    const rentalId = body.rentalId ?? body.draftId ?? `mcp_${item.id}_${crypto.randomUUID()}`;
    const preflight = await preflightStartRental({
      itemId: item.id,
      ownerWallet: item.owner,
      renterWallet: renter.toBase58(),
      rentalId,
      buyoutCap: item.buyoutCap,
    });

    if (!preflight.ok) {
      return NextResponse.json({ error: "Token account preflight failed", problems: preflight.problems, preflight }, { status: 409 });
    }

    const serialized = await buildStartRentalTransaction({
      itemId: item.id,
      ownerWallet: item.owner,
      renterWallet: renter.toBase58(),
      rentalId,
      rentalSeconds: Math.ceil(hours * 3600),
    });

    return NextResponse.json({
      rentalId,
      transaction: serialized.transactionBase64,
      transactionMetadata: {
        cluster: serialized.cluster,
        rpcUrl: serialized.rpcUrl,
        blockhash: serialized.blockhash,
        lastValidBlockHeight: serialized.lastValidBlockHeight,
        feePayer: serialized.rentProof.accounts.renter,
        requiredSigner: serialized.rentProof.accounts.renter,
      },
      rentProof: serialized.rentProof,
      preflight,
    });
  }

  if (tool === "rentproof.prepare_return_request") {
    const items = await getRentableItems();
    const item = (await getRentableItem(body.itemId ?? "power_bank_18")) ?? items[0];
    if (!item) {
      return NextResponse.json({ error: "No rentable inventory is available" }, { status: 404 });
    }
    const renter = publicKeyOrFallback(body.renterWallet, DEMO_RENTER_WALLET);
    const rentalId = body.rentalId ?? body.draftId;

    if (!rentalId) {
      return NextResponse.json({ error: "Missing rental id" }, { status: 400 });
    }

    const preflight = await preflightRequestReturn({
      itemId: item.id,
      ownerWallet: item.owner,
      renterWallet: renter.toBase58(),
      rentalId,
    });

    if (!preflight.ok) {
      return NextResponse.json({ error: "Return request preflight failed", problems: preflight.problems, preflight }, { status: 409 });
    }

    const serialized = await buildRequestReturnTransaction({
      itemId: item.id,
      ownerWallet: item.owner,
      renterWallet: renter.toBase58(),
      rentalId,
    });

    return NextResponse.json({
      rentalId,
      transaction: serialized.transactionBase64,
      transactionMetadata: {
        cluster: serialized.cluster,
        rpcUrl: serialized.rpcUrl,
        blockhash: serialized.blockhash,
        lastValidBlockHeight: serialized.lastValidBlockHeight,
        feePayer: serialized.rentProof.accounts.renter,
        requiredSigner: serialized.rentProof.accounts.renter,
      },
      rentProof: serialized.rentProof,
      preflight,
      safety: "Unsigned renter transaction only. The MCP tool cannot sign or move funds.",
    });
  }

  if (tool === "rentproof.prepare_return_confirmation" || tool === "rentproof.prepare_auto_buyout") {
    const items = await getRentableItems();
    const item = (await getRentableItem(body.itemId ?? "power_bank_18")) ?? items[0];
    if (!item) {
      return NextResponse.json({ error: "No rentable inventory is available" }, { status: 404 });
    }
    const renter = publicKeyOrFallback(body.renterWallet, DEMO_RENTER_WALLET);
    const rentalId = body.rentalId ?? body.draftId;

    if (!rentalId) {
      return NextResponse.json({ error: "Missing rental id" }, { status: 400 });
    }

    const preflight = await preflightSettleRental({
      itemId: item.id,
      ownerWallet: item.owner,
      renterWallet: renter.toBase58(),
      rentalId,
    });

    if (!preflight.ok) {
      return NextResponse.json({ error: "Settlement preflight failed", problems: preflight.problems, preflight }, { status: 409 });
    }

    const serialized = await buildSettleRentalTransaction({
      kind: tool === "rentproof.prepare_return_confirmation" ? "confirm_return" : "auto_buyout",
      itemId: item.id,
      ownerWallet: item.owner,
      renterWallet: renter.toBase58(),
      payerWallet: body.payerWallet,
      rentalId,
    });

    return NextResponse.json({
      rentalId,
      transaction: serialized.transactionBase64,
      transactionMetadata: {
        cluster: serialized.cluster,
        rpcUrl: serialized.rpcUrl,
        blockhash: serialized.blockhash,
        lastValidBlockHeight: serialized.lastValidBlockHeight,
        feePayer: serialized.feePayer,
        requiredSigner: serialized.requiredSigner,
      },
      rentProof: serialized.rentProof,
      preflight,
      settlementModel:
        tool === "rentproof.prepare_return_confirmation"
          ? "Owner-signed return confirmation splits accrued rent into owner payout and platform fee, then refunds the renter remainder."
          : "Permissionless auto-buyout can be signed by any keeper after due time plus grace; funds still settle to owner/platform accounts.",
    });
  }

  return NextResponse.json({
    result: {
      tool,
      status: "prepared",
      nextAction: "Wallet approval required before any irreversible transaction.",
    },
  });
}

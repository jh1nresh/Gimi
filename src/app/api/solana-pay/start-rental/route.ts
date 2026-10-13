import { NextRequest, NextResponse } from "next/server";
import { getRentableItem } from "@/lib/rentableItems";
import {
  AUTO_BUYOUT_GRACE_SECONDS,
  PLATFORM_FEE_BPS,
  deriveRentProofAccounts,
  buildStartRentalTransaction,
  ensureDemoRenterUsdc,
  preflightStartRental,
  ratePerSecondBaseUnits,
  usdcBaseUnits,
} from "@/lib/rentproofProgram";

export async function GET(req: NextRequest) {
  const draftId = req.nextUrl.searchParams.get("draftId") ?? "draft_power_bank_18";
  return NextResponse.json({
    label: "Gimi Rental",
    icon: "/globe.svg",
    title: "Start rental",
    description: `Approve RentProof rental request ${draftId}`,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const item = await getRentableItem(body.itemId ?? "power_bank_18");

  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  if (item.status !== "available") {
    return NextResponse.json({ error: "Item is not available for rental" }, { status: 409 });
  }

  const draftId = body.draftId ?? `draft_${item.id}_${crypto.randomUUID()}`;
  const solanaPayUrl = `solana:https://rentproof.local/api/solana-pay/start-rental?draftId=${draftId}`;
  const requestedHours = Number(body.hours ?? item.expectedHours);
  const hours = Number.isFinite(requestedHours) ? Math.min(24 * 7, Math.max(1, requestedHours)) : item.expectedHours;
  const renterWallet = body.account ?? body.renterWallet;

  if (!renterWallet) {
    return NextResponse.json({ error: "Missing renter wallet" }, { status: 400 });
  }

  const rentalSeconds = Math.ceil(hours * 3600);
  const demoFunding = await ensureDemoRenterUsdc({
    renterWallet,
    minimumUiAmount: item.buyoutCap,
  });
  const rentProof = deriveRentProofAccounts({
    itemId: item.id,
    ownerWallet: item.owner,
    renterWallet,
    rentalId: draftId,
  });
  const preflight = await preflightStartRental({
    itemId: item.id,
    ownerWallet: item.owner,
    renterWallet,
    rentalId: draftId,
    buyoutCap: item.buyoutCap,
  });

  if (!preflight.ok) {
    return NextResponse.json(
      {
        error: "Token account preflight failed",
        problems: preflight.problems,
        preflight,
        demoFunding,
        rentProof,
      },
      { status: 409 }
    );
  }

  const serialized = await buildStartRentalTransaction({
    itemId: item.id,
    ownerWallet: item.owner,
    renterWallet,
    rentalId: draftId,
    rentalSeconds,
  });

  return NextResponse.json({
    draftId,
    solanaPayUrl,
    rentProof,
    preflight,
    demoFunding,
    programStatus: "devnet_program_deployed_unsigned_transaction_serialized",
    transaction: serialized.transactionBase64,
    message: `Start Gimi rental for ${item.name}. This unsigned devnet transaction locks ${item.buyoutCap} demo USDC into metered escrow; rent accrues hourly until return or auto-buyout settlement.`,
    transactionMetadata: {
      cluster: serialized.cluster,
      rpcUrl: serialized.rpcUrl,
      blockhash: serialized.blockhash,
      lastValidBlockHeight: serialized.lastValidBlockHeight,
      feePayer: serialized.rentProof.accounts.renter,
      requiredSigner: serialized.rentProof.accounts.renter,
    },
    transactionPlan: [
      "start_rental",
      "preflight_renter_demo_usdc_ata_and_balance",
      `lock_${item.buyoutCap}_usdc_escrow`,
      "meter_rent_accrual_inside_escrow",
      "create_rental_session",
      "mint_program_owned_rental_token_pda",
    ],
    instructionArgs: {
      initializeConfig: {
        feeBps: PLATFORM_FEE_BPS,
      },
      initializeItem: {
        itemIdHash: rentProof.itemIdHash,
        metadataHash: rentProof.itemIdHash,
        ratePerSecond: ratePerSecondBaseUnits(item.ratePerHour),
        minimumFee: usdcBaseUnits(item.minimumFee),
        buyoutCap: usdcBaseUnits(item.buyoutCap),
        autoBuyoutGraceSeconds: AUTO_BUYOUT_GRACE_SECONDS,
      },
      startRental: {
        rentalIdHash: rentProof.rentalIdHash,
        rentalSeconds,
      },
    },
    item: {
      id: item.id,
      name: item.name,
      escrowAmount: item.buyoutCap,
      expectedHours: hours,
      renterWallet,
    },
  });
}

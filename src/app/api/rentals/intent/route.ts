import { NextRequest, NextResponse } from "next/server";
import { getRentableItem } from "@/lib/rentableItems";
import {
  getRentalIntentsRepository,
  newRentalIntentId,
  RentalIntentPaymentMethod,
} from "@/lib/rentalIntentsRepository";
import { executionProvenanceReady, initialIntentExecutionEvents, recordExecutionEventsSafely } from "@/lib/rentalExecutionEvents";

const PAYMENT_METHODS = new Set<RentalIntentPaymentMethod>(["card", "solana_wallet"]);
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;

function errorResponse(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

function normalizedHours(value: unknown, fallback: number) {
  const hours = Number(value ?? fallback);
  if (!Number.isFinite(hours)) return fallback;
  return Math.min(24 * 7, Math.max(1, hours));
}

function money(value: number) {
  return Number(value.toFixed(2));
}

function checkoutUrl(intentId: string) {
  const configured = process.env.MOONPAY_COMMERCE_CHECKOUT_URL ?? process.env.STRIPE_CHECKOUT_URL;
  if (!configured) return undefined;

  const url = new URL(configured);
  url.searchParams.set("client_reference_id", intentId);
  return url.toString();
}

export async function POST(req: NextRequest) {
  if (!executionProvenanceReady()) return errorResponse("Execution provenance is not configured", 503);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
  const paymentMethod = typeof body.paymentMethod === "string" ? body.paymentMethod : "";
  const renterWallet = typeof body.renterWallet === "string" ? body.renterWallet.trim() : "";
  const renterIdentity = typeof body.renterIdentity === "string" ? body.renterIdentity.trim() : "";

  if (!itemId) return errorResponse("itemId is required", 400);
  if (!PAYMENT_METHODS.has(paymentMethod as RentalIntentPaymentMethod)) {
    return errorResponse("paymentMethod must be card or solana_wallet", 400);
  }
  if (renterWallet && !WALLET_PATTERN.test(renterWallet)) {
    return errorResponse("renterWallet must be a Solana-style address", 400);
  }

  try {
    const item = await getRentableItem(itemId);
    if (!item) return errorResponse("Item not found", 404);
    if (item.status !== "available") return errorResponse("Item is not available for rental", 409);

    const hours = normalizedHours(body.hours, item.expectedHours);
    const rentAmount = money(Math.max(item.minimumFee, item.ratePerHour * hours));
    const depositAmount = money(item.buyoutCap);
    const platformFeeEstimate = money(rentAmount * 0.05);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    const id = newRentalIntentId();
    const isCard = paymentMethod === "card";
    const providerCheckoutUrl = isCard ? checkoutUrl(id) : undefined;

    const intent = await getRentalIntentsRepository().save({
      id,
      itemId: item.id,
      itemName: item.name,
      ownerWallet: item.owner,
      renterWallet: renterWallet || undefined,
      renterIdentity: renterIdentity || undefined,
      paymentMethod: paymentMethod as RentalIntentPaymentMethod,
      paymentStatus: isCard ? "requires_action" : "created",
      escrowStatus: "not_funded",
      sessionStatus: "intent",
      receiptStatus: "none",
      currency: isCard ? "USD" : "USDC",
      durationHours: hours,
      rentAmount,
      depositAmount,
      platformFeeEstimate,
      provider: isCard ? "moonpay_commerce" : "solana",
      providerCheckoutUrl,
      rentalId: `draft_${item.id}_${crypto.randomUUID()}`,
      notes: isCard
        ? "Card checkout authorizes rent plus deposit first; settlement later writes a Solana receipt."
        : "Solana wallet checkout locks buyout-cap USDC into program escrow.",
      expiresAt: expiresAt.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const executionTraceStatus = await recordExecutionEventsSafely(
      initialIntentExecutionEvents(intent, {
        sourceTool: "POST /api/rentals/intent",
        approvalTool: isCard ? "card checkout" : "Solana wallet approval",
        approvalStatus: "waiting",
        approvalPaymentMode: "simulated",
      })
    );

    return NextResponse.json({
      intent,
      executionTraceStatus,
      paymentRouter: {
        method: intent.paymentMethod,
        cardCheckoutReady: Boolean(providerCheckoutUrl),
        provider: intent.provider,
        checkoutUrl: providerCheckoutUrl ?? null,
        nextAction: isCard
          ? providerCheckoutUrl
            ? "redirect_or_embed_provider_checkout"
            : "create_moonpay_checkout"
          : "prepare_solana_start_rental_transaction",
      },
      proofModel: {
        paymentRail: isCard ? "fiat_card" : "solana_usdc",
        receiptRail: "solana_receipt_after_return_settlement",
        identityRail: renterWallet ? "wallet" : "email_or_privy_user",
      },
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to create rental intent", 400);
  }
}

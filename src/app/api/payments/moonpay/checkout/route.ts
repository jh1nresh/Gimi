import { NextRequest, NextResponse } from "next/server";
import { createMoonPayCheckout, totalAmount } from "@/lib/moonpayCommerce";
import { getRentalIntentsRepository } from "@/lib/rentalIntentsRepository";
import { getRentableItem } from "@/lib/rentableItems";
import { executionProvenanceReady, recordExecutionEventsSafely } from "@/lib/rentalExecutionEvents";

function errorResponse(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export async function POST(req: NextRequest) {
  if (!executionProvenanceReady()) return errorResponse("Execution provenance is not configured", 503);
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const intentId = typeof body.intentId === "string" ? body.intentId.trim() : "";
  if (!intentId) return errorResponse("intentId is required", 400);

  try {
    const repository = getRentalIntentsRepository();
    const intent = await repository.getById(intentId);
    if (!intent) return errorResponse("Rental intent not found", 404);
    if (intent.paymentMethod !== "card") {
      return errorResponse("MoonPay checkout only supports card rental intents", 400);
    }
    if (intent.provider !== "moonpay_commerce") {
      return errorResponse("Rental intent does not use MoonPay checkout", 409);
    }
    if (intent.paymentStatus === "confirmed") {
      return errorResponse("Rental intent is already funded", 409, { intent });
    }
    if (intent.sessionStatus !== "intent" || intent.escrowStatus !== "not_funded" ||
      !["created", "requires_action"].includes(intent.paymentStatus) || Date.parse(intent.expiresAt) <= Date.now()) {
      return errorResponse("Rental intent is no longer awaiting checkout", 409);
    }
    const item = await getRentableItem(intent.itemId);
    if (!item || item.status !== "available") return errorResponse("Item is not available for rental", 409);

    const hasBoundPayment = intent.providerPaymentId &&
      intent.providerPaymentId !== `moonpay_hosted_${intent.id}` &&
      intent.providerPaymentId !== `moonpay_${intent.id}`;
    if (hasBoundPayment) {
      if (!intent.providerCheckoutUrl) return errorResponse("Existing MoonPay payment needs checkout reconciliation", 409);
      return NextResponse.json({
        intent,
        idempotent: true,
        providerPaymentId: intent.providerPaymentId,
        checkoutUrl: intent.providerCheckoutUrl,
        amount: {
          rent: intent.rentAmount, deposit: intent.depositAmount, platformFeeEstimate: intent.platformFeeEstimate,
          total: totalAmount(intent), currency: intent.currency,
        },
        provider: { name: "moonpay_commerce", raw: { mode: "existing_checkout" } },
      });
    }

    const checkout = await createMoonPayCheckout(intent);
    const updatedIntent = await repository.compareAndSave({
      ...intent,
      provider: "moonpay_commerce",
      providerPaymentId: checkout.providerPaymentId,
      providerCheckoutUrl: checkout.checkoutUrl,
      paymentStatus: "requires_action",
      escrowStatus: "not_funded",
      sessionStatus: "intent",
      updatedAt: new Date(Math.max(Date.now(), Date.parse(intent.updatedAt) + 1)).toISOString(),
    }, intent.updatedAt);
    if (!updatedIntent) {
      return errorResponse("Rental intent changed while preparing checkout; refresh its status", 409);
    }
    const executionTraceStatus = await recordExecutionEventsSafely([
      {
        eventKey: "moonpay-checkout-requested",
        intentId: updatedIntent.id,
        rentalId: updatedIntent.rentalId,
        itemId: updatedIntent.itemId,
        step: "approval_requested",
        actor: "gimi_agent",
        tool: "MoonPay Commerce checkout",
        summary: "Opened provider checkout and is waiting for renter authorization.",
        approvalRequired: true,
        status: "waiting",
        paymentMode: "simulated",
        recordRef: `intent:${updatedIntent.id}`,
      },
    ]);

    return NextResponse.json({
      intent: updatedIntent,
      executionTraceStatus,
      providerPaymentId: checkout.providerPaymentId,
      checkoutUrl: checkout.checkoutUrl ?? null,
      amount: {
        rent: intent.rentAmount,
        deposit: intent.depositAmount,
        platformFeeEstimate: intent.platformFeeEstimate,
        total: totalAmount(intent),
        currency: intent.currency,
      },
      provider: {
        name: "moonpay_commerce",
        raw: checkout.raw,
      },
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to create MoonPay checkout", 400);
  }
}

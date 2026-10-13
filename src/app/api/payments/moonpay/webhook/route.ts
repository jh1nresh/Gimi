import { NextRequest, NextResponse } from "next/server";
import {
  moonPayStatusToIntent,
  moonPayTransitionAllowed,
  parseMoonPayWebhook,
  verifyMoonPayWebhook,
} from "@/lib/moonpayCommerce";
import { getRentalIntentsRepository } from "@/lib/rentalIntentsRepository";
import { executionProvenanceReady, recordExecutionEventsSafely } from "@/lib/rentalExecutionEvents";

function errorResponse(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export async function POST(req: NextRequest) {
  if (!executionProvenanceReady()) return errorResponse("Execution provenance is not configured", 503);
  const rawBody = await req.text();
  const verification = await verifyMoonPayWebhook(req, rawBody);
  if (!verification.ok) {
    return errorResponse("Invalid MoonPay webhook signature", 401, { verificationMode: verification.mode });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  try {
    const event = parseMoonPayWebhook(body);
    const repository = getRentalIntentsRepository();
    const paymentIntent = await repository.getByProviderPaymentId(event.providerPaymentId);
    const intent =
      (event.rentalIntentId ? await repository.getById(event.rentalIntentId) : undefined) ??
      paymentIntent;
    if (!intent) {
      return errorResponse("Rental intent not found for provider payment", 404, {
        providerPaymentId: event.providerPaymentId,
        rentalIntentId: event.rentalIntentId ?? null,
      });
    }

    if (
      intent.paymentMethod !== "card" || intent.provider !== "moonpay_commerce" ||
      (event.rentalIntentId && event.rentalIntentId !== intent.id) ||
      (paymentIntent && paymentIntent.id !== intent.id)
    ) {
      return errorResponse("MoonPay payment does not belong to this rental intent", 409);
    }
    const awaitingProviderId = !intent.providerPaymentId ||
      intent.providerPaymentId === `moonpay_hosted_${intent.id}` ||
      intent.providerPaymentId === `moonpay_${intent.id}`;
    if (awaitingProviderId ? event.rentalIntentId !== intent.id : intent.providerPaymentId !== event.providerPaymentId) {
      return errorResponse("MoonPay payment id does not match the rental checkout", 409);
    }

    const mapped = moonPayStatusToIntent(event.status);
    if (!moonPayTransitionAllowed(intent, mapped)) {
      return NextResponse.json({ ok: true, ignored: true, intent, event: { providerPaymentId: event.providerPaymentId, status: event.status } });
    }
    const updatedIntent = await repository.compareAndSave({
      ...intent,
      provider: "moonpay_commerce",
      providerPaymentId: event.providerPaymentId,
      paymentStatus: mapped.paymentStatus,
      escrowStatus: mapped.escrowStatus,
      sessionStatus: mapped.sessionStatus,
      receiptStatus: mapped.receiptStatus,
      notes: `MoonPay webhook ${event.status}`,
      updatedAt: new Date().toISOString(),
    }, intent.updatedAt);
    if (!updatedIntent) {
      return NextResponse.json({
        ok: true,
        ignored: true,
        reason: "concurrent_or_stale_provider_transition",
        intent: await repository.getById(intent.id),
        event: { providerPaymentId: event.providerPaymentId, status: event.status },
      });
    }
    const executionTraceStatus = await recordExecutionEventsSafely([
      {
        eventKey: `moonpay-${event.status}`,
        intentId: updatedIntent.id,
        rentalId: updatedIntent.rentalId,
        itemId: updatedIntent.itemId,
        step: mapped.paymentStatus === "confirmed" ? "rental_funded" : "approval_requested",
        actor: "payment_provider",
        tool: "MoonPay signed webhook",
        summary:
          mapped.paymentStatus === "confirmed"
            ? "Verified provider webhook confirmed rental funding."
            : `Verified provider webhook reported ${event.status}.`,
        approvalRequired: true,
        status:
          mapped.paymentStatus === "confirmed"
            ? "completed"
            : mapped.paymentStatus === "failed" || mapped.paymentStatus === "expired"
              ? "failed"
              : "waiting",
        paymentMode:
          mapped.paymentStatus === "confirmed" ? "provider_authorized" : "simulated",
        recordRef: `intent:${updatedIntent.id}`,
      },
    ]);

    return NextResponse.json({
      ok: true,
      intent: updatedIntent,
      executionTraceStatus,
      event: {
        providerPaymentId: event.providerPaymentId,
        status: event.status,
      },
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to process MoonPay webhook", 400);
  }
}

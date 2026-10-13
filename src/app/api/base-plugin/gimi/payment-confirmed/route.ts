import { NextRequest, NextResponse } from "next/server";
import {
  baseChainConfig,
  baseExplorerUrl,
  buildBaseRentalQuote,
  isBaseTransactionHash,
  isEvmAddress,
  normalizeBaseChain,
} from "@/lib/baseMcp";
import { getRentableItem } from "@/lib/rentableItems";
import { getRentalIntentsRepository, newRentalIntentId } from "@/lib/rentalIntentsRepository";
import { getNotificationsRepository, newNotification } from "@/lib/notificationsRepository";

function errorResponse(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export async function POST(req: NextRequest) {
  const expectedSecret = process.env.BASE_MCP_CONFIRMATION_SECRET?.trim();
  if (!expectedSecret && (process.env.NODE_ENV === "production" || process.env.VERCEL)) {
    return errorResponse("Base MCP confirmation is not configured", 503);
  }
  if (expectedSecret) {
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (bearer !== expectedSecret) return errorResponse("Unauthorized Base MCP confirmation", 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
  const renterWallet = typeof body.renterWallet === "string" ? body.renterWallet.trim() : "";
  const txHash = typeof body.txHash === "string" ? body.txHash.trim() : "";
  const renterIdentity = typeof body.renterIdentity === "string" ? body.renterIdentity.trim() : "";

  if (!itemId) return errorResponse("itemId is required", 400);
  if (!isEvmAddress(renterWallet)) return errorResponse("renterWallet must be a 0x-prefixed EVM address", 400);
  if (!isBaseTransactionHash(txHash)) return errorResponse("txHash must be a Base transaction hash", 400);

  try {
    const item = await getRentableItem(itemId);
    if (!item) return errorResponse("Item not found", 404);

    const chain = normalizeBaseChain(body.chain);
    const chainConfig = baseChainConfig(chain);
    const providerPaymentId = `base:${chainConfig.chainId}:${txHash.toLowerCase()}`;
    const repository = getRentalIntentsRepository();
    const existing = await repository.getByProviderPaymentId(providerPaymentId);
    if (existing) {
      if (existing.itemId !== itemId || existing.renterWallet?.toLowerCase() !== renterWallet.toLowerCase()) {
        return errorResponse("Base payment is already bound to another rental", 409);
      }
      return NextResponse.json({
        intent: existing,
        idempotent: true,
        explorerUrl: baseExplorerUrl(chain, txHash),
        nextAction: "owner_mark_handed_off",
      });
    }

    if (item.status !== "available") return errorResponse("Item is not available for rental", 409);

    const quote = buildBaseRentalQuote(item, body.hours);
    const now = new Date();
    const intent = await repository.save({
      id: newRentalIntentId(),
      itemId: item.id,
      itemName: item.name,
      ownerWallet: item.owner,
      renterWallet,
      renterIdentity: renterIdentity || undefined,
      paymentMethod: "base_mcp",
      paymentStatus: "confirmed",
      escrowStatus: "provider_captured",
      sessionStatus: "reserved",
      receiptStatus: "none",
      currency: "USDC",
      durationHours: quote.hours,
      rentAmount: quote.rentAmountUsdc,
      depositAmount: quote.depositAmountUsdc,
      platformFeeEstimate: quote.platformFeeEstimateUsdc,
      provider: "base_mcp",
      providerCheckoutUrl: baseExplorerUrl(chain, txHash),
      providerPaymentId,
      rentalId: `base_${item.id}_${crypto.randomUUID()}`,
      notes:
        "Base MCP payment was confirmed. Funds are tracked as provider-captured until owner handoff and return settlement.",
      expiresAt: new Date(now.getTime() + quote.hours * 3_600_000).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });

    await getNotificationsRepository().save(
      newNotification({
        wallet: intent.ownerWallet,
        kind: "rental_handoff",
        title: "Base MCP rental funded",
        body: `${intent.itemName} was funded with Base USDC. Mark handed off after pickup.`,
        href: intent.providerCheckoutUrl,
      })
    );
    await getNotificationsRepository().save(
      newNotification({
        wallet: renterWallet,
        kind: "rental_handoff",
        title: "Rental reserved",
        body: `${intent.itemName} is reserved. Pick up at ${item.locationLabel}.`,
        href: intent.providerCheckoutUrl,
      })
    );

    return NextResponse.json({
      intent,
      quote,
      explorerUrl: intent.providerCheckoutUrl,
      verificationMode: expectedSecret ? "bearer_authorized_caller_attested" : "caller_attested_demo",
      nextAction: "owner_mark_handed_off",
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to confirm Base MCP payment", 400);
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getRentableItems } from "@/lib/rentableItems";
import { getListingsRepository } from "@/lib/listingsRepository";
import { PersistedListingStatus } from "@/lib/listings";
import { getNotificationsRepository, newNotification } from "@/lib/notificationsRepository";
import { verifyOwnerActionProof } from "@/lib/ownerActionProof";

const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const OWNER_MUTABLE_STATUSES = new Set<PersistedListingStatus>(["available", "paused"]);

function errorResponse(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

function limitFromSearchParam(value: string | null) {
  if (!value) return undefined;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit < 1) return undefined;
  return limit;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const ownerWallet = searchParams.get("ownerWallet")?.trim() ?? "";
  const limit = limitFromSearchParam(searchParams.get("limit"));
  const repository = getListingsRepository();
  if (ownerWallet) {
    if (!WALLET_PATTERN.test(ownerWallet)) {
      return errorResponse("ownerWallet must be a Solana-style address", 400);
    }
    const ownerListings = await repository.listByOwner(ownerWallet, limit);
    return NextResponse.json({
      listings: ownerListings,
      inventory: ownerListings,
      count: ownerListings.length,
      storage: repository.storageKind,
      filters: { ownerWallet },
    });
  }

  const listings = await repository.listAvailable();
  const inventory = await getRentableItems();

  return NextResponse.json({
    listings,
    inventory,
    count: listings.length,
    storage: repository.storageKind,
  });
}

export async function PATCH(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const ownerWallet = typeof body.ownerWallet === "string" ? body.ownerWallet.trim() : "";
  const status = typeof body.status === "string" ? body.status.trim() : "";

  if (!id) return errorResponse("id is required", 400);
  if (!WALLET_PATTERN.test(ownerWallet)) return errorResponse("ownerWallet must be a Solana-style address", 400);
  if (!OWNER_MUTABLE_STATUSES.has(status as PersistedListingStatus)) {
    return errorResponse("status must be available or paused", 400);
  }

  try {
    const listing = await getListingsRepository().getById(id);
    if (!listing) return errorResponse("Listing not found", 404);
    if (listing.ownerWallet !== ownerWallet) return errorResponse("Only the owner wallet can update this listing", 403);
    try {
      verifyOwnerActionProof({
        proof: body.ownerProof,
        action: status === "paused" ? "pause_listing" : "make_listing_available",
        intentId: id,
        ownerWallet,
      });
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : "Owner wallet signature is required", 403);
    }
    if (listing.status !== "available" && listing.status !== "paused") {
      return errorResponse("Only available or paused listings can be changed from inventory management", 409, { listing });
    }

    const updated = await getListingsRepository().updateStatusForOwner(id, ownerWallet, status as PersistedListingStatus);
    await getNotificationsRepository().save(
      newNotification({
        wallet: ownerWallet,
        kind: "listing_status",
        title: updated.status === "paused" ? "Listing paused" : "Listing available",
        body:
          updated.status === "paused"
            ? `${updated.name} is hidden from renter search.`
            : `${updated.name} is available for renters again.`,
      })
    );
    return NextResponse.json({ listing: updated });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Unable to update listing", 400);
  }
}

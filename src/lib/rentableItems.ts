import { listingToRentalItem } from "./listings";
import { getListingsRepository } from "./listingsRepository";
import { getItem, getItems } from "./store";
import { RentalItem } from "./types";

export async function getRentableItem(id: string): Promise<RentalItem | undefined> {
  const listing = await getListingsRepository().getById(id);
  if (listing) return listingToRentalItem(listing);
  return getItem(id);
}

export async function getRentableItems(): Promise<RentalItem[]> {
  const listings = await getListingsRepository().listAvailable();
  const listingItems = listings.map(listingToRentalItem);
  const seen = new Set(listingItems.map((item) => item.id));
  return [
    ...listingItems,
    ...getItems().filter((item) => item.status === "available" && !seen.has(item.id)),
  ];
}

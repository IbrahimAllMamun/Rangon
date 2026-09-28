/**
 * Where a coupon can be spent: the online shop, the register, or both.
 *
 * Stored as the coupon's `channels`, where an empty list means everywhere --
 * which is what every coupon made before this choice existed is, and so what
 * the counter takes (business-rules §3.3).
 */

export interface CouponPlaces {
  online: boolean;
  inStore: boolean;
}

export function placesFromChannels(channels: string[] | null | undefined): CouponPlaces {
  if (!channels?.length) return { online: true, inStore: true };
  return { online: channels.includes("ONLINE"), inStore: channels.includes("POS") };
}

/** Both is stored as everywhere. Neither is not a choice the form lets through. */
export function channelsFromPlaces(places: CouponPlaces): string[] {
  if (places.online && places.inStore) return [];
  if (places.online) return ["ONLINE"];
  if (places.inStore) return ["POS"];
  return [];
}

export function whereLabel(channels: string[] | null | undefined): string {
  const { online, inStore } = placesFromChannels(channels);
  if (online && inStore) return "Online and in store";
  if (online) return "Online only";
  if (inStore) return "In store only";
  return "Nowhere";
}

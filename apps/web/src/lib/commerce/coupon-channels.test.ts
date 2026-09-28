import { describe, expect, it } from "vitest";

import { channelsFromPlaces, placesFromChannels, whereLabel } from "./coupon-channels";

describe("coupon channels", () => {
  it("reads a coupon with no channels as usable everywhere", () => {
    // Every coupon made before the form had this choice.
    expect(placesFromChannels([])).toEqual({ online: true, inStore: true });
    expect(whereLabel([])).toBe("Online and in store");
  });

  it("reads one channel as that place only", () => {
    expect(placesFromChannels(["ONLINE"])).toEqual({ online: true, inStore: false });
    expect(placesFromChannels(["POS"])).toEqual({ online: false, inStore: true });
    expect(whereLabel(["POS"])).toBe("In store only");
  });

  it("stores both places as everywhere, and one as itself", () => {
    expect(channelsFromPlaces({ online: true, inStore: true })).toEqual([]);
    expect(channelsFromPlaces({ online: true, inStore: false })).toEqual(["ONLINE"]);
    expect(channelsFromPlaces({ online: false, inStore: true })).toEqual(["POS"]);
  });

  it("round-trips what the form can save", () => {
    for (const channels of [[], ["ONLINE"], ["POS"]]) {
      expect(channelsFromPlaces(placesFromChannels(channels))).toEqual(channels);
    }
  });

  it("says so when a coupon names neither place", () => {
    expect(whereLabel(["PHONE"])).toBe("Nowhere");
  });
});

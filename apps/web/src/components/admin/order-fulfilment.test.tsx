/**
 * The fulfilment panel's own logic — the part a round trip cannot check.
 *
 * The server owns every rule (business-rules.md §8a.3, and
 * `tests/api/test_shipment_fulfilment.py` asserts each one independently).
 * What lives only in the browser is which controls are offered: a parcel
 * cannot be booked against an order that must not leave the shop, a delivered
 * parcel offers no "record an update", and a tracking number typed without a
 * courier is caught before the request rather than after it.
 *
 * Plain matchers throughout: `@testing-library/jest-dom` is installed but no
 * vitest setup file registers it, so `toBeInTheDocument` is not available here
 * -- the same reason `supplier-payment-form.test.tsx` does without it.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OrderFulfilment } from "./order-fulfilment";
import type { Shipment } from "@/lib/api/types";

const apiClient = vi.fn();

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
  return { ...actual, apiClient: (...args: unknown[]) => apiClient(...args) };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

const COURIERS = [{ id: "cr-1", name: "Pathao Courier" }];

function parcel(overrides: Partial<Shipment> = {}): Shipment {
  return {
    id: "sh-1",
    order: "o-1",
    order_number: "RGN-WEB-000001",
    courier: "cr-1",
    courier_name: "Pathao Courier",
    shipping_method: null,
    tracking_number: "PX-1",
    tracking_url: "https://track.example/PX-1",
    status: "DISPATCHED",
    cost: "70.00",
    dispatched_at: null,
    delivered_at: null,
    notes: "",
    events: [],
    created_at: "2026-09-15T04:00:00Z",
    ...overrides,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof OrderFulfilment>> = {}) {
  return render(
    <OrderFulfilment
      orderId="o-1"
      orderStatus="PACKED"
      shipments={[]}
      couriers={COURIERS}
      canFulfil
      {...props}
    />,
  );
}

describe("OrderFulfilment", () => {
  beforeEach(() => {
    apiClient.mockReset();
    apiClient.mockResolvedValue({ id: "sh-new" });
  });

  it("refuses a tracking number with no courier without calling the API", async () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText(/tracking number/i), {
      target: { value: "ORPHAN-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /book a parcel/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/courier that issued/i);
    });
    expect(apiClient).not.toHaveBeenCalled();
  });

  it("books a parcel with the courier and number the packer chose", async () => {
    renderPanel();
    // Exact, not /courier/i: the cost field is labelled "What the courier
    // charges us", so a loose match finds two controls.
    fireEvent.change(screen.getByLabelText("Courier"), { target: { value: "cr-1" } });
    fireEvent.change(screen.getByLabelText(/tracking number/i), { target: { value: "PX-9" } });
    fireEvent.click(screen.getByRole("button", { name: /book a parcel/i }));

    await waitFor(() => expect(apiClient).toHaveBeenCalledTimes(1));
    const [path, options] = apiClient.mock.calls[0];
    expect(path).toBe("/shipments/");
    expect(options.body).toMatchObject({
      order: "o-1",
      courier: "cr-1",
      tracking_number: "PX-9",
    });
    // Never sent: the server owns the parcel's journey, and offering these
    // would be offering a delivery nobody recorded.
    expect(options.body).not.toHaveProperty("status");
    expect(options.body).not.toHaveProperty("delivered_at");
  });

  it("offers no booking form for an order that must not leave the shop", () => {
    renderPanel({ orderStatus: "CANCELLED" });

    expect(screen.queryByRole("button", { name: /book a parcel/i })).toBeNull();
    expect(screen.getByText(/cancelled order cannot be shipped/i)).toBeTruthy();
  });

  it("closes the history of a delivered parcel", () => {
    renderPanel({ shipments: [parcel({ status: "DELIVERED" })] });

    expect(screen.queryByRole("button", { name: /record an update/i })).toBeNull();
    expect(screen.getByText(/its history is closed/i)).toBeTruthy();
  });

  it("keeps offering updates on a failed delivery, which gets retried", () => {
    renderPanel({ shipments: [parcel({ status: "FAILED" })] });

    expect(screen.getByRole("button", { name: /record an update/i })).toBeTruthy();
  });

  it("shows a packer without orders.fulfil the parcels but no controls", () => {
    renderPanel({ shipments: [parcel()], canFulfil: false });

    expect(screen.getByText(/PX-1/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /book a parcel/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /record an update/i })).toBeNull();
  });
});

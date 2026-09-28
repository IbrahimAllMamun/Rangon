/**
 * POS cart draft.
 *
 * Purely client-side working state — nothing here is authoritative. Prices are
 * re-read from the server on every scan, the basket is priced by the server as
 * it changes (`useSaleQuote`), and the sale itself is priced, stock-checked and
 * recorded by the backend under a row lock.
 */
"use client";

import { create } from "zustand";

import type { PosVariant } from "@/lib/api/types";

export interface PosLine {
  variantId: string;
  sku: string;
  barcode: string;
  name: string;
  label: string;
  unitPrice: number;
  quantity: number;
  available: number;
  discount: number;
}

/** How the cashier typed the discount on the whole sale. */
export type DiscountMode = "AMOUNT" | "PERCENT";

/**
 * A manager's approval for a discount above the threshold.
 *
 * Held only while the sale is open and never parked with a hold: it lasts five
 * minutes, belongs to this cashier, and covers no more than `percent`.
 */
export interface PosApprovalState {
  token: string;
  approvedBy: string;
  percent: string;
}

interface PosState {
  lines: PosLine[];
  customerId: string | null;
  customerName: string;
  /** Taka in AMOUNT mode, percent in PERCENT mode. The server turns either into money. */
  orderDiscount: number;
  orderDiscountMode: DiscountMode;
  /** A code as the cashier typed it: a claim the server checks, never an amount. */
  couponCode: string;
  approval: PosApprovalState | null;
  note: string;
  register: string;
  addVariant: (variant: PosVariant, quantity?: number) => void;
  setQuantity: (variantId: string, quantity: number) => void;
  setLineDiscount: (variantId: string, discount: number) => void;
  removeLine: (variantId: string) => void;
  setCustomer: (id: string | null, name: string) => void;
  setOrderDiscount: (value: number, mode?: DiscountMode) => void;
  setCoupon: (code: string) => void;
  setApproval: (approval: PosApprovalState | null) => void;
  setNote: (note: string) => void;
  setRegister: (register: string) => void;
  clear: () => void;
  restore: (payload: unknown) => void;
  /** Lines at shelf price less line discounts: a stand-in until the server's quote arrives. */
  subtotal: () => number;
  itemCount: () => number;
}

/** Only a percentage can be over 100; an amount has no ceiling the browser knows. */
function clampDiscount(value: number, mode: DiscountMode): number {
  const floor = Number.isFinite(value) ? Math.max(0, value) : 0;
  return mode === "PERCENT" ? Math.min(floor, 100) : floor;
}

export const usePos = create<PosState>((set, get) => ({
  lines: [],
  customerId: null,
  customerName: "",
  orderDiscount: 0,
  orderDiscountMode: "AMOUNT",
  couponCode: "",
  approval: null,
  note: "",
  register: "REG-01",

  addVariant: (variant, quantity = 1) =>
    set((state) => {
      const existing = state.lines.find((line) => line.variantId === variant.id);
      if (existing) {
        return {
          lines: state.lines.map((line) =>
            line.variantId === variant.id
              ? { ...line, quantity: line.quantity + quantity, available: variant.available }
              : line,
          ),
        };
      }
      // Newest line first: the cashier's eye is at the top of the list.
      return {
        lines: [
          {
            variantId: variant.id,
            sku: variant.sku,
            barcode: variant.barcode,
            name: variant.name,
            label: variant.label,
            unitPrice: Number(variant.price),
            quantity,
            available: variant.available,
            discount: 0,
          },
          ...state.lines,
        ],
      };
    }),

  setQuantity: (variantId, quantity) =>
    set((state) => ({
      lines:
        quantity <= 0
          ? state.lines.filter((line) => line.variantId !== variantId)
          : state.lines.map((line) =>
              line.variantId === variantId ? { ...line, quantity } : line,
            ),
    })),

  setLineDiscount: (variantId, discount) =>
    set((state) => ({
      lines: state.lines.map((line) =>
        line.variantId === variantId
          ? { ...line, discount: Math.max(0, Math.min(discount, line.unitPrice * line.quantity)) }
          : line,
      ),
    })),

  removeLine: (variantId) =>
    set((state) => ({ lines: state.lines.filter((line) => line.variantId !== variantId) })),

  setCustomer: (customerId, customerName) => set({ customerId, customerName }),
  setOrderDiscount: (value, mode) =>
    set((state) => {
      const next = mode ?? state.orderDiscountMode;
      return { orderDiscount: clampDiscount(value, next), orderDiscountMode: next };
    }),
  setCoupon: (couponCode) => set({ couponCode: couponCode.trim().toUpperCase() }),
  setApproval: (approval) => set({ approval }),
  setNote: (note) => set({ note }),
  setRegister: (register) => set({ register }),

  clear: () =>
    set({
      lines: [],
      customerId: null,
      customerName: "",
      orderDiscount: 0,
      orderDiscountMode: "AMOUNT",
      couponCode: "",
      approval: null,
      note: "",
    }),

  restore: (payload) => {
    const data = payload as Partial<PosState> | null;
    if (!data) return;
    // A hold parked before discounts had a mode carries a plain amount.
    const mode: DiscountMode = data.orderDiscountMode === "PERCENT" ? "PERCENT" : "AMOUNT";
    set({
      lines: Array.isArray(data.lines) ? data.lines : [],
      customerId: data.customerId ?? null,
      customerName: data.customerName ?? "",
      orderDiscount: clampDiscount(Number(data.orderDiscount ?? 0), mode),
      orderDiscountMode: mode,
      couponCode: typeof data.couponCode === "string" ? data.couponCode : "",
      // Never parked: an approval outlives neither five minutes nor its cashier.
      approval: null,
      note: data.note ?? "",
    });
  },

  subtotal: () =>
    get().lines.reduce((sum, line) => sum + line.unitPrice * line.quantity - line.discount, 0),

  itemCount: () => get().lines.reduce((sum, line) => sum + line.quantity, 0),
}));

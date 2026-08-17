/**
 * POS cart draft.
 *
 * Purely client-side working state — nothing here is authoritative. Prices are
 * re-read from the server on every scan, and the sale itself is priced,
 * stock-checked and recorded by the backend under a row lock.
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

interface PosState {
  lines: PosLine[];
  customerId: string | null;
  customerName: string;
  orderDiscount: number;
  note: string;
  register: string;
  addVariant: (variant: PosVariant, quantity?: number) => void;
  setQuantity: (variantId: string, quantity: number) => void;
  setLineDiscount: (variantId: string, discount: number) => void;
  removeLine: (variantId: string) => void;
  setCustomer: (id: string | null, name: string) => void;
  setOrderDiscount: (amount: number) => void;
  setNote: (note: string) => void;
  setRegister: (register: string) => void;
  clear: () => void;
  restore: (payload: unknown) => void;
  subtotal: () => number;
  discountTotal: () => number;
  total: () => number;
  itemCount: () => number;
}

export const usePos = create<PosState>((set, get) => ({
  lines: [],
  customerId: null,
  customerName: "",
  orderDiscount: 0,
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
  setOrderDiscount: (orderDiscount) => set({ orderDiscount: Math.max(0, orderDiscount) }),
  setNote: (note) => set({ note }),
  setRegister: (register) => set({ register }),

  clear: () => set({ lines: [], customerId: null, customerName: "", orderDiscount: 0, note: "" }),

  restore: (payload) => {
    const data = payload as Partial<PosState> | null;
    if (!data) return;
    set({
      lines: Array.isArray(data.lines) ? data.lines : [],
      customerId: data.customerId ?? null,
      customerName: data.customerName ?? "",
      orderDiscount: Number(data.orderDiscount ?? 0),
      note: data.note ?? "",
    });
  },

  subtotal: () =>
    get().lines.reduce((sum, line) => sum + line.unitPrice * line.quantity - line.discount, 0),

  discountTotal: () =>
    get().lines.reduce((sum, line) => sum + line.discount, 0) + get().orderDiscount,

  total: () => Math.max(0, get().subtotal() - get().orderDiscount),

  itemCount: () => get().lines.reduce((sum, line) => sum + line.quantity, 0),
}));

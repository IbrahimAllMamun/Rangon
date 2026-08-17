import { Badge } from "@/components/ui/primitives";
import type { OrderStatus, PaymentStatus } from "@/lib/api/types";
import { humanise } from "@/lib/format";

/**
 * Status badges carry text as well as colour (WCAG 1.4.1) and use the semantic
 * palette — never the brand red, which means "action", not "error".
 */

type Tone = "neutral" | "success" | "warning" | "error" | "info" | "brand" | "dark";

const ORDER_TONES: Record<OrderStatus, Tone> = {
  PENDING: "warning",
  CONFIRMED: "info",
  PROCESSING: "info",
  PACKED: "info",
  SHIPPED: "info",
  DELIVERED: "success",
  CANCELLED: "error",
  RETURN_REQUESTED: "warning",
  RETURNED: "neutral",
  REFUNDED: "neutral",
};

const PAYMENT_TONES: Record<PaymentStatus, Tone> = {
  UNPAID: "warning",
  PARTIALLY_PAID: "warning",
  PAID: "success",
  PARTIALLY_REFUNDED: "neutral",
  REFUNDED: "neutral",
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <Badge tone={ORDER_TONES[status] ?? "neutral"}>{humanise(status)}</Badge>;
}

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return <Badge tone={PAYMENT_TONES[status] ?? "neutral"}>{humanise(status)}</Badge>;
}

export function StockBadge({ available, reorderPoint }: { available: number; reorderPoint: number }) {
  if (available <= 0) return <Badge tone="error">Out of stock</Badge>;
  if (available <= reorderPoint) return <Badge tone="warning">Low ({available})</Badge>;
  return <Badge tone="success">{available} in stock</Badge>;
}

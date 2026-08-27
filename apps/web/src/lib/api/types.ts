/** Shapes returned by the Rangon API (docs/api/endpoints.md). */

export type Channel = "POS" | "ONLINE" | "PHONE" | "SOCIAL" | "OTHER";

export type OrderStatus =
  | "PENDING"
  | "CONFIRMED"
  | "PROCESSING"
  | "PACKED"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED"
  | "RETURN_REQUESTED"
  | "RETURNED"
  | "REFUNDED";

export type PaymentStatus =
  | "UNPAID"
  | "PARTIALLY_PAID"
  | "PAID"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED";

export type PaymentMethod =
  | "CASH"
  | "CARD"
  | "MOBILE_MFS"
  | "BANK"
  | "ONLINE_GATEWAY"
  | "COD"
  | "STORE_CREDIT"
  | "OTHER";

export interface ShopVariant {
  id: string;
  sku: string;
  label: string;
  price: string;
  compare_at_price: string | null;
  available: number;
  in_stock: boolean;
  attributes: Record<string, { value: string; label: string; swatch: string }>;
}

/** The colour an image is bound to; `null` marks a shared image. */
export interface ImageColor {
  code: string;
  value: string;
  label: string;
  swatch: string;
}

export interface ShopImage {
  url: string;
  alt: string;
  color: ImageColor | null;
}

export interface ShopCategoryRef {
  name: string;
  slug: string;
  /** Full path for `/category/[...slug]`, e.g. `women/kurti`. */
  path: string;
}

export interface ShopProduct {
  id: string;
  name: string;
  slug: string;
  short_description: string;
  description: string;
  material: string;
  care_instructions: string;
  category: ShopCategoryRef;
  brand: { name: string; slug: string } | null;
  images: ShopImage[];
  variants: ShopVariant[];
  price_min: string;
  price_max: string;
  in_stock: boolean;
  featured: boolean;
  seo_title: string;
  seo_description: string;
  reviews?: {
    average: number | null;
    count: number;
    items: {
      id: string;
      rating: number;
      title: string;
      comment: string;
      author: string;
      verified: boolean;
      created_at: string;
    }[];
  };
  related?: ShopProduct[];
}

/* ------------------------------------------------------- navigation ------ */

export type NavigationItemType = "CATEGORY" | "LINK" | "PROMO";
export type NavigationLayout = "AUTO" | "DROPDOWN" | "MEGA";

/**
 * One navbar entry. The tree is resolved server-side (ADR-0009) — the frontend
 * never decides whether an item is visible, only how to draw it.
 */
export interface NavigationNode {
  id: string;
  label: string;
  url: string;
  type: NavigationItemType;
  badge: string | null;
  layout: NavigationLayout;
  description: string;
  image: string | null;
  children: NavigationNode[];
}

export interface StorefrontBanner {
  id: string;
  placement: "ANNOUNCEMENT" | "HOME_HERO";
  message: string;
  title: string;
  subtitle: string;
  cta_label: string;
  url: string;
  image: string | null;
  dismissible: boolean;
}

export interface NavigationPayload {
  announcement: StorefrontBanner | null;
  items: NavigationNode[];
  footer: NavigationNode[];
}

export interface ShopCategory {
  id: string;
  name: string;
  slug: string;
  path: string;
  description: string;
  image: string;
  breadcrumbs: { name: string; slug: string; path: string }[];
  children: { name: string; slug: string; path: string }[];
  seo_title: string;
  seo_description: string;
}

export interface CartItem {
  id: string;
  variant: string;
  sku: string;
  product_name: string;
  product_slug: string;
  variant_label: string;
  quantity: number;
  unit_price: string;
  image: string;
  available: number;
}

export interface CartTotals {
  subtotal: string;
  discount_total: string;
  coupon_discount: string;
  tax_total: string;
  shipping_total: string;
  grand_total: string;
  item_count: number;
}

export interface CartIssue {
  code: string;
  message: string;
  variant_id?: string;
  requested?: number;
  available?: number;
}

export interface Cart {
  id: string;
  token: string;
  items: CartItem[];
  totals: CartTotals;
  issues: CartIssue[];
  coupon_code: string;
}

export interface ShippingOption {
  id: string;
  code: string;
  name: string;
  description: string;
  price: string;
  eta: string;
  is_pickup: boolean;
  supports_cod: boolean;
  zone: string;
}

export interface OrderItem {
  id: string;
  variant: string;
  sku: string;
  product_name: string;
  variant_label: string;
  quantity: number;
  unit_price: string;
  unit_cost?: string;
  line_discount: string;
  tax_amount: string;
  line_total: string;
  returned_quantity: number;
  returnable_quantity: number;
  image: string;
}

export interface Payment {
  id: string;
  method: PaymentMethod;
  status: string;
  amount: string;
  tendered_amount: string | null;
  change_amount: string;
  reference: string;
  captured_at: string | null;
  created_at: string;
}

export interface OrderEvent {
  id: string;
  event_type: string;
  message: string;
  data: Record<string, unknown>;
  actor_email: string;
  is_customer_visible: boolean;
  created_at: string;
}

export interface Order {
  id: string;
  number: string;
  channel: Channel;
  status: OrderStatus;
  payment_status: PaymentStatus;
  branch_code: string;
  customer: string;
  customer_name: string;
  customer_phone: string;
  item_count: number;
  subtotal: string;
  discount_total: string;
  coupon_discount?: string;
  tax_total: string;
  shipping_total: string;
  grand_total: string;
  paid_total: string;
  refunded_total: string;
  currency: string;
  created_by_email: string;
  placed_at: string;
  items: OrderItem[];
  payments?: Payment[];
  refunds?: { id: string; amount: string; reason: string; created_at: string }[];
  events?: OrderEvent[];
  shipping_address?: Record<string, string>;
  customer_note?: string;
  register?: string;
  stock_committed?: boolean;
  cancel_reason?: string;
  delivered_at?: string | null;
}

export interface InventoryRow {
  id: string;
  branch_code: string;
  variant: string;
  sku: string;
  barcode: string;
  product_name: string;
  variant_label: string;
  category: string;
  on_hand: number;
  reserved: number;
  available: number;
  average_cost: string;
  price: string;
  stock_value: string;
  reorder_point: number;
  is_low_stock: boolean;
  updated_at: string;
}

export interface DashboardData {
  range: { start: string; end: string; label: string };
  kpis: {
    revenue: string;
    orders: number;
    units_sold: number;
    gross_profit: string;
    margin_percent: string;
    discount_total: string;
    refunded_total: string;
    average_order_value: string;
    returns: number;
    pending_online_orders: number;
    low_stock_products: number;
    inventory_value: string;
    inventory_units: number;
  };
  sales_over_time: { day: string; orders: number; revenue: string; pos: string; online: string }[];
  by_channel: { channel: Channel; orders: number; revenue: string }[];
  payment_methods: { method: PaymentMethod; amount: string; count: number }[];
  top_products: { sku: string; product_name: string; units: number; revenue: string }[];
  category_sales: { category: string; units: number; revenue: string }[];
}

export interface PosVariant {
  id: string;
  sku: string;
  barcode: string;
  name: string;
  label: string;
  price: string;
  available: number;
  image: string;
  category: string;
}

export interface PosSession {
  branch: {
    id: string;
    name: string;
    code: string;
    address: string;
    phone: string;
    register_count: number;
  };
  cashier: { id: string; name: string; email: string; permissions: string[] };
  organization: {
    name: string;
    currency: string;
    receipt_footer: string;
    vat_registration: string;
  };
  holds: { id: string; label: string; payload: unknown; created_at: string }[];
  /**
   * Accounts this branch's takings can land in, sent with the session so
   * opening the register stays a single request.
   */
  accounts: { id: string; name: string; kind: AccountKind; is_default: boolean }[];
}

export interface SessionUser {
  id: string;
  email: string;
  full_name: string;
  role: string;
  role_name: string;
  branch: { id: string; name: string; code: string } | null;
  permissions: string[];
  organization: { name: string; currency: string; receipt_footer: string } | null;
}

/** In-app staff notification (`/notifications/`). */
export interface StaffNotification {
  id: string;
  notification_type: string;
  level: "INFO" | "SUCCESS" | "WARNING" | "ERROR";
  title: string;
  body: string;
  /** In-app path such as "/admin/orders/…"; blank when there is nowhere to go. */
  link: string;
  data: Record<string, unknown>;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

// --- finance (phase 35) ----------------------------------------------------
// Money is a string everywhere, never a JS number: 0.1 + 0.2 !== 0.3, and a
// balance that drifts by a paisa is a balance nobody trusts. Format with
// `money()`; arithmetic belongs on the server.

export type AccountKind = "CASH" | "BANK" | "MFS" | "OTHER";

export type AccountTransactionType =
  | "OPENING"
  | "SALE_PAYMENT"
  | "REFUND"
  | "SUPPLIER_PAYMENT"
  | "EXPENSE"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "ADJUSTMENT";

/** Somewhere money actually sits: a drawer, a bank account, an MFS wallet. */
export interface Account {
  id: string;
  branch: string;
  branch_code: string;
  branch_name: string;
  name: string;
  kind: AccountKind;
  kind_display: string;
  account_number: string;
  bank_name: string;
  /** Cache over the cash book, reconciled by `verify_accounts`. Read-only. */
  balance: string;
  is_active: boolean;
  is_default: boolean;
  allow_overdraft: boolean;
  notes: string;
  created_at: string;
  updated_at: string;
}

/** One movement. `amount` is signed: positive in, negative out. */
export interface AccountTransaction {
  id: string;
  account: string;
  account_name: string;
  account_kind: AccountKind;
  branch_code: string;
  transaction_type: AccountTransactionType;
  type_display: string;
  amount: string;
  balance_after: string;
  reference_type: string;
  reference_id: string;
  reason: string;
  notes: string;
  occurred_at: string;
  created_by_email: string;
  created_at: string;
}

export interface AccountTransfer {
  id: string;
  number: string;
  source_account: string;
  source_account_name: string;
  target_account: string;
  target_account_name: string;
  amount: string;
  occurred_at: string;
  notes: string;
  created_by_email: string;
  created_at: string;
}

export interface CashPosition {
  total: string;
  by_kind: { kind: AccountKind; total: string }[];
  accounts: { id: string; name: string; kind: AccountKind; branch: string; balance: string }[];
  movements: { money_in: string; money_out: string; net: string };
}

export type ExpenseStatus = "RECORDED" | "VOID";

export interface ExpenseCategory {
  id: string;
  name: string;
  code: string;
  description: string;
  is_active: boolean;
  expense_count: number;
  created_at: string;
  updated_at: string;
}

export interface Expense {
  id: string;
  number: string;
  branch: string;
  branch_code: string;
  category: string;
  category_name: string;
  category_code: string;
  account: string;
  account_name: string;
  amount: string;
  spent_at: string;
  note: string;
  attachment: string | null;
  attachment_url: string;
  status: ExpenseStatus;
  status_display: string;
  transaction: string | null;
  reversal: string | null;
  voided_at: string | null;
  voided_by_email: string;
  void_reason: string;
  created_by_email: string;
  created_at: string;
}

export interface ExpenseTotals {
  total: string;
  count: number;
  by_category: {
    category_id: string;
    category: string;
    code: string;
    total: string;
    count: number;
    share: string;
  }[];
}

export type StockCountStatus = "DRAFT" | "COUNTING" | "APPLIED" | "CANCELLED";

export interface StockCountItem {
  id: string;
  variant: string;
  sku: string;
  product_name: string;
  expected_quantity: number;
  counted_quantity: number | null;
  difference: number | null;
  notes: string;
}

export interface StockCount {
  id: string;
  number: string;
  branch: string;
  branch_code: string;
  status: StockCountStatus;
  notes: string;
  items: StockCountItem[];
  created_at: string;
  applied_at: string | null;
}

export interface StockTransferItem {
  id: string;
  variant: string;
  sku: string;
  product_name: string;
  quantity: number;
  unit_cost: string;
}

export interface StockTransfer {
  id: string;
  number: string;
  source_branch: string;
  source_code: string;
  target_branch: string;
  target_code: string;
  status: string;
  notes: string;
  items: StockTransferItem[];
  created_at: string;
  received_at: string | null;
}

export interface BranchSummary {
  id: string;
  name: string;
  code: string;
  is_default: boolean;
  status: string;
}

export type ReturnStatus = "REQUESTED" | "APPROVED" | "RECEIVED" | "COMPLETED" | "REJECTED";
export type RestockDecision = "RESTOCK" | "DAMAGED" | "QUARANTINE";

export interface ReturnItem {
  id: string;
  order_item: string;
  sku: string;
  product_name: string;
  quantity: number;
  restock_decision: RestockDecision;
  condition_note: string;
  refund_amount: string;
}

export interface ReturnRequest {
  id: string;
  number: string;
  order: string;
  order_number: string;
  customer_name: string;
  status: ReturnStatus;
  reason: string;
  customer_comment: string;
  staff_comment: string;
  refund_amount: string;
  refund_shipping: boolean;
  items: ReturnItem[];
  created_at: string;
  approved_at: string | null;
  received_at: string | null;
  completed_at: string | null;
}

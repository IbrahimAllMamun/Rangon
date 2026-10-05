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

/**
 * One specification, grouped by attribute: "Material: Cotton", and equally
 * "Skin type: Dry, Combination" — one attribute may hold several values, which
 * is why the values are a list rather than a string.
 *
 * Detail only. No card renders a spec list, and the listing's query budget is
 * asserted (docs/database/indexing.md).
 */
export interface ShopProductSpec {
  attribute_code: string;
  attribute_name: string;
  kind: string;
  values: { value: string; label: string; swatch: string }[];
}

/**
 * The product's size guide (docs/business-rules.md §5b). Rows are the sizes of
 * one attribute, in that attribute's order; each row's `cells` line up with
 * `columns` by position. Present on detail only.
 */
export interface ShopSizeChart {
  name: string;
  /** Which sizing standard it follows — "UK", "EU", "International" — or "". */
  system: string;
  /** The variant axis it describes, so the guide sits beside the right options. */
  attribute_code: string;
  attribute_name: string;
  columns: string[];
  rows: { value: string; label: string; cells: string[] }[];
  /** How to measure, as plain text. */
  notes: string;
}

export interface TaxTreatment {
  /** "EXCLUSIVE" — added at checkout — or "INCLUSIVE" — already in the price. */
  mode: string;
  /** A fraction, as the API stores it: "0.1500" is 15%. */
  rate: string;
}

export interface ShopProduct {
  id: string;
  name: string;
  slug: string;
  short_description: string;
  description: string;
  material: string;
  care_instructions: string;
  /** Structured specifications. Present on detail, absent on a listing. */
  specs?: ShopProductSpec[];
  /** The size guide. Null when the product has none; absent on a listing. */
  size_chart?: ShopSizeChart | null;
  category: ShopCategoryRef;
  brand: { name: string; slug: string } | null;
  /**
   * The VAT treatment and rate this product's price was quoted under. Resolved
   * per product server-side, because a category can override the organisation
   * rate. Optional so a cached payload from before the field still renders.
   */
  tax?: TaxTreatment;
  images: ShopImage[];
  variants: ShopVariant[];
  price_min: string;
  price_max: string;
  in_stock: boolean;
  /** Deepest reduction across the variants, as a whole percentage. 0 = none. */
  drop_percent: number;
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

export type NavigationItemType =
  | "CATEGORY"
  | "LINK"
  | "PROMO"
  | "PAGE"
  | "GROUP"
  | "CATEGORY_LIST";
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
  /** Footer columns (`GROUP` nodes with their links); `/shop/site/` is the full footer. */
  footer: NavigationNode[];
}

/* ------------------------------------------------------------ footer ------ */

export interface SiteLink {
  label: string;
  url: string;
  /** Absolute http(s) — opens in a new tab. */
  external: boolean;
}

export interface SiteColumn {
  id: string;
  label: string;
  links: SiteLink[];
}

export interface SiteSocialLink {
  platform: string;
  label: string;
  url: string;
}

export interface OpeningHours {
  days: string;
  hours: string;
}

/**
 * `GET /shop/site/` — the whole footer, resolved server-side (ADR-0012).
 * Blank storefront contact fields have already fallen back to the
 * organisation's; the frontend never picks between the two.
 */
export interface SitePayload {
  brand: {
    name: string;
    tagline: string;
    /** "" when the shop has chosen not to show it. */
    address: string;
    phone: string;
    email: string;
    opening_hours: OpeningHours[];
  };
  map: { embed_url: string; link_url: string };
  social: SiteSocialLink[];
  columns: SiteColumn[];
  /** `copyright` may contain `{year}`, filled in at render time. */
  bottom: { copyright: string; note: string };
  /**
   * `null`: no WhatsApp link is set up, so the build-time number may be used.
   * Otherwise the shop's own choice, including an explicit "no button".
   */
  whatsapp: { number: string; show_float: boolean } | null;
}

/** `GET /shop/pages/<slug>/` — `body` is HTML the API has already sanitised. */
export interface SitePage {
  slug: string;
  title: string;
  meta_description: string;
  body: string;
  path: string;
  is_system: boolean;
  updated_at: string | null;
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
  /** The account the money went into; null for a payment not yet captured. */
  account: string | null;
  account_name: string;
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
  branch: string;
  branch_code: string;
  customer: string;
  customer_name: string;
  customer_phone: string;
  item_count: number;
  subtotal: string;
  discount_total: string;
  coupon_discount?: string;
  /** The code behind `coupon_discount`; only the staff detail payload has it. */
  coupon_code?: string;
  /** The cashier's discount on the whole sale (a POS sale's `discount_total` less the coupon). */
  manual_discount?: string;
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
  /** Only `GET /shop/orders/{number}/` fills this in — the admin order payload
   *  does not carry parcels, `/shipments/?order=` does. */
  shipments?: CustomerShipment[];
}

/**
 * An order as its customer sees it: `GET /shop/orders/{number}/`, the signed-in
 * account's orders and the checkout confirmation. Named field by field on the
 * server (`CustomerOrderSerializer`) — the staff `Order` carries who did what,
 * what they typed for each other and which drawer the money went into (D97).
 */
export type CustomerOrder = Pick<
  Order,
  | "number"
  | "channel"
  | "status"
  | "payment_status"
  | "currency"
  | "placed_at"
  | "delivered_at"
  | "cancel_reason"
  | "customer_name"
  | "subtotal"
  | "discount_total"
  | "coupon_discount"
  | "tax_total"
  | "shipping_total"
  | "grand_total"
  | "paid_total"
  | "refunded_total"
  | "shipping_address"
  | "customer_note"
  | "items"
  | "shipments"
> & {
  shipping_method_name: string;
  payments: Pick<Payment, "id" | "method" | "status" | "amount" | "captured_at" | "created_at">[];
  /** Written for the customer by the server; never the staff log's text. */
  events: { id: string; event_type: string; message: string; created_at: string }[];
};

export type ShipmentStatus =
  | "PENDING"
  | "DISPATCHED"
  | "IN_TRANSIT"
  | "DELIVERED"
  | "FAILED"
  | "RETURNED";

export interface ShipmentEvent {
  status: ShipmentStatus;
  message: string;
  location: string;
  occurred_at: string;
}

/** A parcel as the shop sees it. */
export interface Shipment {
  id: string;
  order: string;
  order_number: string;
  courier: string | null;
  courier_name: string;
  shipping_method: string | null;
  tracking_number: string;
  tracking_url: string;
  status: ShipmentStatus;
  cost: string;
  dispatched_at: string | null;
  delivered_at: string | null;
  notes: string;
  events: ShipmentEvent[];
  created_at: string;
}

/**
 * A parcel as the customer sees it: no `cost` and no `notes`.
 * The narrowing is the server's (`CustomerShipmentSerializer`), not this
 * type's — what we paid the courier is our margin, not the shopper's business.
 */
export interface CustomerShipment {
  id: string;
  courier_name: string;
  tracking_number: string;
  tracking_url: string;
  status: ShipmentStatus;
  dispatched_at: string | null;
  delivered_at: string | null;
  events: ShipmentEvent[];
}

export interface InventoryRow {
  id: string;
  branch: string;
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
  /** False when this branch has never received it: Adjust may lower, not raise. */
  received: boolean;
  updated_at: string;
}

/** `inventory.models.TransactionType`. */
export type StockMovementType =
  | "PURCHASE"
  | "SALE"
  | "RETURN"
  | "DAMAGE"
  | "LOSS"
  | "ADJUSTMENT"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "RESERVATION"
  | "RESERVATION_RELEASE"
  | "PURCHASE_RETURN";

/**
 * The document a ledger row was caused by, resolved by the API
 * (`inventory/api/documents.py`). A goods receipt or a supplier return resolves
 * to its purchase order, which is the screen that shows it.
 */
export interface LedgerDocument {
  kind: "order" | "return" | "purchase_order" | "stock_count" | "stock_transfer";
  id: string;
  label: string;
}

/** One row of `GET /inventory-transactions/` — append-only, newest first. */
export interface StockMovement {
  id: string;
  branch: string;
  branch_code: string;
  variant: string;
  variant_label: string;
  product: string;
  sku: string;
  product_name: string;
  transaction_type: StockMovementType;
  transaction_type_label: string;
  /** Signed: what this row did to on-hand, or to reserved for the reservation pair. */
  quantity: number;
  unit_cost: string | null;
  on_hand_after: number;
  reserved_after: number;
  reference_type: string;
  reference_id: string;
  document: LedgerDocument | null;
  reason: string;
  notes: string;
  created_by: string | null;
  created_by_email: string;
  created_at: string;
}

/** One row of `GET /audit-logs/`. Secrets are redacted before it is written. */
export interface AuditEntry {
  id: string;
  actor: string | null;
  actor_email: string;
  action: string;
  action_label: string;
  branch: string | null;
  branch_code: string | null;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  old_values: Record<string, unknown>;
  new_values: Record<string, unknown>;
  reason: string;
  ip_address: string | null;
  request_id: string;
  created_at: string;
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
  /**
   * Only for a reader with `reports.financial` -- the permission the business
   * summary needs for the same figures. Absent, not zero, for everyone else.
   */
  profit?: DashboardProfit;
}

/** The dashboard's slice of the business summary (business-rules § 4.1). */
export interface DashboardProfit {
  gross_profit: string;
  expenses: string;
  expense_count: number;
  /** The category most was spent on, or "" when nothing was. */
  top_expense_category: string;
  /** "Shipping / other cost" on purchase orders whose goods arrived in the period. */
  purchase_shipping: string;
  purchase_shipping_orders: number;
  net_profit: string;
  net_margin_percent: string;
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

/**
 * Something the cashier must resolve before taking payment, reported beside a
 * quote's figures rather than instead of them (`POST /pos/quote/`).
 */
export interface PosQuoteIssue {
  /** `COUPON_INVALID` or `PERMISSION_DENIED`. */
  code: string;
  /** Which of the register's discounts it is about. */
  field: "coupon" | "discount";
  message: string;
  details: {
    /** The coupon, as the server spells it. */
    code?: string;
    /** The coupon has a per-customer limit and the sale is anonymous. */
    needs_customer?: boolean;
    /** A manager holding this permission can approve the discount. */
    requires?: string;
    /** The cashier's discount in money, and as a share of the sale at full price. */
    discount?: string;
    discount_percent?: string;
    threshold?: string;
    approved_percent?: string;
  };
}

/** The register's basket, priced by the server exactly as the sale will record it. */
export interface PosQuote {
  lines: {
    variant: string;
    sku: string;
    quantity: number;
    unit_price: string;
    line_discount: string;
    line_total: string;
  }[];
  subtotal: string;
  coupon: { code: string; description: string } | null;
  coupon_discount: string;
  manual_discount: string;
  discount_total: string;
  tax_mode: "EXCLUSIVE" | "INCLUSIVE";
  tax_rate: string;
  tax_total: string;
  grand_total: string;
  item_count: number;
  issues: PosQuoteIssue[];
}

/** `POST /pos/elevate/`: a manager's approval, carried to the quote and the sale. */
export interface PosApproval {
  approved: boolean;
  approved_by: string;
  approved_by_id: string;
  permission: string;
  approval_token: string;
  /** Seconds the token is good for. */
  expires_in: number;
}

/**
 * A customer as the POS counter lookup returns them.
 *
 * Deliberately narrower than the admin `Customer`: a lookup answers up to ten
 * results for a partial phone number, most of whom are not the person at the
 * counter, so it carries no staff notes, tags, lifetime spend or addresses.
 * `total_orders` and `last_order_at` are there to tell two same-named people
 * apart, which is the only other question the counter asks.
 */
export interface PosCustomer {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  customer_type: string;
  total_orders: number;
  last_order_at: string | null;
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
  /**
   * Both name the API endpoint that serves the receipt to staff
   * (`/api/v1/expenses/{id}/attachment/`), never a `/media/` URL — which
   * refuses receipts (D91). Empty / null when there is no receipt. The browser
   * reaches it through `/api/proxy`, which carries the session.
   */
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

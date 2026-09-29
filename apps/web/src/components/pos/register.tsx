"use client";

import {
  Barcode,
  CircleAlert,
  Loader2,
  Minus,
  Pause,
  Play,
  Plus,
  Printer,
  Search,
  ShieldCheck,
  TicketPercent,
  Trash2,
  User,
  UserPlus,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { Logo } from "@/components/brand/logo";
import { CustomerPanel } from "@/components/pos/customer-panel";
import { DiscountPanel } from "@/components/pos/discount-panel";
import { PaymentPanel } from "@/components/pos/payment-panel";
import { Receipt } from "@/components/pos/receipt";
import { Badge, Button, Input } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { Order, PosQuoteIssue, PosSession, PosVariant } from "@/lib/api/types";
import { discountLabel, shownTotals } from "@/lib/commerce/pos-sale";
import { isBlankClick, redirectsToScan } from "@/lib/commerce/scan-focus";
import { money } from "@/lib/format";
import { useDebouncedCallback } from "@/lib/use-debounced-callback";
import { useDelayedFlag } from "@/lib/use-delayed-flag";
import { type PricedBasket, useSaleQuote } from "@/lib/use-sale-quote";
import { usePos } from "@/lib/store/pos";

/**
 * Delay before the scan field asks the server what it is looking at.
 *
 * This is the difference between a usable register and one that appears to
 * freeze. A keyboard-wedge scanner types a whole barcode in ~100 ms and then
 * presses Enter; searching on every keystroke turned one scan into 13 parallel
 * requests of ~700 ms each. Six of them saturated the browser's per-origin
 * connection pool, and the `lookup` fired by Enter — the only request that
 * mattered — queued behind them.
 *
 * 220 ms is below the threshold where a cashier typing a name notices a wait,
 * and above the interval a wedge scanner types at, so a scan now issues no
 * search at all.
 */
const SEARCH_DEBOUNCE_MS = 220;

/**
 * The register.
 *
 * Built barcode-first: the scan field holds focus at all times and a USB
 * scanner (which types then presses Enter) needs no mouse at all. When focus
 * has wandered -- a click on a quantity button, on the basket -- a character
 * typed anywhere but a field goes to the scan field, and so does a click on
 * nothing in particular (`lib/commerce/scan-focus`).
 *
 * Every figure in the totals is the server's (`useSaleQuote`): the browser
 * never adds up a sale, so a coupon, a percentage and VAT all read the same
 * here as on the receipt.
 *
 * Keyboard: F2 payment · F3 customer · F4 hold · F8 clear · F9 discount ·
 * Esc close dialog · any character outside a field goes to the scan field
 */
export function PosRegister({ session }: { session: PosSession }) {
  const pos = usePos();
  const sale = useSaleQuote();
  const scanRef = useRef<HTMLInputElement>(null);
  const [scan, setScan] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<PosVariant[]>([]);
  const [searching, setSearching] = useState(false);
  /** The basket being paid for, exactly as it was priced; null when not paying. */
  const [paying, setPaying] = useState<PricedBasket | null>(null);
  const [openingPayment, setOpeningPayment] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  /** Why payment closed on its own: the sale changed under it. */
  const [notice, setNotice] = useState<string | null>(null);
  const [completed, setCompleted] = useState<Order | null>(null);
  const [holds, setHolds] = useState(session.holds);
  const [announcement, setAnnouncement] = useState("");
  const searchAbort = useRef<AbortController | null>(null);
  const [debouncedSearch, cancelQueuedSearch] = useDebouncedCallback(
    (term: string) => void search(term),
    SEARCH_DEBOUNCE_MS,
  );

  const paymentOpen = paying !== null;
  // Two Radix dialogs at once fight over the focus trap, so a shortcut never
  // opens one on top of another.
  const dialogOpen = paymentOpen || customerOpen || discountOpen;

  // A failed answer is for this basket but carries the last good quote, which
  // is some other basket's: never shown as settled.
  const shown = shownTotals(pos, sale.quote, sale.current && !sale.error);
  // Said only when an answer is slow: a scan answered in 200 ms must not
  // flash "Updating…" at the counter every time. Not while an error stands,
  // which is not going to update by itself.
  const updating = useDelayedFlag(pos.lines.length > 0 && !shown.settled && !sale.error);
  const blockers: PosQuoteIssue[] =
    sale.current && !sale.error ? (sale.quote?.issues ?? []) : [];
  const blocked = blockers.length > 0 || Boolean(sale.error);

  // Deferred to the next task, so it lands after a closing dialog has gone.
  // Radix keeps focus trapped in a dialog until it unmounts: focusing the scan
  // field from a dialog's `onClose` was bounced back to the button that closed
  // it, which then left the page -- focus ended on <body>, and the next scan
  // typed into nothing. Esc never showed it, because this window listener runs
  // after Radix's own; a click on Close or Done always did.
  const focusScan = useCallback(() => {
    window.setTimeout(() => scanRef.current?.focus(), 0);
  }, []);

  function removeCoupon() {
    pos.setCoupon("");
    setAnnouncement("Coupon removed");
    focusScan();
  }

  function removeDiscount() {
    pos.setOrderDiscount(0);
    pos.setApproval(null);
    setAnnouncement("Discount removed");
    focusScan();
  }

  useEffect(() => {
    focusScan();
  }, [focusScan]);

  // Global shortcuts. Deliberately few and unambiguous — a cashier should not
  // have to remember a chord.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "F2") {
        event.preventDefault();
        if (!dialogOpen) void openPayment();
      } else if (event.key === "F3") {
        event.preventDefault();
        if (!dialogOpen) setCustomerOpen(true);
      } else if (event.key === "F4") {
        event.preventDefault();
        if (!dialogOpen) void hold();
      } else if (event.key === "F8") {
        event.preventDefault();
        if (!dialogOpen && pos.lines.length && confirm("Clear the current sale?")) pos.clear();
      } else if (event.key === "F9") {
        event.preventDefault();
        if (!dialogOpen && pos.lines.length) setDiscountOpen(true);
      } else if (event.key === "Escape") {
        setPaying(null);
        setCustomerOpen(false);
        setDiscountOpen(false);
        setCompleted(null);
        focusScan();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos.lines.length, dialogOpen]);

  // A scan that lands while focus is elsewhere. Without this the scanner typed
  // into nothing, or its Enter pressed the button that still had focus -- the
  // "+" on a basket line added one more of the last item -- and the cashier
  // had to click back into the field. The first character is written into
  // the field here and the rest of the burst follows it there, because focus
  // has moved before the scanner types the next one.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const input = scanRef.current;
      if (!input || dialogOpen || event.target === input) return;
      if (!redirectsToScan(event, event.target)) return;
      event.preventDefault();
      // A fresh entry: whatever was left in the field was the last attempt,
      // and a scan appended to it would never match.
      flushSync(() => {
        setScan(event.key);
        setScanError(null);
      });
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      queueSearch(input.value);
    }

    function onClick(event: MouseEvent) {
      if (dialogOpen || !isBlankClick(event.target, window.getSelection())) return;
      scanRef.current?.focus();
    }

    // Back from another window (the receipt printer's dialog, a spreadsheet)
    // with focus nowhere: the next thing through the door is a scan.
    function onWindowFocus() {
      if (dialogOpen) return;
      if (!document.activeElement || document.activeElement === document.body) focusScan();
    }

    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick);
      window.removeEventListener("focus", onWindowFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen, focusScan]);

  /**
   * Price the sale once more and open payment on that answer.
   *
   * Never on the answer already on screen: it may be for a basket from a
   * moment ago, and a prompt re-price is what makes the total the cashier
   * collects the total the server will record. When something stands in the
   * way -- a coupon that no longer applies, a discount waiting on a manager --
   * payment stays shut and the totals say what.
   */
  async function openPayment() {
    if (!pos.lines.length || openingPayment) return;
    setNotice(null);
    setOpeningPayment(true);
    try {
      const priced = await sale.refresh();
      if (priced && priced.quote.issues.length === 0) {
        setPaying(priced);
      } else if (priced) {
        setAnnouncement(priced.quote.issues[0].message);
      }
    } finally {
      setOpeningPayment(false);
    }
  }

  // The hook clears its own timer; the in-flight request is ours to drop.
  useEffect(() => () => searchAbort.current?.abort(), []);

  async function lookup(code: string) {
    const trimmed = code.trim();
    if (!trimmed) return;

    // The scan is the answer; a half-typed search for the same barcode is not.
    // Dropping it here frees the connection this lookup is about to need.
    cancelSearch();

    setScanning(true);
    setScanError(null);
    try {
      const variant = await apiClient<PosVariant & { label: string; stock?: { available: number } }>(
        `/pos/lookup/?code=${encodeURIComponent(trimmed)}`,
      );
      // The lookup endpoint returns the catalog serializer; normalise it.
      const normalised: PosVariant = {
        id: String(variant.id),
        sku: variant.sku,
        barcode: variant.barcode ?? "",
        name: (variant as unknown as { product_name?: string }).product_name ?? variant.name ?? "",
        label: variant.label ?? "",
        price: String(variant.price),
        available: variant.stock?.available ?? variant.available ?? 0,
        image: variant.image ?? "",
        category: variant.category ?? "",
      };

      if (normalised.available <= 0) {
        setScanError(`${normalised.sku} is out of stock.`);
        setAnnouncement(`${normalised.sku} is out of stock`);
      } else {
        pos.addVariant(normalised);
        setAnnouncement(`Added ${normalised.name} ${normalised.label}`);
      }
      setScan("");
      setResults([]);
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : "That code was not recognised.";
      setScanError(message);
      setAnnouncement(message);
    } finally {
      setScanning(false);
      focusScan();
    }
  }

  /** Drop any queued or in-flight search. Called before a scan is submitted. */
  function cancelSearch() {
    cancelQueuedSearch();
    searchAbort.current?.abort();
    searchAbort.current = null;
  }

  /** Wait for the typing to stop before asking the server. */
  function queueSearch(term: string) {
    if (term.trim().length < 2) {
      cancelSearch();
      setResults([]);
      setSearching(false);
      return;
    }
    debouncedSearch(term);
  }

  async function search(term: string) {
    // Supersede the previous search rather than racing it: responses can arrive
    // out of order, and the slower earlier one would otherwise overwrite the
    // results for what the cashier has actually typed.
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;

    setSearching(true);
    try {
      const data = await apiClient<{ results: PosVariant[] }>(
        `/pos/products/?q=${encodeURIComponent(term)}`,
        { signal: controller.signal },
      );
      setResults(data.results);
    } catch {
      if (controller.signal.aborted) return; // superseded — leave state alone
      setResults([]);
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  async function hold() {
    if (!pos.lines.length) return;
    try {
      const created = await apiClient<{ id: string; label: string; payload: unknown; created_at: string }>(
        "/pos/holds/",
        {
          method: "POST",
          body: {
            label: pos.customerName || new Date().toLocaleTimeString(),
            register: pos.register,
            customer: pos.customerId,
            // The manager's approval is deliberately not parked: it lasts five
            // minutes and belongs to this cashier. Resuming asks again if the
            // discount still needs it.
            payload: {
              lines: pos.lines,
              customerId: pos.customerId,
              customerName: pos.customerName,
              orderDiscount: pos.orderDiscount,
              orderDiscountMode: pos.orderDiscountMode,
              couponCode: pos.couponCode,
              note: pos.note,
            },
          },
        },
      );
      setHolds((current) => [created, ...current]);
      pos.clear();
      setAnnouncement("Sale held");
    } catch {
      setAnnouncement("Could not hold the sale");
    } finally {
      focusScan();
    }
  }

  async function resume(holdId: string) {
    try {
      const data = await apiClient<{ payload: unknown }>(`/pos/holds/${holdId}/resume/`, {
        method: "POST",
      });
      pos.restore(data.payload);
      setHolds((current) => current.filter((entry) => entry.id !== holdId));
      setAnnouncement("Held sale resumed");
    } finally {
      focusScan();
    }
  }

  if (completed) {
    return (
      <Receipt
        order={completed}
        session={session}
        onNewSale={() => {
          setCompleted(null);
          pos.clear();
          focusScan();
        }}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col">
      {/* Header: black bar, white wordmark. */}
      <header className="flex h-14 shrink-0 items-center gap-4 bg-neutral-950 px-4 text-white">
        <Logo variant="full-on-dark" height={24} />
        <span className="text-body-sm text-neutral-400">{session.branch.name}</span>
        <div className="ml-auto flex items-center gap-4 text-body-sm">
          <label className="flex items-center gap-2">
            <span className="text-neutral-400">Register</span>
            <select
              value={pos.register}
              onChange={(event) => pos.setRegister(event.target.value)}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-white"
            >
              {Array.from({ length: session.branch.register_count }, (_, index) => (
                <option key={index} value={`REG-${String(index + 1).padStart(2, "0")}`}>
                  REG-{String(index + 1).padStart(2, "0")}
                </option>
              ))}
            </select>
          </label>
          <span className="text-neutral-300">{session.cashier.name}</span>
        </div>
      </header>

      {/* Screen-reader announcements for scan outcomes. */}
      <p aria-live="assertive" className="sr-only">
        {announcement}
      </p>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_420px]">
        {/* --- left: scan + search ------------------------------------- */}
        <section aria-label="Product entry" className="flex min-h-0 flex-col border-r border-border p-4">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void lookup(scan);
            }}
          >
            <label htmlFor="scan" className="text-body-sm font-semibold">
              Scan barcode or type SKU
            </label>
            <div className="mt-1.5 flex gap-2">
              <div className="relative flex-1">
                <Barcode
                  className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-neutral-400"
                  aria-hidden
                />
                <Input
                  id="scan"
                  ref={scanRef}
                  inputSize="lg"
                  autoComplete="off"
                  value={scan}
                  onChange={(event) => {
                    setScan(event.target.value);
                    setScanError(null);
                    queueSearch(event.target.value);
                  }}
                  placeholder="Ready to scan…"
                  className="pl-10 text-body-lg"
                  invalid={Boolean(scanError)}
                  aria-describedby={scanError ? "scan-error" : undefined}
                />
              </div>
              <Button type="submit" size="xl" loading={scanning}>
                Add
              </Button>
            </div>
            {scanError && (
              <p id="scan-error" role="alert" className="mt-2 text-body-sm font-medium text-[var(--error)]">
                {scanError}
              </p>
            )}
          </form>

          <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
            {searching && (
              <p className="flex items-center gap-2 text-body-sm text-muted">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Searching…
              </p>
            )}

            {results.length > 0 ? (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {results.map((variant) => (
                  <li key={variant.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (variant.available > 0) {
                          pos.addVariant(variant);
                          setScan("");
                          setResults([]);
                          focusScan();
                        }
                      }}
                      disabled={variant.available <= 0}
                      className="flex h-full w-full flex-col rounded-lg border border-border bg-surface p-3 text-left transition-colors duration-fast hover:border-brand-500 disabled:opacity-50"
                    >
                      <span className="line-clamp-2 text-body-sm font-medium">{variant.name}</span>
                      <span className="text-caption text-muted">{variant.label}</span>
                      <span className="tabular mt-auto pt-2 text-body font-semibold">
                        {money(variant.price)}
                      </span>
                      <span
                        className={`text-caption ${
                          variant.available <= 0
                            ? "text-[var(--error)]"
                            : variant.available <= 5
                              ? "text-[var(--warning-text)]"
                              : "text-muted"
                        }`}
                      >
                        {variant.available} in stock
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              !searching &&
              scan.length < 2 && (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted">
                  <Search className="size-8" aria-hidden />
                  <p className="text-body-sm">Scan an item, or type at least 2 characters to search.</p>
                  <p className="text-caption">F2 payment · F4 hold · F8 clear · F9 discount</p>
                </div>
              )
            )}
          </div>

          {holds.length > 0 && (
            <div className="mt-3 shrink-0 border-t border-border pt-3">
              <h2 className="text-body-sm font-semibold">Held sales ({holds.length})</h2>
              <ul className="mt-2 flex flex-wrap gap-2">
                {holds.map((entry) => (
                  <li key={entry.id}>
                    <Button variant="secondary" size="sm" onClick={() => void resume(entry.id)}>
                      <Play aria-hidden /> {entry.label}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* --- right: cart --------------------------------------------- */}
        <section aria-label="Current sale" className="flex min-h-0 flex-col bg-surface">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-h4">Current sale</h2>
            <Badge tone="neutral">{pos.itemCount()} item(s)</Badge>
          </div>

          {/*
            Who this sale is for. Attaching a customer is optional -- an
            unnamed counter sale is filed against the branch's walk-in record
            by the server -- so this never blocks the sale, and the row states
            which of the two is in force rather than leaving it implied.
          */}
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            {pos.customerId ? (
              <>
                <User className="size-4 shrink-0 text-muted" aria-hidden />
                <button
                  type="button"
                  onClick={() => setCustomerOpen(true)}
                  className="min-w-0 flex-1 truncate text-left text-body-sm font-medium underline-offset-4 hover:underline"
                >
                  {pos.customerName}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => pos.setCustomer(null, "")}
                  aria-label={`Remove ${pos.customerName} from this sale`}
                >
                  <X aria-hidden /> Remove
                </Button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setCustomerOpen(true)}
                className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-body-sm text-muted transition-colors duration-fast hover:bg-neutral-100 hover:text-neutral-900"
              >
                <UserPlus className="size-4 shrink-0" aria-hidden />
                Walk-in customer — add one (F3)
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {pos.lines.length === 0 ? (
              <p className="px-4 py-10 text-center text-body-sm text-muted">
                No items yet. Scan to begin.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {pos.lines.map((line) => (
                  <li key={line.variantId} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-body-sm font-medium">{line.name}</p>
                        <p className="text-caption text-muted">
                          {line.label} · {line.sku}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => pos.removeLine(line.variantId)}
                        aria-label={`Remove ${line.name}`}
                        className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-[var(--error)]"
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </button>
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-2">
                      <div className="inline-flex items-center rounded-md border border-neutral-300">
                        <button
                          type="button"
                          onClick={() => pos.setQuantity(line.variantId, line.quantity - 1)}
                          className="grid size-9 place-items-center hover:bg-neutral-100"
                          aria-label={`Decrease ${line.name}`}
                        >
                          <Minus className="size-4" aria-hidden />
                        </button>
                        <input
                          type="number"
                          min={1}
                          value={line.quantity}
                          onChange={(event) =>
                            pos.setQuantity(line.variantId, Number(event.target.value) || 1)
                          }
                          aria-label={`Quantity of ${line.name}`}
                          className="tabular h-9 w-12 border-x border-neutral-300 text-center [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <button
                          type="button"
                          onClick={() => pos.setQuantity(line.variantId, line.quantity + 1)}
                          className="grid size-9 place-items-center hover:bg-neutral-100 disabled:opacity-40"
                          aria-label={`Increase ${line.name}`}
                          disabled={line.quantity >= line.available}
                        >
                          <Plus className="size-4" aria-hidden />
                        </button>
                      </div>

                      <span className="tabular text-body font-semibold">
                        {money(line.unitPrice * line.quantity - line.discount)}
                      </span>
                    </div>

                    {line.quantity > line.available && (
                      <p role="alert" className="mt-1 text-caption font-medium text-[var(--error)]">
                        Only {line.available} in stock
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="shrink-0 border-t border-border p-4">
            <dl className="space-y-1">
              <TotalsRow term="Subtotal" value={money(shown.subtotal)} />
              {shown.couponOff > 0 && (
                <TotalsRow
                  term={`Coupon ${shown.couponCode}`}
                  value={`− ${money(shown.couponOff)}`}
                  saving
                />
              )}
              {shown.manualOff > 0 && (
                <TotalsRow
                  term={discountLabel(pos.orderDiscountMode, pos.orderDiscount)}
                  value={`− ${money(shown.manualOff)}`}
                  saving
                />
              )}
              {shown.taxTotal > 0 && (
                <TotalsRow
                  term={shown.taxInclusive ? "Includes VAT" : "VAT"}
                  value={money(shown.taxTotal)}
                />
              )}
            </dl>
            <div className="mt-2 flex items-baseline justify-between border-t border-border pt-2">
              <span className="text-h4">Total</span>
              <span className="flex items-baseline gap-2">
                {updating && (
                  <span className="text-caption text-muted" role="status">
                    Updating…
                  </span>
                )}
                <span className="tabular font-display text-[2rem] font-bold leading-none">
                  {money(shown.total)}
                </span>
              </span>
            </div>

            {/* What stands between this sale and payment, with the way past it. */}
            <div aria-live="polite">
              {notice && (
                <SaleNotice tone="error" message={notice}>
                  <Button variant="secondary" size="sm" onClick={() => setNotice(null)}>
                    OK
                  </Button>
                </SaleNotice>
              )}
              {blockers.map((issue) => (
                <SaleNotice
                  key={`${issue.field}-${issue.code}`}
                  tone={issue.details.requires ? "warning" : "error"}
                  message={issue.message}
                >
                  {issue.field === "coupon" ? (
                    <>
                      {issue.details.needs_customer && (
                        <Button variant="secondary" size="sm" onClick={() => setCustomerOpen(true)}>
                          <UserPlus aria-hidden /> Attach customer (F3)
                        </Button>
                      )}
                      <Button variant="secondary" size="sm" onClick={removeCoupon}>
                        Remove coupon
                      </Button>
                    </>
                  ) : (
                    <>
                      {issue.details.requires && (
                        <Button variant="secondary" size="sm" onClick={() => setDiscountOpen(true)}>
                          <ShieldCheck aria-hidden /> Manager approval (F9)
                        </Button>
                      )}
                      <Button variant="secondary" size="sm" onClick={removeDiscount}>
                        Remove discount
                      </Button>
                    </>
                  )}
                </SaleNotice>
              ))}
              {sale.error && (
                <SaleNotice tone="error" message={sale.error.message}>
                  <Button variant="secondary" size="sm" onClick={() => void sale.refresh()}>
                    Try again
                  </Button>
                  {pos.orderDiscount > 0 && (
                    <Button variant="secondary" size="sm" onClick={removeDiscount}>
                      Remove discount
                    </Button>
                  )}
                </SaleNotice>
              )}
            </div>

            <Button
              variant="secondary"
              size="lg"
              full
              className="mt-4"
              onClick={() => setDiscountOpen(true)}
              disabled={!pos.lines.length}
            >
              <TicketPercent aria-hidden /> Discount or coupon (F9)
            </Button>

            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                size="lg"
                onClick={() => void hold()}
                disabled={!pos.lines.length}
              >
                <Pause aria-hidden /> Hold (F4)
              </Button>
              <Button
                variant="secondary"
                size="lg"
                onClick={() => pos.lines.length && confirm("Clear the current sale?") && pos.clear()}
                disabled={!pos.lines.length}
              >
                <X aria-hidden /> Clear (F8)
              </Button>
            </div>

            <Button
              size="xl"
              full
              className="mt-2"
              onClick={() => void openPayment()}
              loading={openingPayment}
              disabled={!pos.lines.length || blocked}
            >
              Payment (F2) · {money(shown.total)}
            </Button>
          </div>
        </section>
      </div>

      {customerOpen && (
        <CustomerPanel
          onClose={() => {
            setCustomerOpen(false);
            focusScan();
          }}
          onAttach={(customer) => {
            pos.setCustomer(customer.id, customer.name);
            setAnnouncement(`${customer.name} attached to this sale`);
          }}
        />
      )}

      {discountOpen && (
        <DiscountPanel
          session={session}
          quote={sale.quote}
          preview={sale.preview}
          onClose={() => {
            setDiscountOpen(false);
            focusScan();
          }}
          onAttachCustomer={() => {
            setDiscountOpen(false);
            setCustomerOpen(true);
          }}
        />
      )}

      {paying && (
        <PaymentPanel
          priced={paying}
          accounts={session.accounts ?? []}
          onClose={() => {
            setPaying(null);
            focusScan();
          }}
          onCompleted={(order) => {
            setPaying(null);
            setCompleted(order);
          }}
          onStale={(message) => {
            setPaying(null);
            setNotice(message);
            setAnnouncement(message);
            void sale.refresh();
            focusScan();
          }}
        />
      )}
    </div>
  );
}

/** One line of the totals. A saving is marked in words (the minus), never by colour alone. */
function TotalsRow({ term, value, saving }: { term: string; value: string; saving?: boolean }) {
  return (
    <div
      className={`flex items-baseline justify-between ${saving ? "text-[var(--success-text)]" : ""}`}
    >
      <dt className={`text-body-sm ${saving ? "" : "text-muted"}`}>{term}</dt>
      <dd className="tabular text-body">{value}</dd>
    </div>
  );
}

/** Why payment is shut, with what gets past it. */
function SaleNotice({
  tone,
  message,
  children,
}: {
  tone: "warning" | "error";
  message: string;
  children: React.ReactNode;
}) {
  const Icon = tone === "warning" ? ShieldCheck : CircleAlert;
  return (
    <div
      className={`mt-3 rounded-md p-3 text-body-sm ${
        tone === "warning"
          ? "bg-[var(--warning-bg)] text-[var(--warning-text)]"
          : "bg-[var(--error-bg)] text-[var(--error)]"
      }`}
    >
      <p className="flex items-start gap-2 font-medium">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        {message}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function PrintButton() {
  return (
    <Button variant="secondary" onClick={() => window.print()}>
      <Printer aria-hidden /> Print
    </Button>
  );
}

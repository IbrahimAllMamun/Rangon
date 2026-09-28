"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ShieldCheck, TicketPercent, UserPlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button, Field, Input, PasswordInput } from "@/components/ui/primitives";
import { ApiError, apiClient } from "@/lib/api/client";
import type { PosApproval, PosQuote, PosQuoteIssue, PosSession } from "@/lib/api/types";
import { type BasketState, approvalIssue, issueFor } from "@/lib/commerce/pos-sale";
import { money } from "@/lib/format";
import { type DiscountMode, usePos } from "@/lib/store/pos";

/** A discount waiting on a manager, and the refusal that asked for one. */
interface PendingApproval {
  value: number;
  mode: DiscountMode;
  /** As the server measured it: what the manager sees and signs for. */
  percent: string;
  /** The permission a manager's approval satisfies. */
  requires: string;
  message: string;
}

const MODES: { mode: DiscountMode; label: string }[] = [
  { mode: "AMOUNT", label: "৳ Amount" },
  { mode: "PERCENT", label: "% Percent" },
];

function holds(session: PosSession, code: string): boolean {
  const codes = session.cashier.permissions;
  return codes.includes("*") || codes.includes(code);
}

function failure(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.message : fallback;
}

/**
 * What the manager is being asked, in the server's figures.
 *
 * The threshold measures the cashier's discount against the whole sale, so a
 * percentage typed after a coupon reads lower here than at the till -- 30% of
 * what was left can be 28.41% of the sale. Saying both the money and what the
 * percentage is *of* is what keeps that from looking like a mistake.
 */
function approvalMessage(issue: PosQuoteIssue): string {
  const { discount, discount_percent: percent, threshold, approved_percent: approved } =
    issue.details;
  if (!discount || !percent || !threshold) return issue.message;
  const share = `${money(discount)} off is ${percent}% of the sale at full price.`;
  return approved
    ? `${share} The manager approved up to ${approved}%.`
    : `${share} A cashier can give up to ${threshold}% without a manager.`;
}

/**
 * Coupons and the whole-sale discount (F9).
 *
 * Nothing here decides a figure. Each change is tried against the server first
 * (`preview`) and committed to the sale only once the server has priced it
 * without complaint, so a refused coupon never reaches the register's total.
 *
 * A coupon is any the admin has defined for in-store use; it needs no
 * permission of the cashier's, because whoever made it authorised it. The
 * cashier's own discount is an amount or a percentage -- a percentage comes off
 * what is left after the coupon -- and above the threshold it waits here for a
 * manager to type their own email and password (business-rules §3.3). The
 * manager's password goes to `POST /pos/elevate/` and nowhere else; what the
 * sale carries is the short-lived approval that comes back.
 *
 * Keyboard: the coupon field has focus on open (the manager's email when a
 * discount is waiting on approval), Enter applies, Esc closes.
 */
export function DiscountPanel({
  session,
  quote,
  preview,
  onClose,
  onAttachCustomer,
}: {
  session: PosSession;
  /** The register's latest quote: what is applied, and whether it is waiting on a manager. */
  quote: PosQuote | null;
  preview: (changes: Partial<BasketState>) => Promise<PosQuote>;
  onClose: () => void;
  onAttachCustomer: () => void;
}) {
  const pos = usePos();
  const canDiscount = holds(session, "sales.discount");

  const [code, setCode] = useState(pos.couponCode);
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [needsCustomer, setNeedsCustomer] = useState(false);
  const [couponStatus, setCouponStatus] = useState("");

  const [mode, setMode] = useState<DiscountMode>(pos.orderDiscountMode);
  const [value, setValue] = useState(pos.orderDiscount > 0 ? String(pos.orderDiscount) : "");
  const [discountBusy, setDiscountBusy] = useState(false);
  const [discountError, setDiscountError] = useState<string | null>(null);
  const [discountStatus, setDiscountStatus] = useState("");

  // Opened from the register's "needs approval" notice, the approval is what
  // the cashier came for, so it is waiting rather than one more step away.
  const [approval, setApproval] = useState<PendingApproval | null>(() => {
    const issue = approvalIssue(quote);
    if (!issue || pos.orderDiscount <= 0) return null;
    return {
      value: pos.orderDiscount,
      mode: pos.orderDiscountMode,
      percent: issue.details.discount_percent ?? "",
      requires: issue.details.requires ?? "",
      message: approvalMessage(issue),
    };
  });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const couponRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  // The manager is who types next.
  useEffect(() => {
    if (approval) emailRef.current?.focus();
  }, [approval]);

  const appliedCoupon = quote?.coupon && quote.coupon.code === pos.couponCode ? quote : null;

  async function applyCoupon(event: React.FormEvent) {
    event.preventDefault();
    const typed = code.trim().toUpperCase();
    setCouponError(null);
    setNeedsCustomer(false);
    setCouponStatus("");
    if (!typed) {
      setCouponError("Type or scan the coupon code.");
      couponRef.current?.focus();
      return;
    }
    setCouponBusy(true);
    try {
      const priced = await preview({ couponCode: typed });
      const issue = issueFor(priced, "coupon");
      if (issue) {
        setCouponError(issue.message);
        setNeedsCustomer(Boolean(issue.details.needs_customer));
        return;
      }
      pos.setCoupon(typed);
      setCode(typed);
      setCouponStatus(
        `${priced.coupon?.code ?? typed} applied: ${money(priced.coupon_discount)} off.`,
      );
    } catch (caught) {
      setCouponError(failure(caught, "The coupon could not be checked. Try again."));
    } finally {
      setCouponBusy(false);
    }
  }

  function removeCoupon() {
    pos.setCoupon("");
    setCode("");
    setCouponError(null);
    setNeedsCustomer(false);
    setCouponStatus("Coupon removed.");
    couponRef.current?.focus();
  }

  function attachCustomerFirst() {
    // Kept on the sale: once the customer is attached the register prices it
    // again and the coupon applies, with nothing to retype.
    pos.setCoupon(code.trim().toUpperCase());
    onAttachCustomer();
  }

  async function applyDiscount(event: React.FormEvent) {
    event.preventDefault();
    setDiscountError(null);
    setDiscountStatus("");
    setApproval(null);
    setApprovalError(null);

    const amount = Number(value);
    if (!value.trim() || !Number.isFinite(amount) || amount < 0) {
      setDiscountError(mode === "PERCENT" ? "Enter a percentage." : "Enter an amount.");
      valueRef.current?.focus();
      return;
    }
    if (mode === "PERCENT" && amount > 100) {
      setDiscountError("A percentage cannot be more than 100.");
      valueRef.current?.focus();
      return;
    }
    if (amount === 0) {
      removeDiscount();
      return;
    }

    setDiscountBusy(true);
    try {
      // An approval already on the sale still counts if it covers this much.
      const priced = await preview({ orderDiscount: amount, orderDiscountMode: mode });
      const issue = issueFor(priced, "discount");
      if (issue?.details.requires) {
        setApproval({
          value: amount,
          mode,
          percent: issue.details.discount_percent ?? "",
          requires: issue.details.requires,
          message: approvalMessage(issue),
        });
        return;
      }
      if (issue) {
        setDiscountError(issue.message);
        return;
      }
      pos.setOrderDiscount(amount, mode);
      setDiscountStatus(`${money(priced.manual_discount)} off the sale.`);
    } catch (caught) {
      setDiscountError(failure(caught, "The discount could not be checked. Try again."));
    } finally {
      setDiscountBusy(false);
    }
  }

  function removeDiscount() {
    pos.setOrderDiscount(0);
    pos.setApproval(null);
    setValue("");
    setApproval(null);
    setDiscountError(null);
    setDiscountStatus("Discount removed.");
    valueRef.current?.focus();
  }

  async function approve(event: React.FormEvent) {
    event.preventDefault();
    if (!approval) return;
    setApprovalError(null);
    if (!email.trim() || !password) {
      setApprovalError("Enter the manager's email and password.");
      return;
    }

    setApproving(true);
    try {
      const granted = await apiClient<PosApproval>("/pos/elevate/", {
        method: "POST",
        body: {
          email: email.trim(),
          password,
          permission: approval.requires,
          discount_percent: approval.percent,
        },
      });
      const approved = {
        token: granted.approval_token,
        approvedBy: granted.approved_by,
        percent: approval.percent,
      };
      // Priced once more with the approval before it is committed, like any
      // other change here.
      const priced = await preview({
        orderDiscount: approval.value,
        orderDiscountMode: approval.mode,
        approval: approved,
      });
      const issue = issueFor(priced, "discount");
      if (issue) {
        setApprovalError(issue.message);
        return;
      }
      pos.setApproval(approved);
      pos.setOrderDiscount(approval.value, approval.mode);
      setMode(approval.mode);
      setValue(String(approval.value));
      setApproval(null);
      setEmail("");
      setDiscountStatus(
        `Approved by ${granted.approved_by}: ${money(priced.manual_discount)} off the sale.`,
      );
      valueRef.current?.focus();
    } catch (caught) {
      setApprovalError(failure(caught, "The approval could not be checked. Try again."));
    } finally {
      // Never left on a counter screen, whatever happened.
      setPassword("");
      setApproving(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-neutral-950/50" />
        <Dialog.Content
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (approval ? emailRef : couponRef).current?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-surface shadow-lg focus:outline-none"
        >
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <Dialog.Title className="text-h3">Discount</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close discount">
                <X aria-hidden />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">
            Apply a coupon code, or a discount on the whole sale as an amount or a percentage.
          </Dialog.Description>

          <div className="space-y-5 p-5">
            {/* --- coupon ------------------------------------------------ */}
            <section aria-labelledby="pos-coupon-heading">
              <h3 id="pos-coupon-heading" className="flex items-center gap-2 text-h4">
                <TicketPercent className="size-5 text-muted" aria-hidden /> Coupon
              </h3>
              <form onSubmit={applyCoupon} noValidate className="mt-2">
                <Field label="Coupon code" htmlFor="pos-coupon" error={couponError ?? undefined}>
                  <div className="flex gap-2">
                    <Input
                      id="pos-coupon"
                      ref={couponRef}
                      inputSize="lg"
                      value={code}
                      onChange={(event) => {
                        setCode(event.target.value.toUpperCase());
                        setCouponError(null);
                        setNeedsCustomer(false);
                      }}
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      maxLength={32}
                      invalid={Boolean(couponError)}
                      aria-describedby={couponError ? "pos-coupon-error" : undefined}
                      className="tabular uppercase"
                    />
                    <Button type="submit" size="lg" loading={couponBusy} className="shrink-0">
                      Apply
                    </Button>
                  </div>
                </Field>
              </form>

              {needsCustomer && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2"
                  onClick={attachCustomerFirst}
                >
                  <UserPlus aria-hidden /> Attach the customer (F3)
                </Button>
              )}

              {pos.couponCode && (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-neutral-100 px-3 py-2">
                  <p className="text-body-sm">
                    <span className="font-semibold">{pos.couponCode}</span> is on this sale
                    {appliedCoupon && (
                      <span className="tabular"> — {money(appliedCoupon.coupon_discount)} off</span>
                    )}
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={removeCoupon}
                    aria-label={`Remove coupon ${pos.couponCode}`}
                  >
                    Remove
                  </Button>
                </div>
              )}
              <p role="status" className="mt-1 text-body-sm text-[var(--success-text)]">
                {couponStatus}
              </p>
            </section>

            {/* --- the cashier's own discount ------------------------------ */}
            <section aria-labelledby="pos-discount-heading" className="border-t border-border pt-5">
              <h3 id="pos-discount-heading" className="text-h4">
                Discount on this sale
              </h3>

              {canDiscount ? (
                <>
                  <form onSubmit={applyDiscount} noValidate className="mt-2">
                    <div
                      role="group"
                      aria-label="Give the discount as"
                      className="grid grid-cols-2 gap-2"
                    >
                      {MODES.map((entry) => (
                        <button
                          key={entry.mode}
                          type="button"
                          aria-pressed={mode === entry.mode}
                          onClick={() => {
                            setMode(entry.mode);
                            setDiscountError(null);
                            setApproval(null);
                            valueRef.current?.focus();
                          }}
                          className={`h-11 rounded-md border-2 text-body-sm font-semibold transition-colors duration-fast focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--ring)] ${
                            mode === entry.mode
                              ? "border-brand-500 bg-brand-50 text-brand-700"
                              : "border-neutral-300 hover:bg-neutral-100"
                          }`}
                        >
                          {entry.label}
                        </button>
                      ))}
                    </div>

                    <Field
                      label={mode === "PERCENT" ? "Percentage off" : "Amount off (৳)"}
                      htmlFor="pos-discount"
                      hint="A large discount needs a manager's approval."
                      error={discountError ?? undefined}
                      className="mt-3"
                    >
                      <div className="flex gap-2">
                        <Input
                          id="pos-discount"
                          ref={valueRef}
                          inputSize="lg"
                          type="number"
                          inputMode="decimal"
                          min="0"
                          max={mode === "PERCENT" ? "100" : undefined}
                          step="0.01"
                          value={value}
                          onChange={(event) => {
                            setValue(event.target.value);
                            setDiscountError(null);
                          }}
                          invalid={Boolean(discountError)}
                          aria-describedby={
                            discountError ? "pos-discount-error" : "pos-discount-hint"
                          }
                          className="tabular"
                        />
                        <Button type="submit" size="lg" loading={discountBusy} className="shrink-0">
                          Apply
                        </Button>
                      </div>
                    </Field>
                  </form>

                  {pos.orderDiscount > 0 && !approval && (
                    <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-neutral-100 px-3 py-2">
                      <p className="text-body-sm">
                        <span className="font-semibold">
                          {pos.orderDiscountMode === "PERCENT"
                            ? `${pos.orderDiscount}%`
                            : money(pos.orderDiscount)}
                        </span>{" "}
                        off this sale
                        {pos.approval && (
                          <span className="text-muted"> · approved by {pos.approval.approvedBy}</span>
                        )}
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={removeDiscount}
                        aria-label="Remove the discount"
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                  <p role="status" className="mt-1 text-body-sm text-[var(--success-text)]">
                    {discountStatus}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-body-sm text-muted">
                  Your role cannot give a discount. A coupon still works.
                </p>
              )}

              {/* A sibling of the discount form, never inside it: a nested form
                  submits natively (D76). */}
              {approval && (
                <form
                  onSubmit={approve}
                  noValidate
                  aria-labelledby="pos-approval-heading"
                  className="mt-3 rounded-lg border border-[var(--warning)] bg-[var(--warning-bg)] p-4"
                >
                  <h4
                    id="pos-approval-heading"
                    className="flex items-center gap-2 text-body font-semibold text-[var(--warning-text)]"
                  >
                    <ShieldCheck className="size-5" aria-hidden /> Manager approval needed
                  </h4>
                  <p className="mt-1 text-body-sm text-neutral-800">{approval.message}</p>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Manager's email" htmlFor="pos-approver-email">
                      <Input
                        id="pos-approver-email"
                        ref={emailRef}
                        type="email"
                        autoComplete="username"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        aria-describedby={approvalError ? "pos-approval-error" : undefined}
                      />
                    </Field>
                    <Field label="Password" htmlFor="pos-approver-password">
                      <PasswordInput
                        id="pos-approver-password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        aria-describedby={approvalError ? "pos-approval-error" : undefined}
                      />
                    </Field>
                  </div>

                  {approvalError && (
                    <p
                      id="pos-approval-error"
                      role="alert"
                      className="mt-2 text-body-sm font-medium text-[var(--error)]"
                    >
                      {approvalError}
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="submit" loading={approving}>
                      <ShieldCheck aria-hidden /> Approve {approval.percent}%
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setApproval(null);
                        setApprovalError(null);
                        setPassword("");
                        valueRef.current?.focus();
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </section>
          </div>

          <div className="flex justify-end border-t border-border px-5 py-4">
            <Dialog.Close asChild>
              <Button variant="secondary" size="lg">
                Done
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

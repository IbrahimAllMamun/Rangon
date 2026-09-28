"use client";

import * as React from "react";

import { ApiError, apiClient } from "@/lib/api/client";
import type { PosQuote } from "@/lib/api/types";
import {
  type BasketRequest,
  type BasketState,
  basketKey,
  basketRequest,
} from "@/lib/commerce/pos-sale";
import { usePos } from "@/lib/store/pos";

/**
 * How long the basket must sit still before the server is asked to price it.
 *
 * A keyboard-wedge scanner delivers a whole barcode in ~100 ms and a scan is
 * one line change, so this costs one request per scan -- not one per
 * keystroke, which is the storm `SEARCH_DEBOUNCE_MS` in the register prevents.
 */
export const QUOTE_DEBOUNCE_MS = 150;

export interface QuoteError {
  code: string;
  message: string;
}

/** A priced basket, with the exact request that priced it. */
export interface PricedBasket {
  request: BasketRequest;
  quote: PosQuote;
}

interface QuoteResult {
  /** The basket this answer is for (`basketKey`). */
  key: string;
  quote: PosQuote | null;
  error: QuoteError | null;
}

const NOTHING: QuoteResult = { key: "", quote: null, error: null };

function quoteError(caught: unknown): QuoteError {
  if (caught instanceof ApiError) return { code: caught.code, message: caught.message };
  return {
    code: "NETWORK",
    message: "The total could not be worked out. Check the connection and try again.",
  };
}

function fetchQuote(request: BasketRequest, signal?: AbortSignal): Promise<PosQuote> {
  return apiClient<PosQuote>("/pos/quote/", { method: "POST", body: request, signal });
}

/**
 * The register's running total, priced by the server.
 *
 * The browser never adds a sale up: a coupon's scope and cap, a percentage off
 * what is left after it, and VAT are the server's to work out, so the screen
 * shows what `POST /pos/quote/` says (business-rules §3.1).
 *
 * Every answer is filed under the exact basket it priced. An answer for a
 * basket that has since changed stays on screen -- it is closer than nothing --
 * but `current` is false, and payment opens only from `refresh()`.
 */
export function useSaleQuote() {
  const lines = usePos((state) => state.lines);
  const customerId = usePos((state) => state.customerId);
  const orderDiscount = usePos((state) => state.orderDiscount);
  const orderDiscountMode = usePos((state) => state.orderDiscountMode);
  const couponCode = usePos((state) => state.couponCode);
  const approval = usePos((state) => state.approval);

  const key = basketKey(
    basketRequest({ lines, customerId, orderDiscount, orderDiscountMode, couponCode, approval }),
  );
  const [result, setResult] = React.useState<QuoteResult>(NOTHING);
  const refreshAbort = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    if (!key) {
      setResult(NOTHING);
      return;
    }
    // A change supersedes the request before it: the cleanup cancels the timer
    // and aborts the fetch, so an old basket's answer cannot land last.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchQuote(JSON.parse(key) as BasketRequest, controller.signal).then(
        (quote) => {
          if (!controller.signal.aborted) setResult({ key, quote, error: null });
        },
        (caught) => {
          if (controller.signal.aborted) return;
          setResult((previous) => ({ key, quote: previous.quote, error: quoteError(caught) }));
        },
      );
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  React.useEffect(() => () => refreshAbort.current?.abort(), []);

  /**
   * Price the basket now, skipping the wait. Payment opens from this, so the
   * total it collects is never an answer for an earlier basket.
   */
  const refresh = React.useCallback(async (): Promise<PricedBasket | null> => {
    const request = basketRequest(usePos.getState());
    if (!request) return null;
    refreshAbort.current?.abort();
    const controller = new AbortController();
    refreshAbort.current = controller;
    const requestKey = basketKey(request);
    try {
      const quote = await fetchQuote(request, controller.signal);
      setResult({ key: requestKey, quote, error: null });
      return { request, quote };
    } catch (caught) {
      if (!controller.signal.aborted) {
        setResult((previous) => ({
          key: requestKey,
          quote: previous.quote,
          error: quoteError(caught),
        }));
      }
      return null;
    }
  }, []);

  /**
   * Price the basket as it would be with `changes`, without making them.
   *
   * The discount dialog tries a coupon or a discount this way and commits it
   * only once the server has said yes, so a refused code never reaches the
   * register's totals. Throws `ApiError` for a basket that cannot be priced.
   */
  const preview = React.useCallback((changes: Partial<BasketState>): Promise<PosQuote> => {
    const request = basketRequest({ ...usePos.getState(), ...changes });
    if (!request) return Promise.reject(new Error("There is nothing in the sale to price."));
    return fetchQuote(request);
  }, []);

  const current = Boolean(key) && result.key === key;
  return {
    /** The latest answer, possibly for a basket that has since changed. */
    quote: key ? result.quote : null,
    /** True when `quote` (or `error`) is the answer for the basket on screen. */
    current,
    pending: Boolean(key) && !current,
    error: current ? result.error : null,
    refresh,
    preview,
  };
}

"use client";

import * as React from "react";

import { ApiError, apiClient } from "@/lib/api/client";
import type { CategoryAttributeRow } from "@/lib/commerce/category-attributes";

export interface CategoryAttributesState {
  /** `null` until an answer arrives, or while no category is chosen. */
  rows: CategoryAttributeRow[] | null;
  loading: boolean;
  failed: boolean;
  reload: () => void;
}

/**
 * What a category says its products are described by.
 *
 * A client fetch rather than server-rendered data because the category is a
 * control on the form: on the create page nothing has been saved yet, and on
 * either page changing the select has to change what is offered. One fetch
 * serves both halves of the form — the variant axes and the specifications —
 * so the two can never disagree about what the category declares, and the
 * screen makes one request instead of two.
 *
 * An in-flight request is aborted when the category changes again, so a slow
 * answer for the previous category cannot arrive last and win.
 */
export function useCategoryAttributes(categoryId: string): CategoryAttributesState {
  const [rows, setRows] = React.useState<CategoryAttributeRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (!categoryId) {
      setRows(null);
      setFailed(false);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setFailed(false);

    apiClient<CategoryAttributeRow[]>(`/categories/${categoryId}/attributes/`, {
      signal: controller.signal,
    })
      .then((answer) => {
        if (controller.signal.aborted) return;
        setRows(answer);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        // An abort is the next category, not a failure.
        if (controller.signal.aborted) return;
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setFailed(caught instanceof ApiError || caught instanceof Error);
        setLoading(false);
      });

    return () => controller.abort();
  }, [categoryId, attempt]);

  const reload = React.useCallback(() => setAttempt((n) => n + 1), []);

  return { rows, loading, failed, reload };
}

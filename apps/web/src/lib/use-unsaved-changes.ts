"use client";

import { useEffect } from "react";

/**
 * Ask before a reload, a closed tab or a typed URL throws away unsaved edits.
 *
 * Browsers show their own wording; the text cannot be customised. In-app
 * `<Link>` navigation is not covered -- the App Router has no hook for it --
 * which is why editors also show an "Unsaved changes" marker by the Save button.
 */
export function useUnsavedChangesWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Still required by Chromium-based browsers to show the prompt.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}

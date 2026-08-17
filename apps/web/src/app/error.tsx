"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaces in the browser console and, in production, in error tracking.
    console.error(error);
  }, [error]);

  return (
    <div className="container-rangon grid min-h-[60vh] place-items-center py-20 text-center">
      <div role="alert">
        <h1 className="text-h2">Something went wrong</h1>
        <p className="mt-2 text-body text-muted">
          The page could not be loaded. Nothing you were doing has been charged or changed.
        </p>
        {error.digest && (
          <p className="mt-2 text-caption text-muted">Reference: {error.digest}</p>
        )}
        <button
          type="button"
          onClick={reset}
          className="mt-6 rounded-md bg-brand-500 px-5 py-2.5 text-body-sm font-semibold text-white hover:bg-brand-600"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

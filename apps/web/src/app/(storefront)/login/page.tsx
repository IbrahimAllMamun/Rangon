import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginForm } from "@/components/auth/login-form";
import { Card, Skeleton } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <div className="container-rangon grid max-w-md place-items-center py-16">
      {/* A fallback, not a bare `<Suspense>`. `LoginForm` reads `?next=` through
          `useSearchParams`, which suspends; with no fallback the boundary
          renders nothing at all, so anything that stops the client taking over
          leaves a blank page rather than a degraded one. That is precisely how
          D74 presented — a white screen with no form and no way into /admin. */}
      <Suspense fallback={<LoginFormSkeleton />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}

function LoginFormSkeleton() {
  return (
    <Card className="w-full p-6 sm:p-8" aria-busy>
      <p className="text-center text-body-sm text-muted">Loading the sign-in form…</p>
      <div className="mt-6 space-y-4" aria-hidden>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
      {/* Reachable without JavaScript, so a blocked or failed bundle still
          leaves a way to report the problem rather than a dead end. */}
      <noscript>
        <p className="mt-6 text-center text-body-sm">
          Signing in needs JavaScript. If this message stays, the page&rsquo;s scripts were blocked.
        </p>
      </noscript>
    </Card>
  );
}

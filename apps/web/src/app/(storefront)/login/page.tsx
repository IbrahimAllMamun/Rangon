import type { Metadata } from "next";
import { Suspense } from "react";

import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <div className="container-rangon grid max-w-md place-items-center py-16">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}

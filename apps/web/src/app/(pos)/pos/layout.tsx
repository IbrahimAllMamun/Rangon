import { redirect } from "next/navigation";

import { currentUser, isAuthenticated } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = {
  title: "POS | Rangon Fashion",
  robots: { index: false, follow: false },
};

export default async function PosLayout({ children }: { children: React.ReactNode }) {
  if (!(await isAuthenticated())) redirect("/login?next=/pos");

  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/pos");

  const canSell = user.permissions.includes("*") || user.permissions.includes("sales.create");
  if (!canSell) {
    return (
      <div data-surface="pos" className="grid min-h-screen place-items-center bg-background p-6">
        <div role="alert" className="max-w-md rounded-lg border border-border bg-surface p-6 text-center">
          <h1 className="text-h3">No register access</h1>
          <p className="mt-2 text-body-sm text-muted">
            Your account ({user.role_name}) does not have permission to take sales. Ask a manager to
            grant <code>sales.create</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-surface="pos" className="min-h-screen bg-background">
      {children}
    </div>
  );
}

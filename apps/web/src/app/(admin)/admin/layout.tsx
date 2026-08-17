import { redirect } from "next/navigation";

import { AdminShell } from "@/components/admin/shell";
import { currentUser, isAuthenticated } from "@/lib/api/client";
import type { SessionUser } from "@/lib/api/types";

export const metadata = {
  title: { default: "Admin", template: "%s | Rangon Admin" },
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await isAuthenticated())) redirect("/login?next=/admin");

  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/admin");

  // Customers have no business in the back office; the API refuses them anyway,
  // this just avoids showing an empty shell.
  if (user.role === "CUSTOMER") redirect("/");

  return (
    <div data-surface="admin">
      <AdminShell user={user}>{children}</AdminShell>
    </div>
  );
}

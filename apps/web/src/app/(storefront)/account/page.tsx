import { Package, MapPin, Heart } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui/primitives";
import { currentUser, isAuthenticated } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata: Metadata = {
  title: "Your account",
  robots: { index: false, follow: false },
};

export default async function AccountPage() {
  if (!(await isAuthenticated())) redirect("/login?next=/account");

  const user = await currentUser<SessionUser>();
  if (!user) redirect("/login?next=/account");

  // Staff signing in land in the back office, not a customer account page.
  if (user.role !== "CUSTOMER") redirect(user.role === "CASHIER" ? "/pos" : "/admin");

  return (
    <div className="container-rangon max-w-3xl py-12">
      <h1 className="font-display text-h1">Your account</h1>
      <p className="mt-2 text-body text-muted">
        Signed in as {user.email}
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <AccountLink
          href="/account/orders"
          icon={<Package className="size-5" aria-hidden />}
          title="Orders"
          description="Track and review what you have bought"
        />
        <AccountLink
          href="/account/addresses"
          icon={<MapPin className="size-5" aria-hidden />}
          title="Addresses"
          description="Where we deliver to"
        />
        <AccountLink
          href="/wishlist"
          icon={<Heart className="size-5" aria-hidden />}
          title="Wishlist"
          description="Things you saved for later"
        />
      </div>
    </div>
  );
}

function AccountLink({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <Link href={href} className="rounded-lg focus-visible:ring-4 focus-visible:ring-[var(--ring)]">
      <Card className="h-full p-5 transition-colors duration-fast hover:border-brand-500">
        <span className="text-brand-500">{icon}</span>
        <h2 className="mt-3 text-h4">{title}</h2>
        <p className="mt-1 text-body-sm text-muted">{description}</p>
      </Card>
    </Link>
  );
}

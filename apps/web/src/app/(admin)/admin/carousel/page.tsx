import { ExternalLink } from "lucide-react";

import { CarouselManager, type CarouselRow } from "@/components/admin/carousel-manager";
import { PageHeader } from "@/components/admin/shell";
import { Button, Card, CardContent } from "@/components/ui/primitives";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "Homepage carousel" };

/**
 * Which products the homepage carousel shows, and in what order.
 *
 * Reading needs `settings.view`, as for the navbar; changing it needs
 * `content.navigation_manage`, the permission that already writes the
 * homepage hero -- the API enforces both (content.api.views).
 */
export default async function CarouselPage() {
  const [items, user] = await Promise.all([
    apiServer<CarouselRow[]>("/home-carousel/").catch(() => null),
    currentUser<SessionUser>(),
  ]);
  const permissions = user?.permissions ?? [];
  const canManage = permissions.includes("*") || permissions.includes("content.navigation_manage");

  const header = (
    <PageHeader
      title="Homepage carousel"
      description="The products in the row straight under the homepage hero, left to right in this order. Only published products appear there; the rest wait here until they are."
      actions={
        <Button variant="secondary" asChild>
          <a href="/" target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" aria-hidden />
            View the homepage
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </Button>
      }
    />
  );

  if (!items) {
    return (
      <>
        {header}
        <Card>
          <CardContent>
            <p role="alert" className="text-body-sm text-muted">
              You do not have permission to view the homepage carousel.
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      {header}
      <CarouselManager items={items} canManage={canManage} />
    </>
  );
}

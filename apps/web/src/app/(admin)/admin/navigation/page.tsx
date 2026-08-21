import { BannerEditor, type BannerRow } from "@/components/admin/banner-editor";
import { NavigationEditor, type NavigationItemRow } from "@/components/admin/navigation-editor";
import { PageHeader } from "@/components/admin/shell";
import { Card, CardContent } from "@/components/ui/primitives";
import { apiServer } from "@/lib/api/server";

export const metadata = { title: "Navigation" };

interface CategoryOption {
  id: string;
  name: string;
}

/**
 * Merchandiser control over the storefront navbar and its banners.
 *
 * The category tree already drives the navbar with zero configuration
 * (ADR-0009) — this page is for the exceptions: a filter, a campaign, a promo
 * card, the announcement bar. Every write here goes through the same
 * `content.navigation_manage` permission the API enforces, so a read-only user
 * sees the current state without controls that would fail on submit.
 */
export default async function NavigationPage() {
  const [items, banners, categories] = await Promise.all([
    apiServer<NavigationItemRow[]>("/navigation-items/").catch(() => null),
    apiServer<BannerRow[]>("/storefront-banners/").catch(() => null),
    apiServer<CategoryOption[]>("/categories/").catch(() => []),
  ]);

  if (!items || !banners) {
    return (
      <>
        <PageHeader title="Navigation" />
        <Card>
          <CardContent>
            <p role="alert" className="text-body-sm text-muted">
              You do not have permission to view navigation settings.
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Navigation"
        description="Overrides for the storefront navbar, plus the announcement bar and homepage hero. An empty navbar section means the category tree drives it — the documented default."
      />

      <div className="space-y-6">
        <NavigationEditor items={items} categories={categories} />

        <BannerEditor
          placement="ANNOUNCEMENT"
          title="Announcement bar"
          hint="The strip above the header. The highest-priority live one shows."
          banners={banners}
        />

        <BannerEditor
          placement="HOME_HERO"
          title="Homepage hero"
          hint="Replaces the default hero copy and image when one is live."
          banners={banners}
        />
      </div>
    </>
  );
}

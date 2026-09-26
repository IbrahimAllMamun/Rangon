import { ExternalLink } from "lucide-react";

import { FooterAdmin } from "@/components/admin/footer/footer-admin";
import {
  FOOTER_TABS,
  type FooterItemRow,
  type FooterTab,
  type SitePageRow,
  type SiteSettingsRow,
  type SocialLinkRow,
} from "@/components/admin/footer/types";
import { PageHeader } from "@/components/admin/shell";
import { Button, Card, CardContent } from "@/components/ui/primitives";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "Footer & pages" };

/**
 * The storefront footer, the shop's contact details and social profiles, and
 * the About / Contact / policy pages — everything below the fold of every
 * storefront page (ADR-0012).
 *
 * Reading needs `settings.view`. Writing is split the way the API splits it:
 * footer columns are navigation items (`content.navigation_manage`), and the
 * rest is `content.site_manage`. Owners and managers hold both.
 */
export default async function FooterSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const [settings, social, pages, footerItems, categories, user] = await Promise.all([
    apiServer<SiteSettingsRow>("/site-settings/").catch(() => null),
    apiServer<SocialLinkRow[]>("/social-links/").catch(() => null),
    apiServer<SitePageRow[]>("/site-pages/").catch(() => null),
    apiServer<FooterItemRow[]>("/navigation-items/?placement=FOOTER").catch(() => null),
    apiServer<{ id: string; name: string }[]>("/categories/").catch(() => []),
    currentUser<SessionUser>(),
  ]);

  const permissions = user?.permissions ?? [];
  const can = (code: string) => permissions.includes("*") || permissions.includes(code);

  if (!settings || !social || !pages || !footerItems) {
    return (
      <>
        <PageHeader title="Footer & pages" />
        <Card>
          <CardContent>
            <p role="alert" className="text-body-sm text-muted">
              You do not have permission to view the footer settings.
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  const initialTab = (FOOTER_TABS as readonly string[]).includes(tab ?? "")
    ? (tab as FooterTab)
    : "layout";

  return (
    <>
      <PageHeader
        title="Footer & pages"
        description="What every storefront page ends with: the address under the logo, how to reach the shop, its social profiles, the footer links, and the About, Contact and policy pages."
        actions={
          <Button asChild variant="secondary" size="sm">
            <a href="/" target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden /> View storefront
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </Button>
        }
      />
      <FooterAdmin
        initialTab={initialTab}
        settings={settings}
        social={social}
        pages={pages}
        footerItems={footerItems}
        categories={categories}
        canManageSite={can("content.site_manage")}
        canManageLinks={can("content.navigation_manage")}
      />
    </>
  );
}

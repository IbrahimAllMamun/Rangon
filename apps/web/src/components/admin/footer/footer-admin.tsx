"use client";

import { FileText, LayoutPanelTop, MapPin, Share2 } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { FooterBrandForm } from "@/components/admin/footer/brand-form";
import { FooterColumnsEditor } from "@/components/admin/footer/columns-editor";
import { ContactSettingsForm } from "@/components/admin/footer/contact-form";
import { SitePagesList } from "@/components/admin/footer/pages-list";
import { SocialLinksEditor } from "@/components/admin/footer/social-editor";
import type {
  FooterItemRow,
  FooterTab,
  SitePageRow,
  SiteSettingsRow,
  SocialLinkRow,
} from "@/components/admin/footer/types";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Admin → Footer & pages. Four tabs over one storefront surface.
 *
 * The selected tab is kept in `?tab=` so a link (or the page editor's "back")
 * lands on the right one, and a reload stays put. `replace`, not `push`:
 * switching tabs is not navigation the Back button should have to undo.
 *
 * Each tab saves on its own; nothing here is shared state, so an unsaved edit
 * in one tab survives a look at another (Radix keeps inactive panels mounted
 * only while `forceMount` is set, hence it is set).
 */
export function FooterAdmin({
  initialTab,
  settings,
  social,
  pages,
  footerItems,
  categories,
  canManageSite,
  canManageLinks,
}: {
  initialTab: FooterTab;
  settings: SiteSettingsRow;
  social: SocialLinkRow[];
  pages: SitePageRow[];
  footerItems: FooterItemRow[];
  categories: { id: string; name: string }[];
  canManageSite: boolean;
  canManageLinks: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState<FooterTab>(initialTab);

  function select(next: string) {
    setTab(next as FooterTab);
    router.replace(`${pathname}?tab=${next}`, { scroll: false });
  }

  return (
    <Tabs value={tab} onValueChange={select}>
      <TabsList aria-label="Footer settings">
        <TabsTrigger value="layout">
          <LayoutPanelTop aria-hidden /> Layout &amp; links
        </TabsTrigger>
        <TabsTrigger value="social">
          <Share2 aria-hidden /> Social media
        </TabsTrigger>
        <TabsTrigger value="contact">
          <MapPin aria-hidden /> Contact &amp; map
        </TabsTrigger>
        <TabsTrigger value="pages">
          <FileText aria-hidden /> Pages
        </TabsTrigger>
      </TabsList>

      <TabsContent value="layout" forceMount className="space-y-6 data-[state=inactive]:hidden">
        <FooterBrandForm settings={settings} canManage={canManageSite} />
        <FooterColumnsEditor
          items={footerItems}
          pages={pages}
          categories={categories}
          canManage={canManageLinks}
        />
      </TabsContent>

      <TabsContent value="social" forceMount className="data-[state=inactive]:hidden">
        <SocialLinksEditor links={social} canManage={canManageSite} />
      </TabsContent>

      <TabsContent value="contact" forceMount className="data-[state=inactive]:hidden">
        <ContactSettingsForm settings={settings} canManage={canManageSite} />
      </TabsContent>

      <TabsContent value="pages" forceMount className="data-[state=inactive]:hidden">
        <SitePagesList pages={pages} canManage={canManageSite} />
      </TabsContent>
    </Tabs>
  );
}

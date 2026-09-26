import { notFound } from "next/navigation";

import { SitePageEditor } from "@/components/admin/footer/page-editor";
import type { SitePageRow } from "@/components/admin/footer/types";
import { PageHeader } from "@/components/admin/shell";
import { ApiError } from "@/lib/api/client";
import { apiServer, currentUser } from "@/lib/api/server";
import type { SessionUser } from "@/lib/api/types";

export const metadata = { title: "Edit page" };

type Params = Promise<{ slug: string }>;

/** One site page in the rich-text editor (Admin → Footer & pages → Pages). */
export default async function EditSitePage({ params }: { params: Params }) {
  const { slug } = await params;
  const [page, user] = await Promise.all([
    apiServer<SitePageRow>(`/site-pages/${encodeURIComponent(slug)}/`).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }),
    currentUser<SessionUser>(),
  ]);
  if (!page) notFound();

  const permissions = user?.permissions ?? [];
  const canManage = permissions.includes("*") || permissions.includes("content.site_manage");

  return (
    <>
      <PageHeader
        title={page.title}
        description={`${page.is_system ? "Standard page" : "Page"} at ${page.path}`}
        back={{ href: "/admin/footer?tab=pages", label: "Footer & pages" }}
      />
      {/* Keyed by slug so moving between pages starts a fresh editor. */}
      <SitePageEditor key={page.slug} page={page} canManage={canManage} />
    </>
  );
}

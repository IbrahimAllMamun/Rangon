import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { categoryUrl, DiscoveryService } from '../catalog/discovery.service';
import { mediaUrl } from '../common/media';
import { pyIsoformat } from '../common/datetime';
import { parseQsl, pySplit, quotePlus } from '../common/python';
import { ENV, Env } from '../config/env';
import { Database } from '../database/database.service';

/**
 * `content.selectors` and the serialisers the storefront's content endpoints
 * use: navigation (ADR-0009), the footer, site pages and banners.
 */

/** The navbar goes root, child, grandchild (`NAVIGATION_MAX_DEPTH`). */
const NAVIGATION_MAX_DEPTH = 3;
/** A "Top categories" footer entry expands to at most this many. */
const FOOTER_CATEGORY_LIMIT = 8;
const CATEGORY_LIST_LABEL = 'Top categories (automatic)';
const DEFAULT_COPYRIGHT = '© {year} {name}. All rights reserved.';

const SYSTEM_PAGE_PATHS: Record<string, string> = {
  about: '/about',
  contact: '/contact',
  shipping: '/policies/shipping',
  returns: '/policies/returns',
  privacy: '/policies/privacy',
  terms: '/policies/terms',
};

const SOCIAL_LABELS: Record<string, string> = {
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
  WHATSAPP: 'WhatsApp',
  MESSENGER: 'Messenger',
  X: 'X (Twitter)',
  LINKEDIN: 'LinkedIn',
  PINTEREST: 'Pinterest',
  THREADS: 'Threads',
  TELEGRAM: 'Telegram',
};

export interface NavNode {
  id: string;
  label: string;
  url: string;
  type: string;
  badge: string;
  layout: string;
  description: string;
  image: string | null;
  children: NavNode[];
}

function node(fields: Partial<NavNode> & Pick<NavNode, 'id' | 'label' | 'url'>): NavNode {
  return {
    type: 'CATEGORY',
    badge: '',
    layout: 'AUTO',
    description: '',
    image: null,
    children: [],
    ...fields,
  };
}

interface NavigationRow {
  id: string;
  parent_id: string | null;
  type: string;
  label: string;
  url: string;
  badge: string;
  layout: string;
  description: string;
  image: string | null;
  category_id: string | null;
  category_name: string | null;
  category_active: boolean | null;
  page_id: string | null;
  page_title: string | null;
  page_slug: string | null;
  page_published: boolean | null;
}

/** Live rows (`ScheduledQuerySet.live`): active, and inside their window. */
function live(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  return `${a}is_active AND (${a}starts_at IS NULL OR ${a}starts_at <= now()) AND (${a}ends_at IS NULL OR ${a}ends_at >= now())`;
}

/** Python truthiness for a JSON value: None, empty containers, "", 0 and False are false. */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '')
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** `SitePage.path`. */
export function pagePath(slug: string): string {
  return SYSTEM_PAGE_PATHS[slug] ?? `/pages/${slug}`;
}

/** `content.validators.is_external`. */
export function isExternal(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/** `map_link_for_address`: a Google Maps search, or "" with no address. */
export function mapLinkForAddress(address: string): string {
  const query = pySplit(address ?? '').join(' ');
  if (!query) return '';
  return `https://www.google.com/maps/search/?api=1&query=${quotePlus(query)}`;
}

/** `urlsplit(url).hostname`, lower-cased, or "". */
function hostname(url: string): { host: string; path: string; query: string } {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(url ?? '');
  if (!match) return { host: '', path: '', query: '' };
  const netloc = (match[1] ?? '').split('@').pop() ?? '';
  const host = netloc.startsWith('[')
    ? netloc.slice(0, netloc.indexOf(']') + 1)
    : netloc.split(':')[0];
  return { host: (host ?? '').toLowerCase(), path: match[2] ?? '', query: match[3] ?? '' };
}

function hostMatches(host: string, allowed: string[]): boolean {
  const clean = host.toLowerCase().replace(/\.+$/, '');
  return allowed.some((domain) => clean === domain || clean.endsWith(`.${domain}`));
}

/** `whatsapp_number`: the number a chat link opens, or "". */
export function whatsappNumber(url: string): string {
  const { host, path, query } = hostname(url);
  let digits: string;
  if (host === 'wa.me') {
    digits = path.replace(/^\/+|\/+$/g, '');
  } else if (hostMatches(host, ['whatsapp.com'])) {
    // parse_qs without keep_blank_values: a blank `phone=` is no phone.
    const phone = parseQsl(query).find(([key, value]) => key === 'phone' && value !== '');
    digits = phone ? phone[1] : '';
  } else {
    return '';
  }
  return /^\d{8,15}$/.test(digits) ? digits : '';
}

@Injectable()
export class ContentService {
  constructor(
    private readonly db: Database,
    private readonly discovery: DiscoveryService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** `serialise_banner(StorefrontBanner.objects.live().filter(placement=...).first())`. */
  async liveBanner(placement: 'HOME_HERO' | 'ANNOUNCEMENT') {
    const banner = await this.db.one<{
      id: string;
      placement: string;
      message: string;
      title: string;
      subtitle: string;
      cta_label: string;
      url: string;
      image: string | null;
      dismissible: boolean;
    }>(
      `SELECT id, placement, message, title, subtitle, cta_label, url, image, dismissible
         FROM content_storefrontbanner WHERE ${live()} AND placement = $1
        ORDER BY priority DESC, created_at DESC LIMIT 1`,
      [placement],
    );
    if (!banner) return null;
    return {
      id: banner.id,
      placement: banner.placement,
      message: banner.message,
      title: banner.title,
      subtitle: banner.subtitle,
      cta_label: banner.cta_label,
      url: banner.url,
      image: mediaUrl(banner.image, this.env.MEDIA_URL) || null,
      dismissible: banner.dismissible,
    };
  }

  /** `navigation()`: live override rows for the placement, else the catalogue. */
  async navigation(placement: 'HEADER' | 'FOOTER'): Promise<NavNode[]> {
    const override = await this.overrideNavigation(placement);
    if (override.length) return override;
    return placement === 'HEADER' ? this.categoryNavigation() : [];
  }

  /** `serialise_node`. */
  serialiseNode(item: NavNode): Record<string, unknown> {
    return {
      id: item.id,
      label: item.label,
      url: item.url,
      type: item.type,
      badge: item.badge || null,
      layout: item.layout,
      description: item.description,
      image: mediaUrl(item.image, this.env.MEDIA_URL) || null,
      children: item.children.map((child) => this.serialiseNode(child)),
    };
  }

  private async categoryNavigation(): Promise<NavNode[]> {
    const roots = await this.db.query<{
      id: string;
      name: string;
      slug: string;
      description: string;
      image: string | null;
    }>(
      `SELECT id, name, slug, description, image FROM catalog_category
        WHERE parent_id IS NULL AND is_active AND show_in_navigation ORDER BY position ASC, name ASC`,
    );
    const nodes = roots.map((root) =>
      node({
        id: root.id,
        label: root.name,
        url: categoryUrl(root.slug),
        description: root.description,
        image: root.image || null,
      }),
    );
    await this.expand(
      new Map(
        roots.map((root, index) => [root.id, { node: nodes[index] as NavNode, path: root.slug }]),
      ),
      NAVIGATION_MAX_DEPTH - 1,
    );
    return nodes;
  }

  /** `_expand`: attach further levels of active children, one query per level. */
  private async expand(
    seeds: Map<string, { node: NavNode; path: string }>,
    depth: number,
  ): Promise<void> {
    let frontier = seeds;
    for (let level = 0; level < Math.max(depth, 0); level++) {
      if (!frontier.size) return;
      const children = await this.db.query<{
        id: string;
        parent_id: string;
        name: string;
        slug: string;
        description: string;
        image: string | null;
      }>(
        `SELECT id, parent_id, name, slug, description, image FROM catalog_category
          WHERE parent_id = ANY($1::uuid[]) AND is_active ORDER BY position ASC, name ASC`,
        [[...frontier.keys()]],
      );
      const next = new Map<string, { node: NavNode; path: string }>();
      for (const child of children) {
        const parent = frontier.get(child.parent_id);
        if (!parent) continue;
        const path = `${parent.path}/${child.slug}`;
        const childNode = node({
          id: child.id,
          label: child.name,
          url: categoryUrl(path),
          description: child.description,
          image: child.image || null,
        });
        parent.node.children.push(childNode);
        next.set(child.id, { node: childNode, path });
      }
      frontier = next;
    }
  }

  private async liveItems(placement: string): Promise<NavigationRow[]> {
    return this.db.query<NavigationRow>(
      `SELECT n.id, n.parent_id, n.type, n.label, n.url, n.badge, n.layout, n.description, n.image,
              n.category_id, c.name AS category_name, c.is_active AS category_active,
              n.page_id, p.title AS page_title, p.slug AS page_slug, p.is_published AS page_published
         FROM content_navigationitem n
         LEFT OUTER JOIN catalog_category c ON n.category_id = c.id
         LEFT OUTER JOIN content_sitepage p ON n.page_id = p.id
        WHERE ${live('n')} AND n.placement = $1
        ORDER BY n.position ASC, n.label ASC`,
      [placement],
    );
  }

  /** `NavigationItem.display_label`. */
  private displayLabel(item: NavigationRow): string {
    if (item.label) return item.label;
    if (item.category_id) return item.category_name ?? '';
    if (item.page_id) return item.page_title ?? '';
    if (item.type === 'CATEGORY_LIST') return CATEGORY_LIST_LABEL;
    return '';
  }

  private async overrideNavigation(placement: string): Promise<NavNode[]> {
    const items = await this.liveItems(placement);
    if (!items.length) return [];

    const byId = new Map<string, NavNode>();
    for (const item of items) {
      let url = item.url;
      if (item.type === 'CATEGORY' && item.category_id) {
        url = categoryUrl(await this.discovery.categoryPath(item.category_id));
      }
      byId.set(
        item.id,
        node({
          id: item.id,
          label: this.displayLabel(item),
          url,
          type: item.type,
          badge: item.badge,
          layout: item.layout,
          description: item.description,
          image: item.image || null,
        }),
      );
    }

    const roots: NavNode[] = [];
    for (const item of items) {
      const parent = item.parent_id ? byId.get(item.parent_id) : undefined;
      if (parent) parent.children.push(byId.get(item.id) as NavNode);
      else if (item.parent_id === null) roots.push(byId.get(item.id) as NavNode);
      // A child whose parent is not live is hidden with it, deliberately.
    }

    // A CATEGORY override with no hand-built children inherits the real ones.
    const inherit = new Map<string, { node: NavNode; path: string }>();
    for (const item of items) {
      const own = byId.get(item.id) as NavNode;
      if (item.type === 'CATEGORY' && item.category_id && !own.children.length) {
        inherit.set(item.category_id, {
          node: own,
          path: await this.discovery.categoryPath(item.category_id),
        });
      }
    }
    await this.expand(inherit, NAVIGATION_MAX_DEPTH - 1);
    return roots;
  }

  /** `footer_columns`: live GROUP rows with their live links; empty columns left out. */
  async footerColumns(): Promise<NavNode[]> {
    const items = await this.liveItems('FOOTER');
    const topCategories = items.some((item) => item.type === 'CATEGORY_LIST')
      ? (
          await this.db.query<{ id: string; name: string; slug: string }>(
            `SELECT id, name, slug FROM catalog_category
              WHERE parent_id IS NULL AND is_active AND show_in_navigation
              ORDER BY position ASC, name ASC LIMIT ${FOOTER_CATEGORY_LIMIT}`,
          )
        ).map((root) => node({ id: root.id, label: root.name, url: categoryUrl(root.slug) }))
      : [];

    const children = new Map<string, NavigationRow[]>();
    for (const item of items) {
      if (item.parent_id !== null) {
        const list = children.get(item.parent_id) ?? [];
        list.push(item);
        children.set(item.parent_id, list);
      }
    }

    const columns: NavNode[] = [];
    for (const item of items) {
      if (item.parent_id !== null || item.type !== 'GROUP') continue;
      const links: NavNode[] = [];
      for (const child of children.get(item.id) ?? [])
        links.push(...(await this.footerLinks(child, topCategories)));
      if (links.length) {
        columns.push(
          node({ id: item.id, label: item.label, url: '', type: 'GROUP', children: links }),
        );
      }
    }
    return columns;
  }

  /** `_footer_links`: zero, one or (for a category list) several links. */
  private async footerLinks(item: NavigationRow, topCategories: NavNode[]): Promise<NavNode[]> {
    let url: string;
    if (item.type === 'CATEGORY_LIST') return topCategories;
    if (item.type === 'CATEGORY') {
      if (!item.category_id || !item.category_active) return [];
      url = categoryUrl(await this.discovery.categoryPath(item.category_id));
    } else if (item.type === 'PAGE') {
      // An unpublished page 404s, so a link to it would too.
      if (!item.page_id || !item.page_published) return [];
      url = pagePath(item.page_slug ?? '');
    } else if ((item.type === 'LINK' || item.type === 'PROMO') && item.url) {
      url = item.url;
    } else {
      return [];
    }
    return [node({ id: item.id, label: this.displayLabel(item), url, type: item.type })];
  }

  /** `site_settings()`: the one row, created on first read if a migration never made it. */
  async siteSettings() {
    const select = `SELECT tagline, address, phone, email, opening_hours, show_address, map_embed_url,
                           map_link_url, copyright_text, bottom_note, whatsapp_float
                      FROM content_sitesettings WHERE key = 'default'`;
    type Row = {
      tagline: string;
      address: string;
      phone: string;
      email: string;
      opening_hours: unknown;
      show_address: boolean;
      map_embed_url: string;
      map_link_url: string;
      copyright_text: string;
      bottom_note: string;
      whatsapp_float: boolean;
    };
    const existing = await this.db.one<Row>(select);
    if (existing) return existing;
    // get_or_create, race-safe: two first readers insert once between them.
    await this.db.query(
      `INSERT INTO content_sitesettings
              (id, created_at, updated_at, key, tagline, address, phone, email, opening_hours,
               show_address, map_embed_url, map_link_url, copyright_text, bottom_note, whatsapp_float)
       SELECT $1::uuid, now(), now(), 'default', '', '', '', '', '[]'::jsonb, true, '', '', '', '', true
       ON CONFLICT (key) DO NOTHING`,
      [randomUUID()],
    );
    return (await this.db.one<Row>(select)) as Row;
  }

  /** `serialise_site`: the footer's brand block, social links and columns. */
  async site() {
    const settings = await this.siteSettings();
    const organization = await this.db.one<{
      name: string;
      address: string;
      phone: string;
      email: string;
    }>(
      `SELECT name, address, phone, email FROM accounts_organization WHERE status = 'ACTIVE'
        ORDER BY created_at ASC LIMIT 1`,
    );
    const social = await this.db.query<{ platform: string; url: string }>(
      `SELECT platform, url FROM content_sociallink WHERE is_visible AND NOT (url = '')
        ORDER BY position ASC, platform ASC`,
    );
    const columns = await this.footerColumns();

    const fallback = organization ?? { name: '', address: '', phone: '', email: '' };
    const name = fallback.name || 'Rangon Fashion';
    const address = settings.address || fallback.address;
    const whatsapp =
      social
        .filter((link) => link.platform === 'WHATSAPP')
        .map((link) => whatsappNumber(link.url))
        .find(Boolean) ?? '';

    return {
      brand: {
        name,
        tagline: settings.tagline,
        address: settings.show_address ? address : '',
        phone: settings.phone || fallback.phone,
        email: settings.email || fallback.email,
        opening_hours: pyTruthy(settings.opening_hours) ? settings.opening_hours : [],
      },
      map: {
        embed_url: settings.map_embed_url,
        link_url: settings.map_link_url || mapLinkForAddress(address),
      },
      social: social.map((link) => ({
        platform: link.platform,
        label: SOCIAL_LABELS[link.platform] ?? link.platform,
        url: link.url,
      })),
      columns: columns.map((column) => ({
        id: column.id,
        label: column.label,
        links: column.children.map((link) => ({
          label: link.label,
          url: link.url,
          external: isExternal(link.url),
        })),
      })),
      bottom: {
        copyright: settings.copyright_text || DEFAULT_COPYRIGHT.replace('{name}', name),
        note: settings.bottom_note,
      },
      // null: no WhatsApp link at all, so the storefront may use its build-time
      // number; a link with the float off is an explicit "no button".
      whatsapp: whatsapp ? { number: whatsapp, show_float: settings.whatsapp_float } : null,
    };
  }

  /** `published_pages()`: for the sitemap. */
  async publishedPages() {
    const pages = await this.db.query<{ slug: string; updated_at: string }>(
      `SELECT slug, updated_at FROM content_sitepage WHERE is_published ORDER BY is_system DESC, title ASC`,
    );
    return pages.map((page) => ({
      slug: page.slug,
      path: pagePath(page.slug),
      updated_at: pyIsoformat(page.updated_at),
    }));
  }

  /** `serialise_page(published_page(slug))`, or null. */
  async publishedPage(slug: string) {
    const page = await this.db.one<{
      slug: string;
      title: string;
      meta_description: string;
      body: string;
      is_system: boolean;
      updated_at: string | null;
    }>(
      `SELECT slug, title, meta_description, body, is_system, updated_at FROM content_sitepage
        WHERE slug = $1 AND is_published ORDER BY is_system DESC, title ASC LIMIT 1`,
      [slug],
    );
    if (!page) return null;
    return {
      slug: page.slug,
      title: page.title,
      meta_description: page.meta_description,
      body: page.body,
      path: pagePath(page.slug),
      is_system: page.is_system,
      updated_at: pyIsoformat(page.updated_at),
    };
  }
}

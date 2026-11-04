import { randomBytes } from 'node:crypto';
import type { DbPool } from '../../../platform/db/src/pool.js';
import { withTenant } from '../../../platform/db/src/index.js';
import { writeAudit } from '../../../platform/audit/src/index.js';
import { notFound, validationError, conflict } from '../../../platform/http/src/errors.js';

export interface WebsiteTemplateRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  sort_order: number;
  is_active: boolean;
}

export interface WebsiteSiteRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  name: string;
  template_id: string;
  status: string;
  published_at: Date | null;
  custom_domain_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WebsitePageRow {
  id: string;
  tenant_id: string;
  website_site_id: string;
  slug: string;
  title: string;
  body_markdown: string;
  status: string;
  published_at: Date | null;
  published_body_markdown: string | null;
  version_number: number;
  created_at: Date;
  updated_at: Date;
}

export async function listWebsiteTemplates(pool: DbPool): Promise<WebsiteTemplateRow[]> {
  const client = await pool.connect();
  try {
    const result = await client.query<WebsiteTemplateRow>(
      `SELECT id, slug, name, description, sort_order, is_active
       FROM website_templates
       WHERE is_active = true
       ORDER BY sort_order ASC`,
    );
    return result.rows;
  } finally {
    client.release();
  }
}

export async function createWebsiteSite(
  input: {
    tenantId: string;
    actorUserId: string;
    name: string;
    templateId: string;
    siteId?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<WebsiteSiteRow> {
  return withTenant(input.tenantId, async (db) => {
    if (!input.name.trim()) throw validationError('name required');
    const template = await db.query(`SELECT id FROM website_templates WHERE id = $1 AND is_active`, [
      input.templateId,
    ]);
    // website_templates is global; RLS may hide it inside tenant tx — query via SET LOCAL off is not needed
    // because daypi_app has SELECT and table has no RLS. Still works under tenant context.
    if (template.rowCount === 0) {
      // Fallback: templates table has no RLS; empty means missing id
      const check = await db.query(`SELECT id FROM website_templates WHERE id = $1`, [
        input.templateId,
      ]);
      if (check.rowCount === 0) throw notFound('Website template not found');
    }

    const row = await db.query<WebsiteSiteRow>(
      `INSERT INTO website_sites (
         tenant_id, site_id, name, template_id, status, created_by_user_id
       ) VALUES ($1,$2,$3,$4,'draft',$5)
       RETURNING id, tenant_id, site_id, name, template_id, status, published_at,
                 custom_domain_id, created_at, updated_at`,
      [
        input.tenantId,
        input.siteId ?? null,
        input.name.trim(),
        input.templateId,
        input.actorUserId,
      ],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'websites.site.create',
      entityType: 'website_site',
      entityId: row.rows[0]!.id,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function listWebsiteSites(
  tenantId: string,
  limit: number,
  pool: DbPool,
): Promise<WebsiteSiteRow[]> {
  return withTenant(tenantId, async (db) => {
    const result = await db.query<WebsiteSiteRow>(
      `SELECT id, tenant_id, site_id, name, template_id, status, published_at,
              custom_domain_id, created_at, updated_at
       FROM website_sites
       ORDER BY created_at DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)],
    );
    return result.rows;
  }, pool);
}

export async function createWebsitePage(
  input: {
    tenantId: string;
    actorUserId: string;
    websiteSiteId: string;
    slug: string;
    title: string;
    bodyMarkdown?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<WebsitePageRow> {
  return withTenant(input.tenantId, async (db) => {
    const slug = input.slug.trim().toLowerCase();
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      throw validationError('slug must be lowercase alphanumeric with hyphens');
    }
    if (!input.title.trim()) throw validationError('title required');

    const site = await db.query(`SELECT id FROM website_sites WHERE id = $1`, [
      input.websiteSiteId,
    ]);
    if (site.rowCount === 0) throw notFound('Website site not found');

    try {
      const row = await db.query<WebsitePageRow>(
        `INSERT INTO website_pages (
           tenant_id, website_site_id, slug, title, body_markdown,
           status, created_by_user_id, updated_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,'draft',$6,$6)
         RETURNING id, tenant_id, website_site_id, slug, title, body_markdown, status,
                   published_at, published_body_markdown, version_number, created_at, updated_at`,
        [
          input.tenantId,
          input.websiteSiteId,
          slug,
          input.title.trim(),
          input.bodyMarkdown ?? '',
          input.actorUserId,
        ],
      );

      await writeAudit(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'websites.page.create',
        entityType: 'website_page',
        entityId: row.rows[0]!.id,
        correlationId: input.correlationId,
      });

      return row.rows[0]!;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('Page slug already exists on this website');
      }
      throw err;
    }
  }, pool);
}

export async function updateWebsitePageDraft(
  input: {
    tenantId: string;
    actorUserId: string;
    pageId: string;
    title?: string;
    bodyMarkdown?: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<WebsitePageRow> {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query<WebsitePageRow>(
      `SELECT id, tenant_id, website_site_id, slug, title, body_markdown, status,
              published_at, published_body_markdown, version_number, created_at, updated_at
       FROM website_pages WHERE id = $1 FOR UPDATE`,
      [input.pageId],
    );
    if (existing.rowCount === 0) throw notFound('Website page not found');

    const row = await db.query<WebsitePageRow>(
      `UPDATE website_pages
       SET title = COALESCE($2, title),
           body_markdown = COALESCE($3, body_markdown),
           status = CASE WHEN status = 'published' THEN 'draft' ELSE status END,
           version_number = version_number + 1,
           updated_by_user_id = $4,
           updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, website_site_id, slug, title, body_markdown, status,
                 published_at, published_body_markdown, version_number, created_at, updated_at`,
      [input.pageId, input.title?.trim() ?? null, input.bodyMarkdown ?? null, input.actorUserId],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'websites.page.update_draft',
      entityType: 'website_page',
      entityId: input.pageId,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function publishWebsitePage(
  input: {
    tenantId: string;
    actorUserId: string;
    pageId: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<WebsitePageRow> {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query(`SELECT id, body_markdown FROM website_pages WHERE id = $1 FOR UPDATE`, [
      input.pageId,
    ]);
    if (existing.rowCount === 0) throw notFound('Website page not found');

    const row = await db.query<WebsitePageRow>(
      `UPDATE website_pages
       SET status = 'published',
           published_at = now(),
           published_body_markdown = body_markdown,
           updated_by_user_id = $2,
           updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, website_site_id, slug, title, body_markdown, status,
                 published_at, published_body_markdown, version_number, created_at, updated_at`,
      [input.pageId, input.actorUserId],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'websites.page.publish',
      entityType: 'website_page',
      entityId: input.pageId,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function publishWebsiteSite(
  input: {
    tenantId: string;
    actorUserId: string;
    websiteSiteId: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<WebsiteSiteRow> {
  return withTenant(input.tenantId, async (db) => {
    const site = await db.query(`SELECT id FROM website_sites WHERE id = $1 FOR UPDATE`, [
      input.websiteSiteId,
    ]);
    if (site.rowCount === 0) throw notFound('Website site not found');

    const row = await db.query<WebsiteSiteRow>(
      `UPDATE website_sites
       SET status = 'published', published_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING id, tenant_id, site_id, name, template_id, status, published_at,
                 custom_domain_id, created_at, updated_at`,
      [input.websiteSiteId],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'websites.site.publish',
      entityType: 'website_site',
      entityId: input.websiteSiteId,
      correlationId: input.correlationId,
    });

    return row.rows[0]!;
  }, pool);
}

export async function requestCustomDomainVerification(
  input: {
    tenantId: string;
    actorUserId: string;
    websiteSiteId: string;
    hostname: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{
  id: string;
  hostname: string;
  verification_token: string;
  status: string;
}> {
  return withTenant(input.tenantId, async (db) => {
    const hostname = input.hostname.trim().toLowerCase();
    if (!hostname || hostname.includes('/') || hostname.includes(' ')) {
      throw validationError('hostname must be a bare domain');
    }
    const site = await db.query(`SELECT id FROM website_sites WHERE id = $1`, [
      input.websiteSiteId,
    ]);
    if (site.rowCount === 0) throw notFound('Website site not found');

    const token = `daypi-verify-${randomBytes(16).toString('hex')}`;
    try {
      const row = await db.query<{
        id: string;
        hostname: string;
        verification_token: string;
        status: string;
      }>(
        `INSERT INTO website_domain_verifications (
           tenant_id, website_site_id, hostname, verification_token,
           status, created_by_user_id
         ) VALUES ($1,$2,$3,$4,'pending',$5)
         RETURNING id, hostname, verification_token, status`,
        [input.tenantId, input.websiteSiteId, hostname, token, input.actorUserId],
      );

      await writeAudit(db, {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        action: 'websites.domain.request',
        entityType: 'website_domain_verification',
        entityId: row.rows[0]!.id,
        correlationId: input.correlationId,
        metadata: { hostname },
      });

      return row.rows[0]!;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('Hostname already registered for this tenant');
      }
      throw err;
    }
  }, pool);
}

/** Sandbox stub: marks verification without real DNS/Hostinger provisioning. */
export async function completeCustomDomainVerificationStub(
  input: {
    tenantId: string;
    actorUserId: string;
    verificationId: string;
    correlationId?: string;
  },
  pool: DbPool,
): Promise<{ verification_status: string; verified_domain_id: string }> {
  return withTenant(input.tenantId, async (db) => {
    const existing = await db.query<{
      id: string;
      hostname: string;
      website_site_id: string;
      status: string;
    }>(
      `SELECT id, hostname, website_site_id, status
       FROM website_domain_verifications WHERE id = $1 FOR UPDATE`,
      [input.verificationId],
    );
    if (existing.rowCount === 0) throw notFound('Domain verification not found');
    if (existing.rows[0]!.status === 'verified_stub') {
      throw conflict('Already verified (stub)');
    }

    const domain = await db.query<{ id: string }>(
      `INSERT INTO verified_domains (
         tenant_id, hostname, purpose, verification_status, verified_at, certificate_state
       ) VALUES ($1,$2,'public_site','verified',now(),'stub_pending_hostinger')
       ON CONFLICT (hostname) DO UPDATE
         SET verification_status = 'verified', verified_at = now()
       RETURNING id`,
      [input.tenantId, existing.rows[0]!.hostname],
    );

    await db.query(
      `UPDATE website_domain_verifications
       SET status = 'verified_stub',
           verified_domain_id = $2,
           last_checked_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [input.verificationId, domain.rows[0]!.id],
    );

    await db.query(
      `UPDATE website_sites
       SET custom_domain_id = $2, updated_at = now()
       WHERE id = $1`,
      [existing.rows[0]!.website_site_id, domain.rows[0]!.id],
    );

    await writeAudit(db, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: 'websites.domain.verify_stub',
      entityType: 'website_domain_verification',
      entityId: input.verificationId,
      correlationId: input.correlationId,
      metadata: { note: 'DNS/cert/Hostinger not configured' },
    });

    return {
      verification_status: 'verified_stub',
      verified_domain_id: domain.rows[0]!.id,
    };
  }, pool);
}

export async function getWebsitePage(
  tenantId: string,
  pageId: string,
  pool: DbPool,
): Promise<WebsitePageRow> {
  return withTenant(tenantId, async (db) => {
    const row = await db.query<WebsitePageRow>(
      `SELECT id, tenant_id, website_site_id, slug, title, body_markdown, status,
              published_at, published_body_markdown, version_number, created_at, updated_at
       FROM website_pages WHERE id = $1`,
      [pageId],
    );
    if (row.rowCount === 0) throw notFound('Website page not found');
    return row.rows[0]!;
  }, pool);
}

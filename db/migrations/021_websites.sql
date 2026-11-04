-- DayMain: website CMS foundations — template catalogue, draft/publish pages,
-- custom-domain stub (verification pending until DNS/cert provisioning approved).

-- Global catalogue (not tenant-scoped; target: ten templates)
CREATE TABLE website_templates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  preview_image_url text,
  sort_order        integer NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO website_templates (slug, name, description, sort_order) VALUES
  ('harbour', 'Harbour', 'Calm coastal layout for family-facing settings', 1),
  ('meadow', 'Meadow', 'Soft outdoor-learning oriented home page', 2),
  ('lantern', 'Lantern', 'Warm evening-friendly information site', 3),
  ('notebook', 'Notebook', 'Simple brochure with clear policies section', 4),
  ('playground', 'Playground', 'Bold activity-led landing layout', 5),
  ('willow', 'Willow', 'Quiet nature palette for childminders', 6),
  ('beacon', 'Beacon', 'High-contrast operational announcements focus', 7),
  ('atelier', 'Atelier', 'Gallery-led creative setting showcase', 8),
  ('compass', 'Compass', 'Multi-site directory-friendly layout', 9),
  ('hearth', 'Hearth', 'Homely single-site childminder template', 10);

CREATE TABLE website_sites (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  site_id               uuid,
  name                  text NOT NULL,
  template_id           uuid NOT NULL REFERENCES website_templates(id) ON DELETE RESTRICT,
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'published', 'archived')),
  published_at          timestamptz,
  custom_domain_id      uuid,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES sites (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, custom_domain_id) REFERENCES verified_domains (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER website_sites_set_updated_at
  BEFORE UPDATE ON website_sites
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX website_sites_tenant_status_idx
  ON website_sites(tenant_id, status);

CREATE TABLE website_pages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  website_site_id       uuid NOT NULL,
  slug                  text NOT NULL,
  title                 text NOT NULL,
  body_markdown         text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'published', 'archived')),
  published_at          timestamptz,
  published_body_markdown text,
  version_number        integer NOT NULL DEFAULT 1 CHECK (version_number >= 1),
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  updated_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, website_site_id, slug),
  FOREIGN KEY (tenant_id, website_site_id) REFERENCES website_sites (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER website_pages_set_updated_at
  BEFORE UPDATE ON website_pages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX website_pages_site_idx
  ON website_pages(tenant_id, website_site_id, status);

-- Custom domain stub: request verification without claiming Hostinger/DNS ownership.
CREATE TABLE website_domain_verifications (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  website_site_id       uuid NOT NULL,
  hostname              citext NOT NULL,
  verification_token    text NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'verified_stub', 'failed', 'revoked')),
  verified_domain_id    uuid,
  last_checked_at       timestamptz,
  created_by_user_id    uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, hostname),
  FOREIGN KEY (tenant_id, website_site_id) REFERENCES website_sites (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, verified_domain_id) REFERENCES verified_domains (tenant_id, id) ON DELETE RESTRICT
);

CREATE TRIGGER website_domain_verifications_set_updated_at
  BEFORE UPDATE ON website_domain_verifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

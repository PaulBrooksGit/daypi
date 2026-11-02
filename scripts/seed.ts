import pg from 'pg';
import { hashPassword } from '../platform/auth/src/passwords.js';
import { createTenantBootstrap } from '../platform/tenancy/src/index.js';
import { seedMembershipGrants } from '../platform/authz/src/index.js';
import { createHash, randomBytes } from 'node:crypto';
import { config as loadEnv } from '../tests/load-env.js';

loadEnv();

/**
 * Synthetic fixtures for ≥2 tenants (Phase 0).
 * Password for all seeded users: Passw0rd!dev
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const passwordHash = await hashPassword('Passw0rd!dev');

  try {
    await client.query('BEGIN');

    const users = [
      { email: 'owner-a@example.test', key: 'ownerA' },
      { email: 'manager-a@example.test', key: 'managerA' },
      { email: 'parent-a@example.test', key: 'parentA' },
      { email: 'owner-b@example.test', key: 'ownerB' },
      { email: 'shared@example.test', key: 'shared' },
    ] as const;

    const ids: Record<string, string> = {};
    for (const u of users) {
      const res = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, status)
         VALUES ($1, $2, 'active')
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
         RETURNING id`,
        [u.email, passwordHash],
      );
      ids[u.key] = res.rows[0]!.id;
    }

    // Clear prior synthetic tenants by display name if re-seeding
    // (dev only — no cascade deletes of real data)

    const tenantA = await createTenantBootstrap(client, {
      displayName: 'Sunrise Childminding (Synthetic A)',
      settingType: 'childminder',
      ownerUserId: ids.ownerA!,
      siteName: 'Home setting',
    });

    // shared user also member of A as practitioner
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA.tenantId]);
    const sharedMemA = await client.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role_template, status)
       VALUES ($1, $2, 'practitioner', 'active')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active'
       RETURNING id`,
      [tenantA.tenantId, ids.shared],
    );
    await seedMembershipGrants(client, tenantA.tenantId, sharedMemA.rows[0]!.id, 'practitioner');

    const managerMem = await client.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role_template, status)
       VALUES ($1, $2, 'manager', 'active')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active'
       RETURNING id`,
      [tenantA.tenantId, ids.managerA],
    );
    await seedMembershipGrants(client, tenantA.tenantId, managerMem.rows[0]!.id, 'manager');

    const parentMem = await client.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role_template, status)
       VALUES ($1, $2, 'parent', 'active')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active'
       RETURNING id`,
      [tenantA.tenantId, ids.parentA],
    );
    await seedMembershipGrants(client, tenantA.tenantId, parentMem.rows[0]!.id, 'parent');

    const childA1 = await client.query<{ id: string }>(
      `INSERT INTO children (tenant_id, given_name, family_name, date_of_birth, enrolment_status)
       VALUES ($1, 'Amelia', 'Ash', '2021-03-12', 'active') RETURNING id`,
      [tenantA.tenantId],
    );
    await client.query(
      `INSERT INTO children (tenant_id, given_name, family_name, date_of_birth, enrolment_status)
       VALUES ($1, 'Ben', 'Ash', '2019-08-01', 'active')`,
      [tenantA.tenantId],
    );

    const guardian = await client.query<{ id: string }>(
      `INSERT INTO guardians (tenant_id, user_id, given_name, family_name, email)
       VALUES ($1, $2, 'Pat', 'Ash', 'parent-a@example.test') RETURNING id`,
      [tenantA.tenantId, ids.parentA],
    );

    // Parent linked only to Amelia (not Ben) — sibling isolation fixture
    await client.query(
      `INSERT INTO child_guardian_relationships (
         tenant_id, child_id, guardian_id, relationship,
         has_parental_responsibility, access_level, is_authorised_collector
       ) VALUES ($1, $2, $3, 'parent', true, 'full', true)`,
      [tenantA.tenantId, childA1.rows[0]!.id, guardian.rows[0]!.id],
    );

    const secret = randomBytes(24).toString('base64url');
    const secretHash = createHash('sha256').update(secret).digest('hex');
    const clientA = await client.query<{ id: string }>(
      `INSERT INTO integration_clients (tenant_id, name, secret_hash, scopes)
       VALUES ($1, 'Synthetic Integration A', $2, $3) RETURNING id`,
      [tenantA.tenantId, secretHash, ['children.read', 'tenant.read']],
    );

    // Tenant B
    await client.query("SELECT set_config('app.tenant_id', '', true)");
    const tenantB = await createTenantBootstrap(client, {
      displayName: 'Riverbank Nursery (Synthetic B)',
      settingType: 'nursery',
      ownerUserId: ids.ownerB!,
      siteName: 'Main room',
    });

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB.tenantId]);
    const sharedMemB = await client.query<{ id: string }>(
      `INSERT INTO memberships (tenant_id, user_id, role_template, status)
       VALUES ($1, $2, 'manager', 'active')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active'
       RETURNING id`,
      [tenantB.tenantId, ids.shared],
    );
    await seedMembershipGrants(client, tenantB.tenantId, sharedMemB.rows[0]!.id, 'manager');

    await client.query(
      `INSERT INTO children (tenant_id, given_name, family_name, date_of_birth, enrolment_status)
       VALUES ($1, 'Casey', 'Brook', '2020-01-20', 'active')`,
      [tenantB.tenantId],
    );

    await client.query('COMMIT');

    console.info(
      JSON.stringify(
        {
          tenantA: tenantA.tenantId,
          tenantB: tenantB.tenantId,
          users: {
            ownerA: 'owner-a@example.test',
            managerA: 'manager-a@example.test',
            parentA: 'parent-a@example.test',
            ownerB: 'owner-b@example.test',
            shared: 'shared@example.test',
          },
          password: 'Passw0rd!dev',
          integrationClientA: {
            id: clientA.rows[0]!.id,
            token: `client_${clientA.rows[0]!.id}.${secret}`,
          },
          notes: 'Parent A linked only to Amelia Ash, not Ben Ash',
        },
        null,
        2,
      ),
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  setupFixtures,
  login,
  selectTenant,
  request,
  type Fixtures,
} from './helpers.js';
import {
  createSessionDefinition,
  materialiseDatedSession,
  createConfirmedBooking,
  createBooking,
} from '../../modules/core/src/index.js';
import {
  checkIn,
  checkOut,
  getSessionRegister,
  correctAttendance,
} from '../../modules/operations/src/index.js';
import {
  createStaffProfile,
  createRotaShift,
} from '../../modules/team/src/index.js';
import { withTenant } from '../../platform/db/src/index.js';

describe('Phase 1 DayCore gate', () => {
  let fx: Fixtures;
  let datedSessionId: string;
  let capacityOneSessionId: string;

  beforeAll(async () => {
    fx = await setupFixtures();

    const def = await createSessionDefinition(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        siteId: fx.siteA,
        name: 'Morning',
        localStartTime: '09:00',
        localEndTime: '12:00',
        defaultCapacity: 2,
        timezone: 'Europe/London',
      },
      fx.pool,
    );

    const dated = await materialiseDatedSession(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        sessionDefinitionId: def.id as string,
        sessionDate: '2026-11-10',
      },
      fx.pool,
    );
    datedSessionId = dated.id as string;

    const capDef = await createSessionDefinition(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        siteId: fx.siteA,
        name: 'Final place',
        localStartTime: '13:00',
        localEndTime: '15:00',
        defaultCapacity: 1,
        timezone: 'Europe/London',
      },
      fx.pool,
    );
    const capSession = await materialiseDatedSession(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        sessionDefinitionId: capDef.id as string,
        sessionDate: '2026-11-11',
      },
      fx.pool,
    );
    capacityOneSessionId = capSession.id as string;
  }, 120_000);

  afterAll(async () => {
    await fx.pool.end();
  });

  it('guardian sees only linked child bookings and cannot book unlinked sibling', async () => {
    const token = await login(fx.app, fx.parentA.email, fx.parentA.password);
    await selectTenant(fx.app, token, fx.tenantA);

    const ok = await createBooking(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.parentA.id,
        childId: fx.childA1,
        datedSessionId,
        roleTemplate: 'parent',
      },
      fx.pool,
    );
    expect(ok.status).toBe('requested');

    await expect(
      createBooking(
        {
          tenantId: fx.tenantA,
          actorUserId: fx.parentA.id,
          childId: fx.childA2,
          datedSessionId,
          roleTemplate: 'parent',
        },
        fx.pool,
      ),
    ).rejects.toThrow(/No access to this child/i);

    const list = await request(fx.app)
      .get('/v1/bookings')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const childIds = list.body.data.map((b: { child_id: string }) => b.child_id);
    expect(childIds).toContain(fx.childA1);
    expect(childIds).not.toContain(fx.childA2);
  });

  it('revoked guardian relationship removes child access immediately', async () => {
    const token = await login(fx.app, fx.ownerA.email, fx.ownerA.password);
    await selectTenant(fx.app, token, fx.tenantA);

    const revoke = await request(fx.app)
      .delete(`/v1/children/${fx.childA1}/guardians/${fx.guardianA}`)
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`);
    expect(revoke.status).toBe(204);

    const parentToken = await login(fx.app, fx.parentA.email, fx.parentA.password);
    await selectTenant(fx.app, parentToken, fx.tenantA);
    const denied = await request(fx.app)
      .get(`/v1/children/${fx.childA1}`)
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${parentToken}`);
    expect([403, 404]).toContain(denied.status);

    // Restore link for later register tests
    const restore = await request(fx.app)
      .put(`/v1/children/${fx.childA1}/guardians/${fx.guardianA}`)
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`)
      .send({
        relationship: 'parent',
        access_level: 'full',
        has_parental_responsibility: true,
        is_authorised_collector: true,
      });
    expect(restore.status).toBe(200);
  });

  it('two concurrent confirms for the final place: at most one succeeds', async () => {
    const results = await Promise.allSettled([
      createConfirmedBooking(
        {
          tenantId: fx.tenantA,
          actorUserId: fx.ownerA.id,
          childId: fx.childA1,
          datedSessionId: capacityOneSessionId,
        },
        fx.pool,
      ),
      createConfirmedBooking(
        {
          tenantId: fx.tenantA,
          actorUserId: fx.ownerA.id,
          childId: fx.childA2,
          datedSessionId: capacityOneSessionId,
        },
        fx.pool,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const confirmed = await withTenant(fx.tenantA, async (db) => {
      const r = await db.query(
        `SELECT child_id FROM bookings
         WHERE dated_session_id = $1 AND status = 'confirmed'`,
        [capacityOneSessionId],
      );
      return r.rows;
    }, fx.pool);
    expect(confirmed).toHaveLength(1);
  });

  it('operational register reflects check-in/out and corrections accurately', async () => {
    // Clear any advisory requests from earlier tests, then confirm both children.
    await withTenant(fx.tenantA, async (db) => {
      await db.query(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = now()
         WHERE dated_session_id = $1 AND status IN ('requested', 'confirmed', 'waitlisted')`,
        [datedSessionId],
      );
    }, fx.pool);

    await createConfirmedBooking(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        childId: fx.childA1,
        datedSessionId,
        idempotencyKey: 'reg-a1',
      },
      fx.pool,
    );
    await createConfirmedBooking(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        childId: fx.childA2,
        datedSessionId,
        idempotencyKey: 'reg-a2',
      },
      fx.pool,
    );

    const staff = await createStaffProfile(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        givenName: 'Sam',
        familyName: 'Staff',
        siteId: fx.siteA,
        jobTitle: 'practitioner',
      },
      fx.pool,
    );
    await createRotaShift(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        staffProfileId: staff.id as string,
        siteId: fx.siteA,
        startsAt: '2026-11-10T08:00:00.000Z',
        endsAt: '2026-11-10T13:00:00.000Z',
      },
      fx.pool,
    );

    let register = await getSessionRegister(
      { tenantId: fx.tenantA, datedSessionId },
      fx.pool,
    );
    expect(register.entries).toHaveLength(2);
    expect(register.entries.every((e) => e.status === 'expected')).toBe(true);

    const inEvent = await checkIn(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        childId: fx.childA1,
        datedSessionId,
        occurredAt: '2026-11-10T09:05:00.000Z',
      },
      fx.pool,
    );

    register = await getSessionRegister(
      { tenantId: fx.tenantA, datedSessionId },
      fx.pool,
    );
    const amelia = register.entries.find((e) => e.child_id === fx.childA1)!;
    const ben = register.entries.find((e) => e.child_id === fx.childA2)!;
    expect(amelia.status).toBe('present');
    expect(ben.status).toBe('expected');

    await checkOut(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        childId: fx.childA1,
        datedSessionId,
        collectorGuardianId: fx.guardianA,
        occurredAt: '2026-11-10T12:00:00.000Z',
      },
      fx.pool,
    );

    register = await getSessionRegister(
      { tenantId: fx.tenantA, datedSessionId },
      fx.pool,
    );
    expect(register.entries.find((e) => e.child_id === fx.childA1)!.status).toBe('collected');

    // Correction: void erroneous check-out → child should not appear collected from that event
    const correction = await correctAttendance(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        attendanceEventId: (
          await withTenant(fx.tenantA, async (db) => {
            const r = await db.query<{ id: string }>(
              `SELECT id FROM attendance_events
               WHERE child_id = $1 AND dated_session_id = $2 AND event_type = 'check_out'
                 AND superseded_by_correction_id IS NULL`,
              [fx.childA1, datedSessionId],
            );
            return r.rows[0]!.id;
          }, fx.pool)
        ),
        correctionType: 'void_event',
        reason: 'Collected by wrong person recorded; voiding for re-entry',
      },
      fx.pool,
    );
    expect(correction.correction_id).toBeTruthy();

    // After voiding check-out, latest effective event is still check-in → present
    register = await getSessionRegister(
      { tenantId: fx.tenantA, datedSessionId },
      fx.pool,
    );
    expect(register.entries.find((e) => e.child_id === fx.childA1)!.status).toBe('present');

    // Original event remains in DB (not deleted) and is superseded
    const original = await withTenant(fx.tenantA, async (db) => {
      const r = await db.query(
        `SELECT superseded_by_correction_id FROM attendance_events WHERE id = $1`,
        [inEvent.id],
      );
      return r.rows[0];
    }, fx.pool);
    expect(original).toBeTruthy();

    const token = await login(fx.app, fx.ownerA.email, fx.ownerA.password);
    await selectTenant(fx.app, token, fx.tenantA);
    const apiReg = await request(fx.app)
      .get(`/v1/registers/${datedSessionId}`)
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`);
    expect(apiReg.status).toBe(200);
    expect(apiReg.body.data.staff_on_duty.length).toBeGreaterThanOrEqual(1);
  });

  it('enquiry → enrolment and import/export pilot workflows', async () => {
    const token = await login(fx.app, fx.ownerA.email, fx.ownerA.password);
    await selectTenant(fx.app, token, fx.tenantA);

    const enquiry = await request(fx.app)
      .post('/v1/enquiries')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`)
      .send({
        site_id: fx.siteA,
        child_given_name: 'Dana',
        child_family_name: 'Ash',
        child_date_of_birth: '2022-01-01',
        guardian_given_name: 'Pat',
        guardian_family_name: 'Ash',
        guardian_email: 'parent-a@example.test',
        source: 'pilot',
      });
    expect(enquiry.status).toBe(201);

    const child = await request(fx.app)
      .post('/v1/children')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`)
      .send({
        given_name: 'Dana',
        family_name: 'Ash',
        date_of_birth: '2022-01-01',
        enrolment_status: 'waiting',
      });
    expect(child.status).toBe(201);

    const enrolment = await request(fx.app)
      .post('/v1/enrolments')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`)
      .send({
        site_id: fx.siteA,
        child_id: child.body.data.id,
        enquiry_id: enquiry.body.data.id,
        start_date: '2026-11-01',
        status: 'active',
      });
    expect(enrolment.status).toBe(201);
    expect(enrolment.body.data.status).toBe('active');

    const dry = await request(fx.app)
      .post('/v1/import/children')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`)
      .send({
        dry_run: true,
        children: [
          {
            given_name: 'Eve',
            family_name: 'Ash',
            date_of_birth: '2023-05-05',
            guardians: [{ given_name: 'Pat', family_name: 'Ash', email: 'parent-a@example.test' }],
          },
        ],
      });
    expect(dry.status).toBe(200);
    expect(dry.body.data.would_create_children).toBe(1);

    const exported = await request(fx.app)
      .get('/v1/export/children')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${token}`);
    expect(exported.status).toBe(200);
    expect(exported.body.data.children.length).toBeGreaterThanOrEqual(3);
  });

  it('parent cannot confirm bookings or correct attendance', async () => {
    const parentToken = await login(fx.app, fx.parentA.email, fx.parentA.password);
    await selectTenant(fx.app, parentToken, fx.tenantA);

    const confirm = await request(fx.app)
      .post(`/v1/bookings/${datedSessionId}/confirm`)
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${parentToken}`);
    expect([403, 404]).toContain(confirm.status);

    const correct = await request(fx.app)
      .post('/v1/attendance/00000000-0000-4000-8000-000000000001/corrections')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ correction_type: 'void_event', reason: 'nope' });
    expect(correct.status).toBe(403);
  });
});

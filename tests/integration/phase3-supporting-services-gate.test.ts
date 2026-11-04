import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  setupFixtures,
  login,
  selectTenant,
  request,
  type Fixtures,
} from './helpers.js';
import {
  listWebsiteTemplates,
  createWebsiteSite,
  createWebsitePage,
  updateWebsitePageDraft,
  publishWebsitePage,
  requestCustomDomainVerification,
  completeCustomDomainVerificationStub,
} from '../../modules/websites/src/index.js';
import {
  createAiDraft,
  editAiDraft,
  approveAiDraftUnpublished,
  createAiProposal,
  approveAiProposalDraftOnly,
  blockConsequentialAiExecution,
} from '../../modules/ai/src/index.js';
import {
  createAuditTemplate,
  startAuditRun,
  completeAuditRun,
  addAuditAction,
  submitTestimonial,
  moderateTestimonial,
  listTestimonials,
} from '../../modules/quality/src/index.js';
import {
  getOrCreateAllergyProfile,
  addAllergy,
  listAllergies,
  setAllergyOverallStatus,
  addObservation,
} from '../../modules/health/src/index.js';
import {
  createTrip,
  addTripParticipant,
  requestTripPermission,
  respondTripPermission,
  recordHeadcount,
  recordOnlineLocationSample,
  blockLiveTripLocation,
} from '../../modules/trips/src/index.js';
import {
  createAsset,
  createInspectionSchedule,
  recordInspection,
  createMaintenanceAction,
} from '../../modules/facilities/src/index.js';
import { withTenant } from '../../platform/db/src/index.js';
import { AppError } from '../../platform/http/src/errors.js';

describe('Phase 3 supporting services gate', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await setupFixtures();
  }, 120_000);

  afterAll(async () => {
    await fx.pool.end();
  });

  it('DayMain: ten-template catalogue, draft/publish, domain stub', async () => {
    const templates = await listWebsiteTemplates(fx.pool);
    expect(templates.length).toBe(10);
    expect(templates.map((t) => t.slug)).toContain('hearth');

    const site = await createWebsiteSite(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        name: 'Ash Family Site',
        templateId: templates[0]!.id,
        siteId: fx.siteA,
      },
      fx.pool,
    );
    expect(site.status).toBe('draft');

    const page = await createWebsitePage(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        websiteSiteId: site.id,
        slug: 'about',
        title: 'About us',
        bodyMarkdown: 'Draft body',
      },
      fx.pool,
    );
    expect(page.status).toBe('draft');

    const edited = await updateWebsitePageDraft(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        pageId: page.id,
        bodyMarkdown: 'Reviewed body',
      },
      fx.pool,
    );
    expect(edited.version_number).toBeGreaterThan(page.version_number);

    const published = await publishWebsitePage(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        pageId: page.id,
      },
      fx.pool,
    );
    expect(published.status).toBe('published');
    expect(published.published_body_markdown).toBe('Reviewed body');

    const verification = await requestCustomDomainVerification(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        websiteSiteId: site.id,
        hostname: 'ash.example.test',
      },
      fx.pool,
    );
    expect(verification.status).toBe('pending');
    expect(verification.verification_token).toMatch(/^daypi-verify-/);

    const stub = await completeCustomDomainVerificationStub(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        verificationId: verification.id,
      },
      fx.pool,
    );
    expect(stub.verification_status).toBe('verified_stub');
  });

  it('DayMake: editable drafts; consequential AI execution blocked', async () => {
    const draft = await createAiDraft(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        draftType: 'activity_plan',
        title: 'Mud kitchen morning',
        brief: 'Outdoor sensory play',
      },
      fx.pool,
    );
    expect(draft.status).toBe('draft');
    expect(draft.provider).toBe('synthetic');
    expect(draft.body_markdown).toContain('Synthetic DayMake draft');

    const edited = await editAiDraft(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        draftId: draft.id,
        bodyMarkdown: '# Edited plan\n\nStaff-reviewed content.',
      },
      fx.pool,
    );
    expect(edited.status).toBe('ready_for_review');
    expect(edited.body_markdown).toContain('Staff-reviewed');

    const approved = await approveAiDraftUnpublished(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        draftId: draft.id,
      },
      fx.pool,
    );
    expect(approved.status).toBe('approved_unpublished');

    const consequential = await createAiProposal(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        actionType: 'health_record_change',
        payload: { pretend: true },
      },
      fx.pool,
    );
    expect(consequential.is_consequential).toBe(true);
    expect(consequential.status).toBe('execution_blocked');

    await expect(async () => {
      await approveAiProposalDraftOnly(
        {
          tenantId: fx.tenantA,
          actorUserId: fx.ownerA.id,
          proposalId: consequential.id,
        },
        fx.pool,
      );
    }).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });

    expect(() => blockConsequentialAiExecution()).toThrow(AppError);

    const draftOnly = await createAiProposal(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        actionType: 'create_unpublished_draft',
        draftId: draft.id,
      },
      fx.pool,
    );
    const approvedProposal = await approveAiProposalDraftOnly(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        proposalId: draftOnly.id,
      },
      fx.pool,
    );
    expect(approvedProposal.status).toBe('approved_draft_only');
  });

  it('DayStar: versioned audit templates and moderated testimonials', async () => {
    const { template, version } = await createAuditTemplate(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        name: 'Room readiness',
        criteria: [{ id: 'hygiene', label: 'Hygiene' }],
      },
      fx.pool,
    );
    expect(template.current_version_id).toBe(version.id);
    expect(version.version_number).toBe(1);

    const run = await startAuditRun(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        templateId: template.id,
        title: 'March check',
      },
      fx.pool,
    );
    expect(run.compliance_claim).toBe('internal_only');

    await addAuditAction(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        runId: run.id,
        title: 'Restock first-aid kit',
      },
      fx.pool,
    );

    const completed = await completeAuditRun(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        runId: run.id,
        internalScore: 82,
        scoreLabel: 'good',
      },
      fx.pool,
    );
    expect(completed.status).toBe('completed');
    expect(Number(completed.internal_score)).toBe(82);

    const submitted = await submitTestimonial(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.parentA.id,
        authorDisplayName: 'Pat Ash',
        body: 'Lovely setting',
        guardianId: fx.guardianA,
        roleTemplate: 'parent',
      },
      fx.pool,
    );
    expect(submitted.moderation_status).toBe('pending');
    expect(submitted.visibility).toBe('private');

    const moderated = await moderateTestimonial(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        testimonialId: submitted.id,
        moderationStatus: 'approved',
        visibility: 'public',
      },
      fx.pool,
    );
    expect(moderated.moderation_status).toBe('approved');
    expect(moderated.visibility).toBe('public');

    const visible = await listTestimonials(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.parentA.id,
        roleTemplate: 'parent',
      },
      fx.pool,
    );
    expect(visible.some((t) => t.id === submitted.id)).toBe(true);
  });

  it('DayGrow: allergy unknown default; distinguish confirmed_none vs unconfirmed', async () => {
    const profile = await getOrCreateAllergyProfile(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        childId: fx.childA1,
      },
      fx.pool,
    );
    expect(profile.overall_status).toBe('unknown');

    const listed = await listAllergies(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        childId: fx.childA2,
      },
      fx.pool,
    );
    expect(listed.profile.overall_status).toBe('unknown');
    expect(listed.allergies).toHaveLength(0);

    await addAllergy(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        childId: fx.childA1,
        allergen: 'Peanuts',
        confirmationStatus: 'unconfirmed',
      },
      fx.pool,
    );
    const afterUnconfirmed = await listAllergies(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        childId: fx.childA1,
      },
      fx.pool,
    );
    expect(afterUnconfirmed.profile.overall_status).toBe('unconfirmed');
    expect(afterUnconfirmed.allergies[0]!.confirmation_status).toBe('unconfirmed');

    await addAllergy(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        childId: fx.childA1,
        allergen: 'Tree nuts',
        confirmationStatus: 'confirmed_present',
        severity: 'severe',
      },
      fx.pool,
    );
    const afterConfirmed = await listAllergies(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        childId: fx.childA1,
      },
      fx.pool,
    );
    expect(afterConfirmed.profile.overall_status).toBe('confirmed_present');

    const none = await setAllergyOverallStatus(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        childId: fx.childA2,
        overallStatus: 'confirmed_none',
        notes: 'Reviewed with guardian',
      },
      fx.pool,
    );
    expect(none.overall_status).toBe('confirmed_none');

    const obs = await addObservation(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        childId: fx.childA1,
        bodyMarkdown: 'Engaged well with outdoor play',
        category: 'development',
      },
      fx.pool,
    );
    expect(obs.category).toBe('development');

    // Health access is audited
    const audits = await withTenant(fx.tenantA, async (db) => {
      return db.query(
        `SELECT action FROM audit_events
         WHERE action LIKE 'health.%'
         ORDER BY occurred_at DESC
         LIMIT 5`,
      );
    }, fx.pool);
    expect(audits.rowCount).toBeGreaterThan(0);
  });

  it('DayStep: permissions, headcounts; live GPS disabled; online sample ok', async () => {
    const trip = await createTrip(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        title: 'Park outing',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        siteId: fx.siteA,
        destination: 'Local park',
      },
      fx.pool,
    );
    expect(trip.status).toBe('planned');

    await addTripParticipant(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        tripId: trip.id,
        role: 'child',
        childId: fx.childA1,
      },
      fx.pool,
    );

    const permission = await requestTripPermission(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        tripId: trip.id,
        childId: fx.childA1,
        guardianId: fx.guardianA,
      },
      fx.pool,
    );
    expect(permission.status).toBe('pending');

    const responded = await respondTripPermission(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.parentA.id,
        permissionId: permission.id,
        status: 'granted',
        roleTemplate: 'parent',
      },
      fx.pool,
    );
    expect(responded.status).toBe('granted');

    const headcount = await recordHeadcount(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        tripId: trip.id,
        expectedCount: 1,
        actualCount: 1,
      },
      fx.pool,
    );
    expect(headcount.actual_count).toBe(1);

    const sample = await recordOnlineLocationSample(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        tripId: trip.id,
        latitude: 51.5,
        longitude: -0.12,
        accuracyMetres: 12,
      },
      fx.pool,
    );
    expect(sample.is_live_stream).toBe(false);

    expect(() => blockLiveTripLocation()).toThrow(AppError);
  });

  it('DayCare: assets, inspections, findings, maintenance', async () => {
    const asset = await createAsset(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        name: 'Garden gate',
        category: 'outdoor',
        siteId: fx.siteA,
      },
      fx.pool,
    );

    const schedule = await createInspectionSchedule(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        assetId: asset.id,
        title: 'Monthly gate check',
        cadenceDays: 30,
        nextDueOn: '2026-12-01',
      },
      fx.pool,
    );
    expect(schedule.status).toBe('active');

    const result = await recordInspection(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        assetId: asset.id,
        scheduleId: schedule.id,
        outcome: 'fail',
        notes: 'Latch sticking',
        findings: [{ severity: 'high', description: 'Latch unreliable' }],
      },
      fx.pool,
    );
    expect(result.inspection.outcome).toBe('fail');
    expect(result.findings).toHaveLength(1);

    const action = await createMaintenanceAction(
      {
        tenantId: fx.tenantA,
        actorUserId: fx.ownerA.id,
        assetId: asset.id,
        findingId: result.findings[0]!.id,
        title: 'Replace latch',
      },
      fx.pool,
    );
    expect(action.status).toBe('planned');
  });

  it('HTTP smoke + tenant isolation for Phase 3 surfaces', async () => {
    const tokenA = await login(fx.app, fx.ownerA.email, fx.ownerA.password);
    await selectTenant(fx.app, tokenA, fx.tenantA);

    const templates = await request(fx.app)
      .get('/v1/website-templates')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(templates.status).toBe(200);
    expect(templates.body.data).toHaveLength(10);

    const draft = await request(fx.app)
      .post('/v1/ai/drafts')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ draft_type: 'label', title: 'Coat peg labels' });
    expect(draft.status).toBe(201);

    const exec = await request(fx.app)
      .post(`/v1/ai/proposals/${draft.body.data.id}/execute`)
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});
    expect(exec.status).toBe(403);
    expect(exec.body.error.code).toBe('FEATURE_DISABLED');

    const liveGps = await request(fx.app)
      .post(`/v1/trips/${crypto.randomUUID()}/location/live`)
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});
    expect(liveGps.status).toBe(403);

    const allergies = await request(fx.app)
      .get(`/v1/children/${fx.childA1}/allergies`)
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(allergies.status).toBe(200);
    expect(allergies.body.data.profile.overall_status).not.toBe('None');

    // Tenant B owner cannot read Tenant A child allergies
    const tokenB = await login(fx.app, fx.ownerB.email, fx.ownerB.password);
    await selectTenant(fx.app, tokenB, fx.tenantB);
    const cross = await request(fx.app)
      .get(`/v1/children/${fx.childA1}/allergies`)
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(cross.status).toBe(404);

    const asset = await request(fx.app)
      .post('/v1/facilities/assets')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${tokenA}`);
    // tokenA still selected? selectTenant for B changed session — re-select A
    await selectTenant(fx.app, tokenA, fx.tenantA);
    const assetOk = await request(fx.app)
      .post('/v1/facilities/assets')
      .set('Host', 'localhost')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Fire blanket', category: 'equipment' });
    expect(assetOk.status).toBe(201);
    void asset;
  });
});

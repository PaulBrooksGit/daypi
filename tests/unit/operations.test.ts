import { describe, expect, it } from 'vitest';
import { DISABLED_OPERATIONS, ROLE_TEMPLATE_OPERATIONS } from '../../platform/authz/src/index.js';

describe('permission catalogue', () => {
  it('keeps consequential / gated ops disabled', () => {
    expect(DISABLED_OPERATIONS.has('ai.execute_consequential')).toBe(true);
    expect(DISABLED_OPERATIONS.has('trips.location.live')).toBe(true);
    expect(DISABLED_OPERATIONS.has('payroll.submit')).toBe(true);
    expect(DISABLED_OPERATIONS.has('dayswap.*')).toBe(true);
    expect(DISABLED_OPERATIONS.has('daysale.*')).toBe(true);
  });

  it('finance template does not include health.read', () => {
    expect(ROLE_TEMPLATE_OPERATIONS.finance).not.toContain('health.read');
  });

  it('owner includes Phase 3 website and facilities ops', () => {
    expect(ROLE_TEMPLATE_OPERATIONS.owner).toContain('tenant.update');
    expect(ROLE_TEMPLATE_OPERATIONS.owner).toContain('websites.publish');
    expect(ROLE_TEMPLATE_OPERATIONS.owner).toContain('facilities.manage');
    expect(ROLE_TEMPLATE_OPERATIONS.parent).toContain('trips.permission.respond');
  });
});

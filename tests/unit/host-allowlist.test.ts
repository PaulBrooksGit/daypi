import { describe, expect, it } from 'vitest';
import { normaliseHost } from '../../platform/http/src/host-allowlist.js';

describe('normaliseHost', () => {
  it('strips port and lowercases', () => {
    expect(normaliseHost('LocalHost:3001')).toBe('localhost');
  });

  it('rejects empty and malformed', () => {
    expect(normaliseHost('')).toBeNull();
    expect(normaliseHost('bad host')).toBeNull();
    expect(normaliseHost('evil/../x')).toBeNull();
  });
});

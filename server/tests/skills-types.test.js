import { describe, test, expect } from '@jest/globals';
import { canTransitionStatus, SKILLS_STATUSES, normalizeWorkerStatus } from '../services/skills/types.js';

describe('skills status transitions', () => {
  test('allows queued/running transitions and blocks terminal transitions', () => {
    expect(canTransitionStatus(SKILLS_STATUSES.QUEUED, SKILLS_STATUSES.RUNNING)).toBe(true);
    expect(canTransitionStatus(SKILLS_STATUSES.RUNNING, SKILLS_STATUSES.COMPLETED)).toBe(true);
    expect(canTransitionStatus(SKILLS_STATUSES.COMPLETED, SKILLS_STATUSES.RUNNING)).toBe(false);
    expect(canTransitionStatus(SKILLS_STATUSES.CANCELLED, SKILLS_STATUSES.RUNNING)).toBe(false);
  });

  test('normalizes worker statuses', () => {
    expect(normalizeWorkerStatus('in_progress')).toBe(SKILLS_STATUSES.RUNNING);
    expect(normalizeWorkerStatus('success')).toBe(SKILLS_STATUSES.COMPLETED);
    expect(normalizeWorkerStatus('canceled')).toBe(SKILLS_STATUSES.CANCELLED);
    expect(normalizeWorkerStatus('unknown')).toBe(null);
  });
});

export const SKILLS_STATUSES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out'
});

export const TERMINAL_SKILLS_STATUSES = new Set([
  SKILLS_STATUSES.COMPLETED,
  SKILLS_STATUSES.FAILED,
  SKILLS_STATUSES.CANCELLED,
  SKILLS_STATUSES.TIMED_OUT
]);

export const SKILLS_ERROR_CODES = Object.freeze({
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  INPUT_VALIDATION_FAILED: 'INPUT_VALIDATION_FAILED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  POLICY_DENIED: 'POLICY_DENIED'
});

export const STATUS_TRANSITIONS = Object.freeze({
  [SKILLS_STATUSES.QUEUED]: new Set([
    SKILLS_STATUSES.RUNNING,
    SKILLS_STATUSES.FAILED,
    SKILLS_STATUSES.CANCELLED,
    SKILLS_STATUSES.TIMED_OUT
  ]),
  [SKILLS_STATUSES.RUNNING]: new Set([
    SKILLS_STATUSES.COMPLETED,
    SKILLS_STATUSES.FAILED,
    SKILLS_STATUSES.CANCELLED,
    SKILLS_STATUSES.TIMED_OUT
  ])
});

export function isValidStatus(status) {
  return Object.values(SKILLS_STATUSES).includes(status);
}

export function canTransitionStatus(fromStatus, toStatus) {
  if (fromStatus === toStatus) return true;
  if (TERMINAL_SKILLS_STATUSES.has(fromStatus)) return false;
  return STATUS_TRANSITIONS[fromStatus]?.has(toStatus) || false;
}

export function normalizeWorkerStatus(status) {
  if (!status || typeof status !== 'string') return null;
  const normalized = status.toLowerCase();
  switch (normalized) {
    case 'queued':
    case 'pending':
      return SKILLS_STATUSES.QUEUED;
    case 'running':
    case 'in_progress':
      return SKILLS_STATUSES.RUNNING;
    case 'completed':
    case 'succeeded':
    case 'success':
      return SKILLS_STATUSES.COMPLETED;
    case 'failed':
    case 'error':
      return SKILLS_STATUSES.FAILED;
    case 'cancelled':
    case 'canceled':
      return SKILLS_STATUSES.CANCELLED;
    case 'timed_out':
    case 'timeout':
      return SKILLS_STATUSES.TIMED_OUT;
    default:
      return null;
  }
}

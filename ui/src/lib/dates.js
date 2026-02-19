import { formatDistanceToNow } from 'date-fns';

/**
 * Safely format a timestamp as a relative time string (e.g., "3 minutes ago").
 * Handles SQLite timestamps ("2026-02-16 18:04:51"), ISO 8601, null, and invalid values.
 */
export function safeTimeAgo(dateStr) {
  if (!dateStr) return '-';
  try {
    // Handle SQLite format "YYYY-MM-DD HH:MM:SS" by converting to ISO
    const normalized = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
    const date = new Date(normalized);
    if (isNaN(date.getTime())) return '-';
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    return '-';
  }
}

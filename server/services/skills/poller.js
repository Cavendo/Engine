import { claimDueInvocations, processClaimedInvocation } from './invocationService.js';

const POLL_INTERVAL_MS = parseInt(process.env.SKILLS_POLL_INTERVAL_MS || '5000', 10);

let timer = null;
let running = false;
let ownerId = null;

function generateOwnerId() {
  const pid = process.pid;
  const rand = Math.random().toString(36).slice(2, 10);
  return `skills-poller:${pid}:${rand}`;
}

async function tick() {
  if (running) return;
  running = true;

  try {
    const claimed = await claimDueInvocations(ownerId, 20);
    for (const invocation of claimed) {
      await processClaimedInvocation(invocation, ownerId);
    }
  } catch (err) {
    console.error('[SkillsPoller] Tick failed:', err);
  } finally {
    running = false;
  }
}

export function startSkillsRuntimePoller() {
  if (timer) return;
  ownerId = generateOwnerId();
  timer = setInterval(() => {
    tick().catch((err) => console.error('[SkillsPoller] Unhandled tick error:', err));
  }, POLL_INTERVAL_MS);
  timer.unref?.();
  tick().catch((err) => console.error('[SkillsPoller] Initial tick failed:', err));
  console.log(`[SkillsPoller] Started (${ownerId}) interval=${POLL_INTERVAL_MS}ms`);
}

export function stopSkillsRuntimePoller() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  console.log('[SkillsPoller] Stopped');
}

export function getSkillsPollerState() {
  return {
    running,
    active: Boolean(timer),
    ownerId,
    intervalMs: POLL_INTERVAL_MS
  };
}

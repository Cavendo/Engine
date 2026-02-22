import { createApp } from './app.js';

const { start, stop } = createApp();

let shuttingDown = false;

start().catch(err => {
  console.error('Failed to start Cavendo Engine:', err);
  process.exit(1);
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);
  await stop();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

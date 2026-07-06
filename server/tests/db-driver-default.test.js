import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function runAdapterProbe(overrides = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'cavendo-db-driver-default-'));
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_PATH: join(tempDir, 'default.db'),
    ...overrides,
  };
  delete env.DB_DRIVER;
  delete env.DATABASE_URL;
  delete env.ALLOW_SQLITE;
  if (overrides.DB_DRIVER) env.DB_DRIVER = overrides.DB_DRIVER;

  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    "const { default: db } = await import('./server/db/adapter.js'); console.log(db.dialect); db.close?.();"
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });

  rmSync(tempDir, { recursive: true, force: true });
  return result;
}

describe('database driver default', () => {
  test('uses SQLite when DB_DRIVER is unset', () => {
    const result = runAdapterProbe();

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('sqlite');
    expect(result.stderr).toBe('');
  });

  test('allows DB_DRIVER=sqlite in production without ALLOW_SQLITE', () => {
    const result = runAdapterProbe({ DB_DRIVER: 'sqlite' });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('sqlite');
    expect(result.stderr).toBe('');
  });
});

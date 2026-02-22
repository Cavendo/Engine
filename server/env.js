// server/env.js — must be imported before anything that reads process.env
import crypto from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const envPath = join(PROJECT_ROOT, '.env');
const envExamplePath = join(PROJECT_ROOT, '.env.example');

if (!existsSync(envPath) && existsSync(envExamplePath)) {
  console.log('[Setup] No .env file found — generating from .env.example with secure defaults...');
  let envContent = readFileSync(envExamplePath, 'utf-8');

  // Replace placeholder secrets with random values
  const jwtSecret = crypto.randomBytes(32).toString('hex');
  const encryptionKey = crypto.randomBytes(32).toString('hex');

  envContent = envContent.replace(
    /^JWT_SECRET=.*$/m,
    `JWT_SECRET=${jwtSecret}`
  );
  envContent = envContent.replace(
    /^# ENCRYPTION_KEY=.*$/m,
    `ENCRYPTION_KEY=${encryptionKey}`
  );

  writeFileSync(envPath, envContent, 'utf-8');
  console.log('[Setup] .env created with unique secrets. Review and customize as needed.');

  // Load env vars from the newly created file
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
} else if (existsSync(envPath)) {
  // Load existing .env file into process.env (values already set take precedence)
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

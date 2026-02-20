import { Router } from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as response from '../utils/response.js';
import { userAuth, requireRoles } from '../middleware/userAuth.js';
import { getConfig, isConfigured, sendEmail, reloadConfig } from '../services/emailProvider.js';
import { getDispatcherStatus } from '../services/taskDispatcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../..');
const ENV_PATH = join(PROJECT_ROOT, '.env');

// Load models config once at startup
let modelsConfig;
try {
  modelsConfig = JSON.parse(readFileSync(join(__dirname, '../config/models.json'), 'utf-8'));
} catch (err) {
  console.error('Failed to load models.json:', err.message);
  modelsConfig = { providers: {} };
}

const router = Router();

/**
 * GET /api/settings/email
 * Get current email provider configuration (masked sensitive values)
 */
router.get('/email', userAuth, requireRoles('admin'), (req, res) => {
  try {
    const config = getConfig();
    response.success(res, config);
  } catch (err) {
    console.error('Error getting email config:', err);
    response.serverError(res);
  }
});

// All EMAIL_* keys we manage
const EMAIL_KEYS = [
  'EMAIL_PROVIDER', 'EMAIL_FROM', 'EMAIL_FROM_NAME',
  'EMAIL_SMTP_HOST', 'EMAIL_SMTP_PORT', 'EMAIL_SMTP_SECURE', 'EMAIL_SMTP_USER', 'EMAIL_SMTP_PASS',
  'EMAIL_SENDGRID_API_KEY',
  'EMAIL_MAILJET_API_KEY', 'EMAIL_MAILJET_SECRET_KEY',
  'EMAIL_POSTMARK_SERVER_TOKEN',
  'EMAIL_SES_REGION', 'EMAIL_SES_ACCESS_KEY_ID', 'EMAIL_SES_SECRET_ACCESS_KEY'
];

// Keys whose values should not be overwritten when masked (starts with ••)
const SENSITIVE_KEYS = [
  'EMAIL_SMTP_PASS', 'EMAIL_SENDGRID_API_KEY',
  'EMAIL_MAILJET_API_KEY', 'EMAIL_MAILJET_SECRET_KEY',
  'EMAIL_POSTMARK_SERVER_TOKEN',
  'EMAIL_SES_ACCESS_KEY_ID', 'EMAIL_SES_SECRET_ACCESS_KEY'
];

/**
 * Read .env file and return { lines: string[], vars: Map<string, lineIndex> }
 */
function readEnvFile() {
  if (!existsSync(ENV_PATH)) {
    return { lines: [], vars: new Map() };
  }
  const content = readFileSync(ENV_PATH, 'utf-8');
  const lines = content.split('\n');
  const vars = new Map();
  lines.forEach((line, i) => {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    if (match) vars.set(match[1], i);
  });
  return { lines, vars };
}

/**
 * Update or add a key=value in the .env file lines
 */
function setEnvVar(lines, vars, key, value) {
  // VULN-002: Sanitize newlines to prevent env var injection
  const sanitizedValue = String(value).replace(/[\r\n]/g, '');
  const line = `${key}=${sanitizedValue}`;
  if (vars.has(key)) {
    lines[vars.get(key)] = line;
  } else {
    // Find the last EMAIL_ line to insert nearby, or append
    let insertAt = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('EMAIL_') || lines[i].startsWith('# EMAIL') || lines[i].startsWith('# email')) {
        insertAt = i + 1;
        break;
      }
    }
    if (insertAt >= 0) {
      lines.splice(insertAt, 0, line);
    } else {
      lines.push('', `# Email Provider`, line);
    }
    // Rebuild vars map after insert
    vars.clear();
    lines.forEach((l, i) => {
      const m = l.match(/^([A-Z_][A-Z0-9_]*)=/);
      if (m) vars.set(m[1], i);
    });
  }
}

/**
 * POST /api/settings/email
 * Save email provider configuration to .env and restart server
 */
router.post('/email', userAuth, requireRoles('admin'), (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return response.badRequest(res, 'Request body must be an object of EMAIL_* key-value pairs');
    }

    const { lines, vars } = readEnvFile();

    for (const [key, value] of Object.entries(updates)) {
      // Only allow EMAIL_* keys
      if (!EMAIL_KEYS.includes(key)) continue;

      // Skip masked values (user didn't change the sensitive field)
      if (SENSITIVE_KEYS.includes(key) && typeof value === 'string' && value.startsWith('••')) continue;

      setEnvVar(lines, vars, key, value ?? '');
    }

    // Write the file back
    writeFileSync(ENV_PATH, lines.join('\n'), 'utf-8');

    // Reload env vars from the updated .env into process.env
    for (const [key, value] of Object.entries(updates)) {
      if (EMAIL_KEYS.includes(key) && !(SENSITIVE_KEYS.includes(key) && typeof value === 'string' && value.startsWith('••'))) {
        process.env[key] = value ?? '';
      }
    }

    // Reload the email provider config in-memory (no server restart needed)
    reloadConfig();

    response.success(res, { saved: true });
  } catch (err) {
    console.error('Error saving email config:', err);
    response.serverError(res);
  }
});

/**
 * POST /api/settings/email/test
 * Send a test email to verify configuration
 */
router.post('/email/test', userAuth, requireRoles('admin'), async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) {
      return response.badRequest(res, 'Recipient email address (to) is required');
    }

    if (!isConfigured()) {
      return response.badRequest(res, 'Email is not configured. Set the EMAIL_* environment variables in your .env file and restart the server.');
    }

    const result = await sendEmail({
      to: [to],
      subject: 'Cavendo Engine — Test Email',
      html: `
        <div style="font-family: sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #333;">Email Configuration Working</h2>
          <p style="color: #666;">This is a test email from your Cavendo Engine instance.</p>
          <p style="color: #666;">Your email provider is configured correctly and ready to send notifications and delivery route emails.</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
          <p style="color: #999; font-size: 12px;">Sent from Cavendo Engine at ${new Date().toISOString()}</p>
        </div>
      `,
      text: 'This is a test email from your Cavendo Engine instance. Your email provider is configured correctly.'
    });

    response.success(res, { sent: true, messageId: result.messageId });
  } catch (err) {
    console.error('Error sending test email:', err);
    response.success(res, { sent: false, error: err.message });
  }
});

/**
 * GET /api/settings/dispatcher
 * Get task dispatcher status
 */
router.get('/dispatcher', userAuth, requireRoles('admin'), (req, res) => {
  try {
    const status = getDispatcherStatus();
    response.success(res, status);
  } catch (err) {
    console.error('Error getting dispatcher status:', err);
    response.serverError(res);
  }
});

/**
 * GET /api/settings/models
 * Get available AI provider models (no auth required — used in agent setup)
 */
router.get('/models', userAuth, (req, res) => {
  response.success(res, modelsConfig);
});

export default router;

/**
 * Email Provider Service
 * Multi-provider email abstraction supporting SMTP, SendGrid, Mailjet, Postmark, AWS SES
 */

import nodemailer from 'nodemailer';

// ============================================
// Provider Configuration
// ============================================

let EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'smtp';
let DEFAULT_FROM = process.env.EMAIL_FROM || 'notifications@cavendo.local';
let DEFAULT_FROM_NAME = process.env.EMAIL_FROM_NAME || 'Cavendo';

// SMTP Configuration
let SMTP_CONFIG = {
  host: process.env.EMAIL_SMTP_HOST,
  port: parseInt(process.env.EMAIL_SMTP_PORT || '587'),
  secure: process.env.EMAIL_SMTP_SECURE === 'true',
  auth: process.env.EMAIL_SMTP_USER ? {
    user: process.env.EMAIL_SMTP_USER,
    pass: process.env.EMAIL_SMTP_PASS
  } : undefined
};

// API Keys
let SENDGRID_API_KEY = process.env.EMAIL_SENDGRID_API_KEY;
let MAILJET_API_KEY = process.env.EMAIL_MAILJET_API_KEY;
let MAILJET_SECRET_KEY = process.env.EMAIL_MAILJET_SECRET_KEY;
let POSTMARK_SERVER_TOKEN = process.env.EMAIL_POSTMARK_SERVER_TOKEN;
let SES_CONFIG = {
  region: process.env.EMAIL_SES_REGION,
  accessKeyId: process.env.EMAIL_SES_ACCESS_KEY_ID,
  secretAccessKey: process.env.EMAIL_SES_SECRET_ACCESS_KEY
};

// ============================================
// Provider Interface
// ============================================

/**
 * @typedef {Object} EmailOptions
 * @property {string[]} to - Recipient email addresses
 * @property {string[]} [cc] - CC recipients
 * @property {string[]} [bcc] - BCC recipients
 * @property {string} [from] - Sender email address
 * @property {string} [fromName] - Sender display name
 * @property {string} subject - Email subject
 * @property {string} html - HTML content
 * @property {string} [text] - Plain text content
 * @property {Attachment[]} [attachments] - File attachments
 * @property {string} [replyTo] - Reply-to address
 */

/**
 * @typedef {Object} Attachment
 * @property {string} filename - File name
 * @property {string|Buffer} content - File content
 * @property {string} [contentType] - MIME type
 */

/**
 * @typedef {Object} SendResult
 * @property {string} messageId - Provider message ID
 * @property {string} status - Send status
 */

// ============================================
// Check Configuration
// ============================================

/**
 * Check if email provider is configured
 * @returns {boolean}
 */
/**
 * Get current email configuration (with sensitive values masked)
 */
export function getConfig() {
  const mask = (val) => val ? '••••••' + val.slice(-4) : '';

  return {
    provider: EMAIL_PROVIDER,
    configured: isConfigured(),
    from: DEFAULT_FROM,
    fromName: DEFAULT_FROM_NAME,
    smtp: {
      host: SMTP_CONFIG.host || '',
      port: SMTP_CONFIG.port,
      secure: SMTP_CONFIG.secure,
      user: SMTP_CONFIG.auth?.user || '',
      pass: mask(SMTP_CONFIG.auth?.pass)
    },
    sendgrid: { apiKey: mask(SENDGRID_API_KEY) },
    mailjet: { apiKey: mask(MAILJET_API_KEY), secretKey: mask(MAILJET_SECRET_KEY) },
    postmark: { serverToken: mask(POSTMARK_SERVER_TOKEN) },
    ses: {
      region: SES_CONFIG.region || '',
      accessKeyId: mask(SES_CONFIG.accessKeyId),
      secretAccessKey: mask(SES_CONFIG.secretAccessKey)
    }
  };
}

export function isConfigured() {
  switch (EMAIL_PROVIDER) {
    case 'smtp':
      return !!SMTP_CONFIG.host;
    case 'sendgrid':
      return !!SENDGRID_API_KEY;
    case 'mailjet':
      return !!MAILJET_API_KEY && !!MAILJET_SECRET_KEY;
    case 'postmark':
      return !!POSTMARK_SERVER_TOKEN;
    case 'ses':
      return !!SES_CONFIG.region && !!SES_CONFIG.accessKeyId && !!SES_CONFIG.secretAccessKey;
    default:
      return false;
  }
}

/**
 * Validate email configuration
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
export async function validateConfig() {
  if (!isConfigured()) {
    return { valid: false, error: `Email provider '${EMAIL_PROVIDER}' is not configured` };
  }

  try {
    switch (EMAIL_PROVIDER) {
      case 'smtp':
        return await validateSmtp();
      case 'sendgrid':
        return await validateSendGrid();
      case 'mailjet':
        return await validateMailjet();
      case 'postmark':
        return await validatePostmark();
      case 'ses':
        return await validateSes();
      default:
        return { valid: false, error: `Unknown email provider: ${EMAIL_PROVIDER}` };
    }
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

// ============================================
// Send Email
// ============================================

/**
 * Send an email using the configured provider
 * @param {EmailOptions} options
 * @returns {Promise<SendResult>}
 */
export async function sendEmail(options) {
  if (!isConfigured()) {
    throw new Error(`Email provider '${EMAIL_PROVIDER}' is not configured`);
  }

  const normalizedOptions = {
    ...options,
    from: options.from || DEFAULT_FROM,
    fromName: options.fromName || DEFAULT_FROM_NAME,
    to: Array.isArray(options.to) ? options.to : [options.to],
    cc: options.cc ? (Array.isArray(options.cc) ? options.cc : [options.cc]) : [],
    bcc: options.bcc ? (Array.isArray(options.bcc) ? options.bcc : [options.bcc]) : [],
    attachments: options.attachments || []
  };

  switch (EMAIL_PROVIDER) {
    case 'smtp':
      return await sendViaSMTP(normalizedOptions);
    case 'sendgrid':
      return await sendViaSendGrid(normalizedOptions);
    case 'mailjet':
      return await sendViaMailjet(normalizedOptions);
    case 'postmark':
      return await sendViaPostmark(normalizedOptions);
    case 'ses':
      return await sendViaSES(normalizedOptions);
    default:
      throw new Error(`Unknown email provider: ${EMAIL_PROVIDER}`);
  }
}

// ============================================
// SMTP Provider
// ============================================

let smtpTransporter = null;

function getSmtpTransporter() {
  if (!smtpTransporter) {
    smtpTransporter = nodemailer.createTransport(SMTP_CONFIG);
  }
  return smtpTransporter;
}

async function validateSmtp() {
  try {
    const transporter = getSmtpTransporter();
    await transporter.verify();
    return { valid: true };
  } catch (error) {
    return { valid: false, error: `SMTP connection failed: ${error.message}` };
  }
}

async function sendViaSMTP(options) {
  const transporter = getSmtpTransporter();

  const mailOptions = {
    from: options.fromName ? `"${options.fromName}" <${options.from}>` : options.from,
    to: options.to.join(', '),
    cc: options.cc.length > 0 ? options.cc.join(', ') : undefined,
    bcc: options.bcc.length > 0 ? options.bcc.join(', ') : undefined,
    replyTo: options.replyTo,
    subject: options.subject,
    html: options.html,
    text: options.text,
    attachments: options.attachments.map(a => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType
    }))
  };

  const result = await transporter.sendMail(mailOptions);

  return {
    messageId: result.messageId,
    status: 'sent'
  };
}

// ============================================
// SendGrid Provider
// ============================================

async function validateSendGrid() {
  try {
    const response = await fetch('https://api.sendgrid.com/v3/user/profile', {
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`
      }
    });
    if (response.ok) {
      return { valid: true };
    } else {
      const error = await response.json();
      return { valid: false, error: error.errors?.[0]?.message || 'SendGrid authentication failed' };
    }
  } catch (error) {
    return { valid: false, error: `SendGrid connection failed: ${error.message}` };
  }
}

async function sendViaSendGrid(options) {
  const personalizations = [{
    to: options.to.map(email => ({ email })),
    ...(options.cc.length > 0 && { cc: options.cc.map(email => ({ email })) }),
    ...(options.bcc.length > 0 && { bcc: options.bcc.map(email => ({ email })) })
  }];

  const body = {
    personalizations,
    from: {
      email: options.from,
      name: options.fromName
    },
    reply_to: options.replyTo ? { email: options.replyTo } : undefined,
    subject: options.subject,
    content: [
      ...(options.text ? [{ type: 'text/plain', value: options.text }] : []),
      { type: 'text/html', value: options.html }
    ],
    attachments: options.attachments.length > 0 ? options.attachments.map(a => ({
      filename: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(a.content).toString('base64'),
      type: a.contentType
    })) : undefined
  };

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.errors?.[0]?.message || 'SendGrid send failed');
  }

  return {
    messageId: response.headers.get('x-message-id') || `sg_${Date.now()}`,
    status: 'sent'
  };
}

// ============================================
// Mailjet Provider
// ============================================

async function validateMailjet() {
  try {
    const auth = Buffer.from(`${MAILJET_API_KEY}:${MAILJET_SECRET_KEY}`).toString('base64');
    const response = await fetch('https://api.mailjet.com/v3/REST/sender', {
      headers: {
        'Authorization': `Basic ${auth}`
      }
    });
    if (response.ok) {
      return { valid: true };
    } else {
      const error = await response.json();
      return { valid: false, error: error.ErrorMessage || 'Mailjet authentication failed' };
    }
  } catch (error) {
    return { valid: false, error: `Mailjet connection failed: ${error.message}` };
  }
}

async function sendViaMailjet(options) {
  const auth = Buffer.from(`${MAILJET_API_KEY}:${MAILJET_SECRET_KEY}`).toString('base64');

  const body = {
    Messages: [{
      From: {
        Email: options.from,
        Name: options.fromName
      },
      To: options.to.map(email => ({ Email: email })),
      Cc: options.cc.length > 0 ? options.cc.map(email => ({ Email: email })) : undefined,
      Bcc: options.bcc.length > 0 ? options.bcc.map(email => ({ Email: email })) : undefined,
      ReplyTo: options.replyTo ? { Email: options.replyTo } : undefined,
      Subject: options.subject,
      HTMLPart: options.html,
      TextPart: options.text,
      Attachments: options.attachments.length > 0 ? options.attachments.map(a => ({
        Filename: a.filename,
        ContentType: a.contentType || 'application/octet-stream',
        Base64Content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(a.content).toString('base64')
      })) : undefined
    }]
  };

  const response = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.ErrorMessage || 'Mailjet send failed');
  }

  const result = await response.json();
  return {
    messageId: result.Messages?.[0]?.To?.[0]?.MessageID || `mj_${Date.now()}`,
    status: 'sent'
  };
}

// ============================================
// Postmark Provider
// ============================================

async function validatePostmark() {
  try {
    const response = await fetch('https://api.postmarkapp.com/server', {
      headers: {
        'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
        'Accept': 'application/json'
      }
    });
    if (response.ok) {
      return { valid: true };
    } else {
      const error = await response.json();
      return { valid: false, error: error.Message || 'Postmark authentication failed' };
    }
  } catch (error) {
    return { valid: false, error: `Postmark connection failed: ${error.message}` };
  }
}

async function sendViaPostmark(options) {
  const body = {
    From: options.fromName ? `${options.fromName} <${options.from}>` : options.from,
    To: options.to.join(', '),
    Cc: options.cc.length > 0 ? options.cc.join(', ') : undefined,
    Bcc: options.bcc.length > 0 ? options.bcc.join(', ') : undefined,
    ReplyTo: options.replyTo,
    Subject: options.subject,
    HtmlBody: options.html,
    TextBody: options.text,
    Attachments: options.attachments.length > 0 ? options.attachments.map(a => ({
      Name: a.filename,
      ContentType: a.contentType || 'application/octet-stream',
      Content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : Buffer.from(a.content).toString('base64')
    })) : undefined
  };

  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'X-Postmark-Server-Token': POSTMARK_SERVER_TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.Message || 'Postmark send failed');
  }

  const result = await response.json();
  return {
    messageId: result.MessageID || `pm_${Date.now()}`,
    status: 'sent'
  };
}

// ============================================
// AWS SES Provider
// ============================================

async function validateSes() {
  // SES validation would use AWS SDK
  // For now, just check if credentials are present
  if (SES_CONFIG.region && SES_CONFIG.accessKeyId && SES_CONFIG.secretAccessKey) {
    return { valid: true };
  }
  return { valid: false, error: 'AWS SES credentials not configured' };
}

async function sendViaSES(options) {
  // SES implementation would use AWS SDK
  // This is a placeholder - in production, use @aws-sdk/client-ses
  throw new Error('AWS SES provider requires @aws-sdk/client-ses package. Install it with: npm install @aws-sdk/client-ses');
}

// ============================================
// Exports
// ============================================

/**
 * Reload email configuration from process.env
 * Call after updating .env and re-reading env vars
 */
export function reloadConfig() {
  EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'smtp';
  DEFAULT_FROM = process.env.EMAIL_FROM || 'notifications@cavendo.local';
  DEFAULT_FROM_NAME = process.env.EMAIL_FROM_NAME || 'Cavendo';
  SMTP_CONFIG = {
    host: process.env.EMAIL_SMTP_HOST,
    port: parseInt(process.env.EMAIL_SMTP_PORT || '587'),
    secure: process.env.EMAIL_SMTP_SECURE === 'true',
    auth: process.env.EMAIL_SMTP_USER ? {
      user: process.env.EMAIL_SMTP_USER,
      pass: process.env.EMAIL_SMTP_PASS
    } : undefined
  };
  SENDGRID_API_KEY = process.env.EMAIL_SENDGRID_API_KEY;
  MAILJET_API_KEY = process.env.EMAIL_MAILJET_API_KEY;
  MAILJET_SECRET_KEY = process.env.EMAIL_MAILJET_SECRET_KEY;
  POSTMARK_SERVER_TOKEN = process.env.EMAIL_POSTMARK_SERVER_TOKEN;
  SES_CONFIG = {
    region: process.env.EMAIL_SES_REGION,
    accessKeyId: process.env.EMAIL_SES_ACCESS_KEY_ID,
    secretAccessKey: process.env.EMAIL_SES_SECRET_ACCESS_KEY
  };
  // Reset SMTP transporter so it's recreated with new config
  smtpTransporter = null;
  console.log('[EmailProvider] Configuration reloaded');
}

export default {
  isConfigured,
  validateConfig,
  sendEmail,
  reloadConfig
};

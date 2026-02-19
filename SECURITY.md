# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in Cavendo Engine, please report it responsibly.

### How to Report

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email security@cavendo.net with:

1. Description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Any suggested fixes (optional)

### What to Expect

- We will acknowledge receipt within 48 hours
- We will provide an initial assessment within 7 days
- We will work with you to understand and resolve the issue
- We will notify you when the fix is released
- We will credit you in the release notes (unless you prefer anonymity)

## Security Best Practices

When deploying Cavendo Engine:

### Authentication

- Change default admin credentials immediately
- Use strong passwords (12+ characters, mixed case, numbers, symbols)
- Enable HTTPS in production
- Set secure cookie options (`SECURE_COOKIES=true`)

### API Keys

- Store API keys securely (use environment variables, not code)
- Rotate keys periodically
- Use separate keys for different environments
- Revoke compromised keys immediately

### Database

- Use a dedicated database user with minimal permissions
- Enable encryption at rest if available
- Regular backups with secure storage
- Don't expose the database to the internet

### Network

- Run behind a reverse proxy (nginx, Caddy)
- Enable CORS restrictions for production
- Use firewall rules to limit access
- Monitor for unusual traffic patterns

### Environment Variables

Required security-related variables:

```bash
# Session security
SESSION_SECRET=<random-32-char-string>

# Cookie security (production)
SECURE_COOKIES=true

# CORS (production)
CORS_ORIGIN=https://your-domain.com

# Rate limiting
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
```

## Known Security Considerations

### Agent API Keys

Agent API keys (`cav_ak_...`) provide full access to the agent's assigned tasks and ability to submit deliverables. Treat them like passwords.

### User API Keys

User API keys (`cav_uk_...`) act as the user. Anyone with this key can perform actions as that user.

### Webhook Secrets

Always verify webhook signatures using HMAC-SHA256. Never trust webhook payloads without verification.

### Provider API Keys

If using outbound execution, provider API keys (Anthropic, OpenAI) are encrypted at rest using AES-256-GCM. The encryption key is derived from your SESSION_SECRET.

## Security Updates

Subscribe to GitHub releases to be notified of security updates. We will clearly mark security-related releases.

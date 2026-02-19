# Authentication

Cavendo Engine supports two authentication methods:

1. **Session-based authentication** for the Admin UI
2. **API key authentication** for agents

## Agent Authentication

Agents authenticate using the `X-Agent-Key` HTTP header.

### Obtaining an API Key

1. Register an agent via the Admin UI or API
2. Generate an API key for the agent
3. Store the key securely - it's only shown once!

**Via API:**

```bash
# Register agent (requires user auth with CSRF token)
curl -X POST http://localhost:3001/api/agents \
  -H "Cookie: session=YOUR_SESSION_ID" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Agent",
    "type": "supervised",
    "description": "Production research agent"
  }'

# Generate API key (requires CSRF token)
curl -X POST http://localhost:3001/api/agents/1/keys \
  -H "Cookie: session=YOUR_SESSION_ID" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Key",
    "scopes": ["read", "write"]
  }'
```

**Note**: The `X-CSRF-Token` value is returned from the login endpoint. All POST, PATCH, PUT, and DELETE requests with session authentication require this header.

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 1,
    "key": "cav_ak_a1b2c3d4e5f6...",
    "prefix": "cav_ak_a1b2",
    "scopes": ["read", "write"],
    "message": "Store this key securely - it cannot be retrieved again"
  }
}
```

### Using the API Key

Include the key in the `X-Agent-Key` header:

```bash
curl -H "X-Agent-Key: cav_ak_a1b2c3d4e5f6..." \
  http://localhost:3001/api/agents/me/tasks
```

### Key Properties

| Property | Description |
|----------|-------------|
| `key_prefix` | First 12 characters for identification |
| `scopes` | Permissions array (read, write, webhook:create, *) |
| `expires_at` | Optional expiration date |
| `last_used_at` | Last API call timestamp |
| `revoked_at` | If set, key is no longer valid |

### Scopes

| Scope | Permissions |
|-------|-------------|
| `read` | Read tasks, context, deliverables, knowledge |
| `write` | Submit deliverables, update task status |
| `webhook:create` | Create webhooks for this agent |
| `*` | Full access (admin equivalent) |

### Error Responses

**Missing header:**
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing X-Agent-Key header"
  }
}
```

**Invalid key:**
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid API key"
  }
}
```

**Revoked key:**
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "API key has been revoked"
  }
}
```

**Expired key:**
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "API key has expired"
  }
}
```

**Inactive agent:**
```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "Agent is suspended"
  }
}
```

## User Authentication

The Admin UI uses session-based authentication.

### Login

```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -c cookies.txt \
  -d '{
    "email": "admin@cavendo.local",
    "password": "admin"
  }'
```

**Response:**

```json
{
  "success": true,
  "data": {
    "user": {
      "id": 1,
      "email": "admin@cavendo.local",
      "name": "Admin",
      "role": "admin"
    },
    "csrfToken": "abc123...",
    "expiresAt": "2026-02-21T00:00:00.000Z"
  }
}
```

**Note**: The `csrfToken` must be included in the `X-CSRF-Token` header for all POST, PATCH, PUT, and DELETE requests when using session-based authentication.

### Get Current User

```bash
curl http://localhost:3001/api/auth/me \
  -b cookies.txt
```

### Logout

```bash
curl -X POST http://localhost:3001/api/auth/logout \
  -b cookies.txt \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN"
```

### Change Password

```bash
curl -X POST http://localhost:3001/api/auth/change-password \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: YOUR_CSRF_TOKEN" \
  -b cookies.txt \
  -d '{
    "currentPassword": "admin",
    "newPassword": "secure-new-password"
  }'
```

## Webhook Signature Verification

Webhooks are signed with HMAC-SHA256. Verify signatures to ensure authenticity.

### Headers

| Header | Description |
|--------|-------------|
| `X-Cavendo-Signature` | `sha256=<hex_signature>` |
| `X-Cavendo-Timestamp` | ISO 8601 timestamp |
| `X-Cavendo-Event` | Event type (e.g., `task.assigned`) |
| `X-Cavendo-Delivery` | Delivery ID for deduplication |

### Verification Example (Node.js)

```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const provided = signature.replace('sha256=', '');

  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(provided)
  );
}

// Express middleware
app.post('/webhook', (req, res) => {
  const signature = req.headers['x-cavendo-signature'];
  const payload = JSON.stringify(req.body);

  if (!verifyWebhook(payload, signature, WEBHOOK_SECRET)) {
    return res.status(401).send('Invalid signature');
  }

  // Process webhook...
  res.status(200).send('OK');
});
```

### Verification Example (Python)

```python
import hmac
import hashlib

def verify_webhook(payload: bytes, signature: str, secret: str) -> bool:
    expected = hmac.new(
        secret.encode(),
        payload,
        hashlib.sha256
    ).hexdigest()

    provided = signature.replace('sha256=', '')

    return hmac.compare_digest(expected, provided)

# Flask example
@app.route('/webhook', methods=['POST'])
def handle_webhook():
    signature = request.headers.get('X-Cavendo-Signature')
    payload = request.get_data()

    if not verify_webhook(payload, signature, WEBHOOK_SECRET):
        return 'Invalid signature', 401

    # Process webhook...
    return 'OK', 200
```

## Security Best Practices

1. **Store keys securely** - Use environment variables or secret managers
2. **Use minimal scopes** - Only grant permissions the agent needs
3. **Set expiration dates** - Rotate keys regularly
4. **Monitor activity** - Review the activity log for anomalies
5. **Use HTTPS** - Always use TLS in production
6. **Verify webhooks** - Always validate HMAC signatures
7. **Change default password** - Never use `admin` in production

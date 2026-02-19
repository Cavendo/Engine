const API_BASE = '/api';

class ApiError extends Error {
  constructor(message, status, code, detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail || null;
  }
}

/**
 * Get CSRF token from cookie
 */
function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Store CSRF token (from login response) in memory as fallback
 */
let storedCsrfToken = null;

function setCsrfToken(token) {
  storedCsrfToken = token;
}

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const method = options.method || 'GET';

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  // Add CSRF token for state-changing requests
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    const csrfToken = getCsrfToken() || storedCsrfToken;
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
  }

  const config = {
    ...options,
    method,
    headers,
    credentials: 'include'
  };

  if (options.body && typeof options.body === 'object') {
    config.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, config);
  const data = await response.json();

  if (!response.ok) {
    throw new ApiError(
      data.error?.message || 'Request failed',
      response.status,
      data.error?.code,
      data.error?.detail
    );
  }

  return data.data;
}

export const api = {
  // Auth
  auth: {
    login: async (email, password) => {
      const result = await request('/auth/login', { method: 'POST', body: { email, password } });
      // Store CSRF token from login response
      if (result.csrfToken) {
        setCsrfToken(result.csrfToken);
      }
      return result;
    },
    logout: () => {
      storedCsrfToken = null;
      return request('/auth/logout', { method: 'POST' });
    },
    me: () => request('/auth/me'),
    refreshCsrf: async () => {
      const result = await request('/auth/csrf');
      if (result.csrfToken) {
        setCsrfToken(result.csrfToken);
      }
      return result;
    },
    changePassword: (currentPassword, newPassword) =>
      request('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } })
  },

  // Agents
  agents: {
    list: () => request('/agents'),
    get: (id) => request(`/agents/${id}`),
    create: (data) => request('/agents', { method: 'POST', body: data }),
    update: (id, data) => request(`/agents/${id}`, { method: 'PATCH', body: data }),
    delete: (id) => request(`/agents/${id}`, { method: 'DELETE' }),
    generateKey: (id, data) => request(`/agents/${id}/keys`, { method: 'POST', body: data }),
    revokeKey: (agentId, keyId) => request(`/agents/${agentId}/keys/${keyId}`, { method: 'DELETE' }),
    generateWebhookSecret: (id) => request(`/agents/${id}/webhook-secret`, { method: 'POST' }),
    updateExecution: (id, data) => request(`/agents/${id}/execution`, { method: 'PATCH', body: data }),
    setOwner: (id, userId) => request(`/agents/${id}/owner`, { method: 'PUT', body: { userId } }),
    getMetrics: (id, params) => request(`/agents/${id}/metrics?${new URLSearchParams(params || {})}`)
  },

  // Users
  users: {
    list: () => request('/users'),
    get: (id) => request(`/users/${id}`),
    create: (data) => request('/users', { method: 'POST', body: data }),
    update: (id, data) => request(`/users/${id}`, { method: 'PATCH', body: data }),
    delete: (id) => request(`/users/${id}`, { method: 'DELETE' }),
    resetPassword: (id, password) => request(`/users/${id}/reset-password`, { method: 'POST', body: { password } })
  },

  // Tasks
  tasks: {
    list: (params) => request(`/tasks?${new URLSearchParams(params)}`),
    get: (id) => request(`/tasks/${id}`),
    create: (data) => request('/tasks', { method: 'POST', body: data }),
    update: (id, data) => request(`/tasks/${id}`, { method: 'PATCH', body: data }),
    delete: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),
    getContext: (id) => request(`/tasks/${id}/context`),
    execute: (id) => request(`/tasks/${id}/execute`, { method: 'POST' })
  },

  // Deliverables
  deliverables: {
    list: (params) => request(`/deliverables?${new URLSearchParams(params)}`),
    pending: () => request('/deliverables/pending'),
    get: (id) => request(`/deliverables/${id}`),
    review: (id, decision, feedback) =>
      request(`/deliverables/${id}/review`, { method: 'PATCH', body: { decision, feedback } })
  },

  // Projects
  projects: {
    list: (params) => request(`/projects?${new URLSearchParams(params || {})}`),
    get: (id) => request(`/projects/${id}`),
    create: (data) => request('/projects', { method: 'POST', body: data }),
    update: (id, data) => request(`/projects/${id}`, { method: 'PATCH', body: data }),
    delete: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
    getKnowledge: (id, params) => request(`/projects/${id}/knowledge?${new URLSearchParams(params || {})}`),
    getRoutingRules: (id) => request(`/projects/${id}/routing-rules`),
    updateRoutingRules: (id, data) => request(`/projects/${id}/routing-rules`, { method: 'PUT', body: data }),
    testRoutingRules: (id, data) => request(`/projects/${id}/routing-rules/test`, { method: 'POST', body: data })
  },

  // Knowledge
  knowledge: {
    list: (params) => request(`/knowledge?${new URLSearchParams(params || {})}`),
    get: (id) => request(`/knowledge/${id}`),
    create: (data) => request('/knowledge', { method: 'POST', body: data }),
    update: (id, data) => request(`/knowledge/${id}`, { method: 'PATCH', body: data }),
    delete: (id) => request(`/knowledge/${id}`, { method: 'DELETE' }),
    search: (params) => request(`/knowledge/search?${new URLSearchParams(params)}`)
  },

  // Webhooks
  webhooks: {
    list: (params) => request(`/webhooks?${new URLSearchParams(params || {})}`),
    get: (id) => request(`/webhooks/${id}`),
    create: (data) => request('/webhooks', { method: 'POST', body: data }),
    update: (id, data) => request(`/webhooks/${id}`, { method: 'PATCH', body: data }),
    delete: (id) => request(`/webhooks/${id}`, { method: 'DELETE' }),
    rotateSecret: (id) => request(`/webhooks/${id}/rotate-secret`, { method: 'POST' }),
    getDeliveries: (id, params) => request(`/webhooks/${id}/deliveries?${new URLSearchParams(params || {})}`),
    retryDelivery: (webhookId, deliveryId) =>
      request(`/webhooks/${webhookId}/deliveries/${deliveryId}/retry`, { method: 'POST' })
  },

  // Delivery Routes
  routes: {
    listForProject: (projectId) => request(`/projects/${projectId}/routes`),
    listGlobal: () => request('/routes/global'),
    get: (id) => request(`/routes/${id}`),
    create: (projectId, data) => request(`/projects/${projectId}/routes`, { method: 'POST', body: data }),
    createGlobal: (data) => request('/routes/global', { method: 'POST', body: data }),
    update: (id, data) => request(`/routes/${id}`, { method: 'PUT', body: data }),
    delete: (id) => request(`/routes/${id}`, { method: 'DELETE' }),
    test: (id) => request(`/routes/${id}/test`, { method: 'POST' }),
    getLogs: (id, params) => request(`/routes/${id}/logs?${new URLSearchParams(params || {})}`),
    retryLog: (id, logId) => request(`/routes/${id}/logs/${logId}/retry`, { method: 'POST' })
  },

  // Storage Connections
  connections: {
    list: () => request('/storage-connections'),
    create: (data) => request('/storage-connections', { method: 'POST', body: data }),
    update: (id, data) => request(`/storage-connections/${id}`, { method: 'PUT', body: data }),
    delete: (id) => request(`/storage-connections/${id}`, { method: 'DELETE' }),
    test: (id) => request(`/storage-connections/${id}/test`, { method: 'POST' })
  },

  // User Keys
  userKeys: {
    list: () => request('/users/me/keys'),
    generate: (data) => request('/users/me/keys', { method: 'POST', body: data }),
    revoke: (keyId) => request(`/users/me/keys/${keyId}`, { method: 'DELETE' })
  },

  // Settings
  settings: {
    getEmail: () => request('/settings/email'),
    updateEmail: (data) => request('/settings/email', { method: 'POST', body: data }),
    testEmail: (to) => request('/settings/email/test', { method: 'POST', body: { to } }),
    getDispatcher: () => request('/settings/dispatcher'),
    getModels: () => request('/settings/models')
  },

  // Activity
  activity: {
    list: (params) => request(`/activity?${new URLSearchParams(params || {})}`),
    stats: (params) => request(`/activity/stats?${new URLSearchParams(params || {})}`),
    forAgent: (id, params) => request(`/activity/agents/${id}?${new URLSearchParams(params || {})}`)
  }
};

export { ApiError };

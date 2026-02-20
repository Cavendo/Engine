import { z } from 'zod';
import dns from 'dns/promises';

// ============================================
// Common Schemas
// ============================================

export const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'ID must be a number').transform(Number)
});

export const paginationSchema = z.object({
  limit: z.string().regex(/^\d+$/).transform(Number).default('100'),
  offset: z.string().regex(/^\d+$/).transform(Number).default('0')
}).partial();

// ============================================
// Auth Schemas
// ============================================

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required')
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters')
});

// ============================================
// Agent Schemas
// ============================================

export const createAgentSchema = z.preprocess((data) => {
  // Normalize snake_case aliases → camelCase for execution fields
  if (data && typeof data === 'object') {
    const d = { ...data };
    if ('provider_api_key' in d && !('providerApiKey' in d)) d.providerApiKey = d.provider_api_key;
    if ('provider_model' in d && !('providerModel' in d)) d.providerModel = d.provider_model;
    if ('execution_mode' in d && !('executionMode' in d)) d.executionMode = d.execution_mode;
    if ('system_prompt' in d && !('systemPrompt' in d)) d.systemPrompt = d.system_prompt;
    if ('max_tokens' in d && !('maxTokens' in d)) d.maxTokens = d.max_tokens;
    // Also normalize 'model' shorthand → providerModel
    if ('model' in d && !('providerModel' in d)) d.providerModel = d.model;
    // Clean up snake_case keys so strict validation doesn't reject them
    delete d.provider_api_key;
    delete d.provider_model;
    delete d.execution_mode;
    delete d.system_prompt;
    delete d.max_tokens;
    delete d.model;
    return d;
  }
  return data;
}, z.object({
  name: z.string().min(1, 'Name is required').max(255),
  type: z.enum(['autonomous', 'semi-autonomous', 'supervised'], {
    errorMap: () => ({ message: 'Type must be autonomous, semi-autonomous, or supervised' })
  }),
  description: z.string().max(1000).optional().nullable(),
  capabilities: z.array(z.string().max(50)).max(20).optional().default([]),
  specializations: z.record(z.any()).optional().nullable(), // JSON object for rich metadata
  metadata: z.record(z.any()).optional().nullable(), // JSON object for custom extensions
  maxConcurrentTasks: z.number().int().min(1).max(100).optional().default(1),
  // Agent routing fields
  agentType: z.enum(['business_line', 'skill_agent', 'general']).optional().default('general'),
  specialization: z.string().max(100).optional().nullable(), // e.g., 'boardsite', 'seo', 'research'
  projectAccess: z.array(z.string().max(100)).optional().default(['*']), // Project names/ids or '*' for all
  taskTypes: z.array(z.string().max(50)).optional().default(['*']), // Task types this agent handles
  // Optional execution fields (one-step create with provider config)
  provider: z.enum(['anthropic', 'openai']).optional().nullable(),
  providerApiKey: z.string().optional(),
  providerModel: z.string().max(100).optional().nullable(),
  systemPrompt: z.string().max(50000).optional().nullable(),
  executionMode: z.enum(['manual', 'auto', 'polling', 'human']).optional(),
  maxTokens: z.number().int().min(1).max(200000).optional(),
  temperature: z.number().min(0).max(2).optional()
}));

export const updateAgentSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: z.enum(['autonomous', 'semi-autonomous', 'supervised']).optional(),
  description: z.string().max(1000).optional().nullable(),
  capabilities: z.array(z.string().max(50)).max(20).optional(),
  specializations: z.record(z.any()).optional().nullable(), // JSON object for rich metadata
  metadata: z.record(z.any()).optional().nullable(), // JSON object for custom extensions
  status: z.enum(['active', 'paused', 'disabled']).optional(), // Match schema: active, paused, disabled
  webhookUrl: z.string().url().optional().nullable(),
  webhookEvents: z.array(z.string()).optional(),
  maxConcurrentTasks: z.number().int().min(1).max(100).optional(),
  // New agent routing fields
  agentType: z.enum(['business_line', 'skill_agent', 'general']).optional(),
  specialization: z.string().max(100).optional().nullable(),
  projectAccess: z.array(z.string().max(100)).optional(),
  taskTypes: z.array(z.string().max(50)).optional()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided'
});

export const generateKeySchema = z.object({
  name: z.string().max(100).optional().nullable(),
  scopes: z.array(z.enum(['read', 'write', 'webhook:create', '*'])).optional().default(['read', 'write']),
  expiresAt: z.string().datetime().optional().nullable()
});

export const updateAgentOwnerSchema = z.object({
  userId: z.number().int().positive().nullable()
});

export const updateAgentExecutionSchema = z.object({
  provider: z.enum(['anthropic', 'openai']).optional().nullable(),
  providerApiKey: z.string().optional(),
  providerModel: z.string().max(100).optional().nullable(),
  systemPrompt: z.string().max(50000).optional().nullable(),
  executionMode: z.enum(['manual', 'auto', 'polling', 'human']).optional(),
  maxTokens: z.number().int().min(1).max(200000).optional(),
  temperature: z.number().min(0).max(2).optional()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided'
});

export const createUserSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().max(100).optional(),
  role: z.enum(['admin', 'reviewer', 'viewer']).optional().default('reviewer')
});

export const updateUserSchema = z.object({
  email: z.string().email('Invalid email address').optional(),
  name: z.string().max(100).optional().nullable(),
  role: z.enum(['admin', 'reviewer', 'viewer']).optional(),
  status: z.enum(['active', 'inactive']).optional()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided'
});

export const createUserKeySchema = z.object({
  name: z.string().max(100).optional().nullable()
});

export const updateUserKeySchema = z.object({
  name: z.string().max(100).nullable()
});

export const matchAgentsSchema = z.object({
  tags: z.array(z.string().max(50)).optional().default([]),
  priority: z.number().int().min(1).max(4).optional(),
  metadata: z.record(z.any()).optional().default({})
});

// ============================================
// Task Schemas
// ============================================

export const createTaskSchema = z.object({
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().max(10000).optional().nullable(),
  projectId: z.number().int().positive().optional().nullable(),
  sprintId: z.number().int().positive().optional().nullable(),
  assignedAgentId: z.union([z.number().int().positive(), z.literal('auto')]).optional().nullable(),
  priority: z.number().int().min(1).max(4).optional().default(2),
  tags: z.array(z.string().max(50)).max(20).optional().default([]), // For routing rules matching
  context: z.record(z.any()).optional().default({}),
  dueDate: z.string().datetime().optional().nullable(),
  // New task routing fields
  taskType: z.string().max(50).optional().nullable(), // e.g., 'research', 'content', 'support'
  requiredCapabilities: z.array(z.string().max(50)).max(20).optional().default([]), // Capabilities needed
  preferredAgentId: z.number().int().positive().optional().nullable() // Preferred agent for this task
});

export const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional().nullable(),
  projectId: z.number().int().positive().optional().nullable(),
  sprintId: z.number().int().positive().optional().nullable(),
  assignedAgentId: z.union([z.number().int().positive(), z.literal('auto')]).optional().nullable(),
  status: z.enum(['pending', 'assigned', 'in_progress', 'review', 'completed', 'cancelled']).optional(),
  priority: z.number().int().min(1).max(4).optional(),
  context: z.record(z.any()).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  dueDate: z.string().datetime().optional().nullable(),
  // New task routing fields
  taskType: z.string().max(50).optional().nullable(),
  requiredCapabilities: z.array(z.string().max(50)).max(20).optional(),
  preferredAgentId: z.number().int().positive().optional().nullable()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided'
});

export const updateTaskStatusSchema = z.object({
  status: z.enum(['in_progress', 'review'], {
    errorMap: () => ({ message: 'Status must be in_progress or review' })
  }),
  progress: z.any().optional()
});

// Bulk task schemas
export const bulkCreateTasksSchema = z.object({
  tasks: z.array(createTaskSchema).min(1, 'At least one task is required').max(50, 'Maximum 50 tasks per request')
});

export const bulkUpdateTasksSchema = z.object({
  taskIds: z.array(z.number().int().positive()).min(1, 'At least one task ID is required').max(100, 'Maximum 100 tasks per request'),
  updates: z.object({
    status: z.enum(['pending', 'assigned', 'in_progress', 'review', 'completed', 'cancelled']).optional(),
    priority: z.number().int().min(1).max(4).optional(),
    projectId: z.number().int().positive().optional().nullable(),
    sprintId: z.number().int().positive().optional().nullable(),
    assignedAgentId: z.number().int().positive().optional().nullable(),
    dueDate: z.string().datetime().optional().nullable()
  }).refine(data => Object.keys(data).length > 0, {
    message: 'At least one update field must be provided'
  })
});

export const bulkDeleteTasksSchema = z.object({
  taskIds: z.array(z.number().int().positive()).min(1, 'At least one task ID is required').max(100, 'Maximum 100 tasks per request')
});

export const logTaskProgressSchema = z.object({
  message: z.string().min(1, 'Message is required').max(5000),
  percentComplete: z.number().int().min(0).max(100).optional().nullable(),
  details: z.record(z.any()).optional().default({})
});

// ============================================
// Deliverable Schemas
// ============================================

// File attachment schema
const fileAttachmentSchema = z.object({
  filename: z.string().min(1, 'Filename is required'),
  content: z.string().min(1, 'File content is required'),
  mimeType: z.string().optional()
});

// Action item schema
const actionItemSchema = z.object({
  action_text: z.string().min(1, 'Action text is required'),
  estimated_time_minutes: z.number().int().positive().optional().default(25),
  notes: z.string().optional()
});

export const submitDeliverableSchema = z.object({
  taskId: z.number().int().positive().optional(), // Optional - allows standalone deliverables
  projectId: z.union([z.string(), z.number()]).optional(), // Project ID or name (if no taskId)
  title: z.string().min(1, 'Title is required').max(500),
  summary: z.string().max(50000).optional(), // Text summary shown in Overview tab
  content: z.string().max(1000000).optional(), // Main content (optional if files provided)
  contentType: z.enum(['markdown', 'html', 'json', 'text', 'code']).optional().default('markdown'),
  files: z.array(fileAttachmentSchema).optional(), // File attachments
  actions: z.array(actionItemSchema).optional(), // Follow-up action items
  metadata: z.record(z.any()).optional().default({}),
  // Token usage tracking for AI-generated content
  inputTokens: z.number().int().nonnegative().optional(), // Tokens used for input/prompt
  outputTokens: z.number().int().nonnegative().optional(), // Tokens used for output/completion
  provider: z.string().max(50).optional(), // AI provider (anthropic, openai, etc.)
  model: z.string().max(100).optional() // Model used (claude-opus-4, gpt-4o, etc.)
}).refine(
  data => data.summary || data.content || (data.files && data.files.length > 0),
  { message: 'At least one of summary, content, or files is required' }
);

export const submitRevisionSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  summary: z.string().max(50000).optional(), // Text summary shown in Overview tab
  content: z.string().max(1000000).optional(), // Main content (optional if files provided)
  contentType: z.enum(['markdown', 'html', 'json', 'text', 'code']).optional(),
  files: z.array(fileAttachmentSchema).optional(), // File attachments for revisions
  actions: z.array(actionItemSchema).optional(), // Follow-up action items
  metadata: z.record(z.any()).optional()
}).refine(
  data => data.summary || data.content || (data.files && data.files.length > 0),
  { message: 'At least one of summary, content, or files is required' }
);

export const reviewDeliverableSchema = z.object({
  decision: z.enum(['approved', 'revision_requested', 'rejected'], {
    errorMap: () => ({ message: 'Decision must be approved, revision_requested, or rejected' })
  }),
  feedback: z.string().max(10000).optional()
}).refine(
  data => data.decision !== 'revision_requested' || (data.feedback && data.feedback.trim().length > 0),
  { message: 'Feedback is required when requesting revisions', path: ['feedback'] }
);

// ============================================
// Project Schemas
// ============================================

export const createProjectSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().max(2000).optional().nullable()
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional().nullable(),
  status: z.enum(['active', 'archived', 'completed']).optional()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided'
});

// ============================================
// Sprint Schemas
// ============================================

export const createSprintSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  description: z.string().max(2000).optional().nullable(),
  projectId: z.number().int().positive().optional().nullable(),
  status: z.enum(['planning', 'active', 'completed', 'cancelled']).optional().default('planning'),
  startDate: z.string().datetime().optional().nullable(),
  endDate: z.string().datetime().optional().nullable(),
  goal: z.string().max(2000).optional().nullable()
});

export const updateSprintSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional().nullable(),
  projectId: z.number().int().positive().optional().nullable(),
  status: z.enum(['planning', 'active', 'completed', 'cancelled']).optional(),
  startDate: z.string().datetime().optional().nullable(),
  endDate: z.string().datetime().optional().nullable(),
  goal: z.string().max(2000).optional().nullable()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided'
});

export const addTaskToSprintSchema = z.object({
  taskId: z.number().int().positive('Task ID is required')
});

// ============================================
// Knowledge Schemas
// ============================================

export const createKnowledgeSchema = z.object({
  projectId: z.number().int().positive().optional().nullable(),
  title: z.string().min(1, 'Title is required').max(500),
  content: z.string().min(1, 'Content is required').max(500000), // 500KB limit
  contentType: z.enum(['markdown', 'html', 'json', 'text']).optional().default('markdown'),
  category: z.string().max(100).optional().nullable(),
  tags: z.array(z.string().max(50)).max(20).optional().default([])
});

export const updateKnowledgeSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).max(500000).optional(),
  contentType: z.enum(['markdown', 'html', 'json', 'text']).optional(),
  category: z.string().max(100).optional().nullable(),
  tags: z.array(z.string().max(50)).max(20).optional()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided'
});

export const searchKnowledgeSchema = z.object({
  q: z.string().min(1, 'Search query is required').max(200),
  projectId: z.string().regex(/^\d+$/).transform(Number).optional(),
  category: z.string().max(100).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).default('20')
});

// ============================================
// Routing Rules Schemas
// ============================================

// Tag condition schema - matches matchConditions() implementation
const tagConditionSchema = z.object({
  includes_any: z.array(z.string().max(50)).optional(),
  includes_all: z.array(z.string().max(50)).optional()
}).optional();

// Priority condition schema - matches matchConditions() implementation
const priorityConditionSchema = z.object({
  eq: z.number().int().min(1).max(4).optional(),  // Exact match
  gte: z.number().int().min(1).max(4).optional(), // Greater than or equal (lower priority)
  lte: z.number().int().min(1).max(4).optional()  // Less than or equal (higher priority)
}).optional();

// Conditions object that matches taskRouter.matchConditions()
const routingConditionsSchema = z.object({
  tags: tagConditionSchema,
  priority: priorityConditionSchema,
  metadata: z.record(z.any()).optional()  // Key-value pairs to match against task.context
}).optional();

// Single routing rule
const routingRuleSchema = z.object({
  id: z.string().max(100).optional(),
  name: z.string().min(1, 'Rule name is required').max(255),
  conditions: routingConditionsSchema,  // Empty conditions = catch-all rule
  assign_to: z.number().int().positive().optional(),
  assign_to_capability: z.string().max(100).optional(),
  assign_strategy: z.enum(['least_busy', 'round_robin', 'first_available', 'random']).optional(),
  fallback_to: z.number().int().positive().optional().nullable(),
  rule_priority: z.number().int().min(1).max(100).optional().default(50),  // Lower = higher priority
  enabled: z.boolean().optional().default(true)
}).refine(
  data => data.assign_to !== undefined || data.assign_to_capability !== undefined,
  { message: 'Either assign_to (agent ID) or assign_to_capability must be provided' }
);

export const routingRulesSchema = z.object({
  task_routing_rules: z.array(routingRuleSchema).optional().default([]),
  default_agent_id: z.number().int().positive().optional().nullable()
});

export const routingTestSchema = z.object({
  tags: z.array(z.string().max(50)).optional().default([]),
  priority: z.number().int().min(1).max(4).optional().default(2),
  metadata: z.record(z.any()).optional().default({})
});

// ============================================
// Webhook & Route Event Types (single source of truth)
// ============================================

export const TRIGGER_EVENTS = [
  'deliverable.approved',
  'deliverable.submitted',
  'deliverable.revision_requested',
  'deliverable.rejected',
  'task.created',
  'task.assigned',
  'task.completed',
  'task.status_changed',
  'task.overdue',
  'task.updated',
  'task.claimed',
  'task.progress_updated',
  'task.routing_failed',
  'task.execution_failed',
  'review.completed',
  'agent.registered',
  'agent.status_changed',
  'project.created',
  'project.knowledge_updated',
  'knowledge.updated'
];

// Backward compat alias
export const WEBHOOK_EVENTS = TRIGGER_EVENTS;

// ============================================
// Webhook Schemas
// ============================================

export const createWebhookSchema = z.object({
  agentId: z.number().int().positive('Agent ID is required'),
  url: z.string().url('Invalid URL'),
  events: z.array(z.enum(TRIGGER_EVENTS)).min(1, 'At least one event is required')
});

export const updateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.enum(TRIGGER_EVENTS)).min(1).optional(),
  status: z.enum(['active', 'inactive']).optional()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided'
});

// ============================================
// Validation Middleware
// ============================================

/**
 * Create validation middleware for request body
 * @param {z.ZodSchema} schema
 */
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.errors.reduce((acc, err) => {
        const path = err.path.join('.');
        acc[path] = err.message;
        return acc;
      }, {});

      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: result.error.errors[0].message,
          errors
        }
      });
    }
    req.body = result.data;
    next();
  };
}

/**
 * Create validation middleware for query parameters
 * @param {z.ZodSchema} schema
 */
export function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const errors = result.error.errors.reduce((acc, err) => {
        const path = err.path.join('.');
        acc[path] = err.message;
        return acc;
      }, {});

      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: result.error.errors[0].message,
          errors
        }
      });
    }
    req.query = result.data;
    next();
  };
}

/**
 * Create validation middleware for URL parameters
 * @param {z.ZodSchema} schema
 */
export function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_PARAMETER',
          message: result.error.errors[0].message
        }
      });
    }
    req.params = result.data;
    next();
  };
}

// ============================================
// SSRF Protection
// ============================================

/**
 * Validate that a URL endpoint does not target internal/private addresses (VULN-006)
 * @param {string} endpoint
 * @returns {boolean}
 */
// Private IP patterns (shared with webhooks.js SSRF checks)
const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
];

/**
 * Synchronous hostname-level check (used in Zod schema refinements)
 * Catches obvious private/internal hostnames but NOT DNS rebinding.
 * Always pair with validateEndpointWithDns() before making actual connections.
 * @param {string} endpoint
 * @returns {boolean}
 */
export function validateEndpoint(endpoint) {
  if (!endpoint) return true;
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();
    // Block internal hostnames and metadata services
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
        hostname === '0.0.0.0' || hostname.endsWith('.local') ||
        hostname === 'metadata.google.internal' || hostname === '169.254.169.254' ||
        hostname.startsWith('10.') || hostname.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        hostname.startsWith('fd') || hostname.startsWith('fc') ||
        hostname.startsWith('fe80') || hostname === '[::1]') {
      return false;
    }
    // Must be HTTPS in production
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Async endpoint validation with DNS resolution (VULN-006 full fix)
 * Resolves the hostname and checks resolved IPs against private ranges.
 * Call this before making any outbound connection to the endpoint.
 * @param {string} endpoint
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function validateEndpointWithDns(endpoint) {
  if (!endpoint) return { valid: true };

  // First pass: sync hostname check
  if (!validateEndpoint(endpoint)) {
    return { valid: false, reason: 'Endpoint targets an internal or private address' };
  }

  // Second pass: resolve DNS and check IPs
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();

    const ipv4 = await dns.resolve4(hostname).catch(() => []);
    const ipv6 = await dns.resolve6(hostname).catch(() => []);
    const allAddresses = [...ipv4, ...ipv6];

    if (allAddresses.length === 0) {
      return { valid: false, reason: 'Could not resolve hostname' };
    }

    for (const ip of allAddresses) {
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(ip)) {
          return { valid: false, reason: 'Endpoint resolves to private IP' };
        }
      }
      // Block IPv6 loopback and private ranges
      if (ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fd') || ip.startsWith('fc') || ip.startsWith('::ffff:')) {
        return { valid: false, reason: 'Endpoint resolves to private IP' };
      }
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'Invalid endpoint URL' };
  }
}

/**
 * Agent Executor Service
 * Executes tasks using AI provider APIs (Anthropic, OpenAI)
 * Pulls in full task context (knowledge base, deliverables, related tasks)
 * to match the same context available to MCP/external agents.
 */

import db from '../db/connection.js';
import { decrypt } from '../utils/crypto.js';
import { dispatchEvent } from './routeDispatcher.js';

const EXECUTION_TIMEOUT_MS = parseInt(process.env.EXECUTION_TIMEOUT_MS) || 120000;

function parseTags(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON — treat as comma-separated string
  }
  if (typeof raw === 'string') {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Gather the full context bundle for a task.
 * This mirrors what GET /api/tasks/:id/context returns,
 * so server-executed agents get the same information as MCP agents.
 */
function gatherTaskContext(task) {
  // Get project knowledge
  let knowledge = [];
  if (task.project_id) {
    knowledge = db.prepare(`
      SELECT id, title, content, content_type, category, tags
      FROM knowledge
      WHERE project_id = ?
      ORDER BY created_at DESC
    `).all(task.project_id).map(k => ({
      ...k,
      tags: parseTags(k.tags)
    }));
  }

  // Get previous deliverables and feedback (critical for revision tasks)
  const deliverables = db.prepare(`
    SELECT id, title, content, content_type, status, version, feedback, created_at
    FROM deliverables
    WHERE task_id = ?
    ORDER BY version DESC
  `).all(task.id);

  // Get related tasks in the same project
  let relatedTasks = [];
  if (task.project_id) {
    relatedTasks = db.prepare(`
      SELECT id, title, status, priority, description
      FROM tasks
      WHERE project_id = ? AND id != ?
      ORDER BY priority ASC, created_at DESC
      LIMIT 10
    `).all(task.project_id, task.id);
  }

  // Get project details
  let project = null;
  if (task.project_id) {
    project = db.prepare(`
      SELECT id, name, description
      FROM projects
      WHERE id = ?
    `).get(task.project_id);
  }

  return { knowledge, deliverables, relatedTasks, project };
}

/**
 * Execute a task using the agent's configured provider
 * @param {Object} agent - Agent record from database
 * @param {Object} task - Task record from database
 * @returns {Promise<Object>} Execution result
 */
export async function executeTask(agent, task) {
  // Decrypt API key
  let apiKey;
  try {
    apiKey = decrypt(agent.provider_api_key_encrypted, agent.provider_api_key_iv);
  } catch (decryptErr) {
    const err = new Error('Failed to decrypt provider API key — check ENCRYPTION_KEY and re-save the key in agent settings');
    err.category = 'config_error';
    err.retryable = true;
    throw err;
  }
  if (!apiKey) {
    const err = new Error('Failed to decrypt provider API key — check ENCRYPTION_KEY and re-save the key in agent settings');
    err.category = 'config_error';
    err.retryable = true;
    throw err;
  }

  // Update task status to in_progress
  db.prepare(`
    UPDATE tasks
    SET status = 'in_progress', started_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(task.id);

  // Gather full context — same data MCP agents get via cavendo_get_task_context
  const context = gatherTaskContext(task);

  // Build the prompt with full context
  const systemPrompt = agent.system_prompt || getDefaultSystemPrompt(agent);
  const userPrompt = buildTaskPrompt(task, context);

  let result;
  try {
    if (agent.provider === 'anthropic') {
      result = await executeAnthropic(apiKey, agent.provider_model, systemPrompt, userPrompt, agent.max_tokens, agent.temperature);
    } else if (agent.provider === 'openai') {
      result = await executeOpenAI(apiKey, agent.provider_model, systemPrompt, userPrompt, agent.max_tokens, agent.temperature);
    } else {
      throw new Error(`Unsupported provider: ${agent.provider}`);
    }

    // Create deliverable from result with token usage tracking
    const deliverable = createDeliverable(
      task.id,
      agent.id,
      result.content,
      task.title,
      result.usage,
      agent.provider,
      agent.provider_model
    );

    // Update task status
    db.prepare(`
      UPDATE tasks
      SET status = 'review', updated_at = datetime('now')
      WHERE id = ?
    `).run(task.id);

    return {
      success: true,
      deliverableId: deliverable.id,
      content: result.content,
      usage: result.usage
    };
  } catch (error) {
    // Log the error but don't change task status back
    console.error('[AgentExecutor] Execution failed:', error);

    return {
      success: false,
      error: error.message,
      category: error.category || null
    };
  }
}

/**
 * Test provider connection
 * @param {string} provider - Provider name
 * @param {string} apiKey - API key
 * @param {string} model - Model ID
 * @returns {Promise<Object>} Test result
 */
export async function testConnection(provider, apiKey, model) {
  try {
    if (provider === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: model || 'claude-sonnet-4-5-20250929',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }]
        })
      });

      if (response.ok) {
        return { success: true, message: 'Connection successful' };
      } else {
        const error = await response.json();
        return { success: false, message: error.error?.message || 'Connection failed' };
      }
    } else if (provider === 'openai') {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model || 'gpt-4o',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }]
        })
      });

      if (response.ok) {
        return { success: true, message: 'Connection successful' };
      } else {
        const error = await response.json();
        return { success: false, message: error.error?.message || 'Connection failed' };
      }
    } else {
      return { success: false, message: `Unsupported provider: ${provider}` };
    }
  } catch (error) {
    return { success: false, message: error.message || 'Network error' };
  }
}

/**
 * Classify an API error by status code and error body.
 * Returns an Error with category, status, and retryable properties.
 */
function classifyApiError(status, errorBody, provider) {
  const message = errorBody?.error?.message || 'Unknown API error';
  const code = errorBody?.error?.code || errorBody?.error?.type || '';

  let category = 'unknown';
  if (status === 401 || code === 'invalid_api_key' || code === 'authentication_error') {
    category = 'auth_error';
  } else if (status === 403 || code === 'insufficient_quota' || message.toLowerCase().includes('billing')) {
    category = 'quota_exceeded';
  } else if (status === 429 || code === 'rate_limit_exceeded') {
    category = 'rate_limited';
  } else if (status === 529 || status === 503 || code === 'overloaded_error') {
    category = 'overloaded';
  } else if (status === 400) {
    category = 'bad_request';
  }

  const err = new Error(`[${provider}] ${message}`);
  err.category = category;
  err.status = status;
  err.retryable = ['rate_limited', 'overloaded'].includes(category);
  return err;
}

/**
 * Execute using Anthropic API
 */
async function executeAnthropic(apiKey, model, systemPrompt, userPrompt, maxTokens, temperature) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXECUTION_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-5-20250929',
        max_tokens: maxTokens || 4096,
        temperature: temperature ?? 0.7,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw classifyApiError(response.status, error, 'anthropic');
    }

    const data = await response.json();

    return {
      content: data.content[0]?.text || '',
      usage: {
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Execute using OpenAI API
 */
async function executeOpenAI(apiKey, model, systemPrompt, userPrompt, maxTokens, temperature) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXECUTION_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || 'gpt-4o',
        max_tokens: maxTokens || 4096,
        temperature: temperature ?? 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw classifyApiError(response.status, error, 'openai');
    }

    const data = await response.json();

    return {
      content: data.choices[0]?.message?.content || '',
      usage: {
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Get default system prompt for an agent
 */
function getDefaultSystemPrompt(agent) {
  const capabilities = parseTags(agent.capabilities);

  return `You are ${agent.name}, an AI agent working on assigned tasks.
Your capabilities: ${capabilities.join(', ') || 'general assistance'}

When completing tasks:
1. Analyze the task requirements carefully
2. Use the provided project knowledge and context to inform your work
3. If previous deliverables or feedback are included, address the feedback directly
4. Produce a clear, well-structured deliverable in markdown format
5. Include relevant details and explanations
6. Be thorough but concise`;
}

/**
 * Build prompt from task data with full context bundle
 */
function buildTaskPrompt(task, context) {
  let taskContext = {};
  try { taskContext = JSON.parse(task.context || '{}'); } catch { taskContext = {}; }

  let prompt = `# Task: ${task.title}\n\n`;

  if (task.description) {
    prompt += `## Description\n${task.description}\n\n`;
  }

  // Project info
  if (context.project) {
    prompt += `## Project: ${context.project.name}\n`;
    if (context.project.description) {
      prompt += `${context.project.description}\n`;
    }
    prompt += '\n';
  }

  // Project knowledge base
  if (context.knowledge.length > 0) {
    prompt += `## Project Knowledge Base\n`;
    prompt += `The following reference documents are available for this project:\n\n`;
    for (const k of context.knowledge) {
      prompt += `### ${k.title}`;
      if (k.category) prompt += ` (${k.category})`;
      prompt += '\n';
      if (k.content) {
        prompt += `${k.content}\n`;
      }
      prompt += '\n';
    }
  }

  // Previous deliverables and feedback (for revision tasks)
  if (context.deliverables.length > 0) {
    prompt += `## Previous Deliverables\n`;
    prompt += `This task has ${context.deliverables.length} previous deliverable(s). Review any feedback and address it in your response.\n\n`;
    for (const d of context.deliverables) {
      prompt += `### ${d.title} (v${d.version || 1}) — ${d.status}\n`;
      if (d.feedback) {
        prompt += `**Reviewer Feedback:** ${d.feedback}\n\n`;
      }
      if (d.content) {
        // Include previous content but truncate if very long
        const content = d.content.length > 2000
          ? d.content.substring(0, 2000) + '\n\n[... truncated for length ...]\n'
          : d.content;
        prompt += `**Previous Content:**\n${content}\n\n`;
      }
    }
  }

  // Related tasks for broader context
  if (context.relatedTasks.length > 0) {
    prompt += `## Related Tasks in This Project\n`;
    for (const rt of context.relatedTasks) {
      prompt += `- [${rt.status}] ${rt.title}\n`;
    }
    prompt += '\n';
  }

  // Task-level context metadata
  if (Object.keys(taskContext).length > 0) {
    prompt += `## Additional Context\n${JSON.stringify(taskContext, null, 2)}\n\n`;
  }

  prompt += `## Instructions\nPlease complete this task and provide your deliverable below. Format your response in markdown.`;

  return prompt;
}

/**
 * Create deliverable record from execution result.
 * Handles revision linking: if previous deliverables exist for this task,
 * sets parent_id to the most recent one and updates its status to 'revised'.
 */
function createDeliverable(taskId, agentId, content, title, usage, provider, model) {
  // Determine version number and find parent deliverable
  const existing = db.prepare(`
    SELECT id, version FROM deliverables WHERE task_id = ? ORDER BY version DESC LIMIT 1
  `).get(taskId);

  const version = (existing?.version || 0) + 1;
  const parentId = existing?.id || null;

  // Get project_id from the task so route dispatch works on review
  const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(taskId);
  const projectId = task?.project_id || null;

  const result = db.prepare(`
    INSERT INTO deliverables (
      task_id, project_id, agent_id, title, content, content_type, status, version, parent_id,
      input_tokens, output_tokens, provider, model
    )
    VALUES (?, ?, ?, ?, ?, 'markdown', 'pending', ?, ?, ?, ?, ?, ?)
  `).run(
    taskId,
    projectId,
    agentId,
    `Deliverable: ${title}`,
    content,
    version,
    parentId,
    usage?.inputTokens || null,
    usage?.outputTokens || null,
    provider || null,
    model || null
  );

  // If this is a revision, update the parent deliverable status to 'revised'
  if (parentId) {
    db.prepare(`
      UPDATE deliverables SET status = 'revised', updated_at = datetime('now') WHERE id = ?
    `).run(parentId);
  }

  const deliverableId = result.lastInsertRowid;

  // Dispatch deliverable.submitted event for delivery routes
  if (projectId) {
    const project = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId);
    const agent = db.prepare('SELECT id, name FROM agents WHERE id = ?').get(agentId);

    dispatchEvent('deliverable.submitted', {
      project: project ? { id: project.id, name: project.name } : { id: projectId },
      projectId,
      deliverable: {
        id: deliverableId,
        title: `Deliverable: ${title}`,
        content,
        content_type: 'markdown',
        status: 'pending',
        version,
        submitted_by: agent ? { id: agent.id, name: agent.name } : null
      },
      taskId,
      timestamp: new Date().toISOString()
    }).catch(err => console.error('[AgentExecutor] Route dispatch error:', err));
  }

  return {
    id: deliverableId
  };
}

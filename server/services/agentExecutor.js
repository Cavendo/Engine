/**
 * Agent Executor Service
 * Executes tasks using AI provider APIs (Anthropic, OpenAI, Google Gemini)
 * Pulls in full task context (knowledge base, deliverables, related tasks)
 * to match the same context available to MCP/external agents.
 */

import db from '../db/adapter.js';
import { decrypt } from '../utils/crypto.js';
import { dispatchEvent } from './routeDispatcher.js';
import { resolveBaseUrl } from '../utils/providerEndpoint.js';
import { parseSSEStream } from '../utils/sse.js';
import { detectDeliverableContentType } from '../utils/detectDeliverableContentType.js';
import { parseAgentDeliverableEnvelope } from '../utils/agentDeliverableEnvelope.js';
import {
  getMimeType,
  saveDeliverableFile,
  ensureUploadsDir
} from '../utils/deliverableFiles.js';

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

function createExecutionError(message, category = 'unknown', retryable = false, status = null) {
  const err = new Error(message);
  err.category = category;
  err.retryable = retryable;
  if (status !== null && status !== undefined) err.status = status;
  return err;
}

function ensureSupportedProvider(provider) {
  if (!['anthropic', 'google', 'openai', 'openai_compatible'].includes(provider)) {
    throw createExecutionError(`Unsupported provider: ${provider}`, 'config_error', false);
  }
}

function resolveProviderApiKey(agent) {
  if (agent.provider_api_key_encrypted) {
    let apiKey = null;
    try {
      apiKey = decrypt(agent.provider_api_key_encrypted, agent.provider_api_key_iv, agent.encryption_key_version);
    } catch {
      apiKey = null;
    }

    if (apiKey) return apiKey;

    if (agent.provider === 'openai_compatible') {
      // For openai_compatible, API key is optional — continue without it
      console.warn('[AgentExecutor] Could not decrypt API key for openai_compatible agent, proceeding without key');
      return null;
    }

    throw createExecutionError(
      'Failed to decrypt provider API key — check ENCRYPTION_KEY and re-save the key in agent settings',
      'config_error',
      true
    );
  }

  if (agent.provider !== 'openai_compatible') {
    throw createExecutionError('Provider API key not configured', 'config_error', true);
  }

  return null;
}

function getDefaultProviderModel(provider) {
  if (provider === 'anthropic') return 'claude-sonnet-4-5-20250929';
  if (provider === 'google') return 'gemini-2.5-pro';
  return 'gpt-4o';
}

async function executeProviderPrompt(agent, apiKey, systemPrompt, userPrompt, maxTokens, options = {}) {
  ensureSupportedProvider(agent.provider);

  if (agent.provider === 'anthropic') {
    return await executeAnthropic(apiKey, agent.provider_model, systemPrompt, userPrompt, maxTokens, agent.temperature, options);
  }
  if (agent.provider === 'google') {
    return await executeGoogle(apiKey, agent.provider_model, systemPrompt, userPrompt, maxTokens, agent.temperature, options);
  }

  const baseUrl = resolveBaseUrl(agent);
  return await executeOpenAI(apiKey, agent.provider_model, systemPrompt, userPrompt, maxTokens, agent.temperature, baseUrl, options);
}

function stringifyDirectContext(context) {
  if (context === null || context === undefined) return null;

  if (typeof context === 'string') {
    try {
      JSON.parse(context);
      return context;
    } catch {
      return JSON.stringify({ context });
    }
  }

  return JSON.stringify(context);
}

function createDirectPromptTask(options) {
  return {
    id: 0,
    title: options.title || 'Direct prompt',
    description: options.description || '',
    project_id: options.projectId ?? options.project_id ?? null,
    context: stringifyDirectContext(options.context)
  };
}

function safeCallDelta(options, text) {
  if (!text || typeof options.onDelta !== 'function') return;
  try {
    options.onDelta(text);
  } catch (err) {
    console.warn('[AgentExecutor] onDelta callback failed:', err?.message || err);
  }
}

function hasDeltaCallback(options) {
  return typeof options?.onDelta === 'function';
}

function parseStreamJson(data, provider) {
  try {
    return JSON.parse(data);
  } catch {
    throw createExecutionError(`[${provider}] malformed stream JSON`, 'unknown', true);
  }
}

function createUnexpectedStreamEndError(provider) {
  return createExecutionError(`[${provider}] stream ended unexpectedly`, 'unknown', true);
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function createStreamingAbortController(options = {}) {
  const controller = new AbortController();
  let abortReason = null;
  let timeout = null;

  const resetIdleTimeout = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      if (!controller.signal.aborted) {
        abortReason = 'timeout';
        controller.abort();
      }
    }, EXECUTION_TIMEOUT_MS);
  };

  resetIdleTimeout();

  const externalSignal = options.signal;
  let externalAbortHandler = null;
  if (externalSignal) {
    externalAbortHandler = () => {
      if (!controller.signal.aborted) {
        abortReason = 'cancelled';
        controller.abort();
      }
    };

    if (externalSignal.aborted) {
      externalAbortHandler();
    } else {
      externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  return {
    signal: controller.signal,
    resetIdleTimeout,
    getAbortReason: () => abortReason,
    cleanup: () => {
      if (timeout) clearTimeout(timeout);
      if (externalSignal && externalAbortHandler) {
        externalSignal.removeEventListener('abort', externalAbortHandler);
      }
    }
  };
}

function normalizeStreamingAbort(error, provider, abortReason) {
  if (!isAbortError(error)) return error;
  if (abortReason === 'cancelled') {
    return createExecutionError(`[${provider}] stream cancelled`, 'cancelled', false);
  }
  return createExecutionError(`[${provider}] stream timed out`, 'timeout', true);
}

/**
 * Gather the full context bundle for a task.
 * This mirrors what GET /api/tasks/:id/context returns,
 * so server-executed agents get the same information as MCP agents.
 */
async function gatherTaskContext(task) {
  // Get project knowledge
  let knowledge = [];
  if (task.project_id) {
    const rows = await db.many(`
      SELECT id, title, content, content_type, category, tags
      FROM knowledge
      WHERE project_id = ?
      ORDER BY created_at DESC
    `, [task.project_id]);
    knowledge = rows.map(k => ({
      ...k,
      tags: parseTags(k.tags)
    }));
  }

  // Get previous deliverables and feedback (critical for revision tasks)
  const deliverables = await db.many(`
    SELECT id, title, content, content_type, status, version, feedback, created_at
    FROM deliverables
    WHERE task_id = ?
    ORDER BY version DESC
  `, [task.id]);

  // Get related tasks in the same project
  let relatedTasks = [];
  if (task.project_id) {
    relatedTasks = await db.many(`
      SELECT id, title, status, priority, description
      FROM tasks
      WHERE project_id = ? AND id != ?
      ORDER BY priority ASC, created_at DESC
      LIMIT 10
    `, [task.project_id, task.id]);
  }

  // Get project details
  let project = null;
  if (task.project_id) {
    project = await db.one(`
      SELECT id, name, description
      FROM projects
      WHERE id = ?
    `, [task.project_id]);
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
  let result;
  try {
    ensureSupportedProvider(agent.provider);
    const apiKey = resolveProviderApiKey(agent);

    // Update task status to in_progress
    await db.exec(`
      UPDATE tasks
      SET status = 'in_progress', started_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `, [task.id]);

    // Gather full context — same data MCP agents get via cavendo_get_task_context
    const context = await gatherTaskContext(task);

    // Build the prompt with full context
    const systemPrompt = agent.system_prompt || getDefaultSystemPrompt(agent);
    const userPrompt = buildTaskPrompt(task, context);

    result = await executeProviderPrompt(agent, apiKey, systemPrompt, userPrompt, agent.max_tokens);

    // Parse envelope or detect content type
    const envelope = parseAgentDeliverableEnvelope(result.content);

    let deliverableContent;
    let contentType;
    let artifacts = [];
    let deliverableTitle;
    let deliverableSummary;

    if (envelope.isEnvelope) {
      // Reject envelopes with validation errors (malformed artifacts, disallowed MIME, etc.)
      if (envelope.errors.length > 0) {
        return {
          success: false,
          error: `Envelope validation failed: ${envelope.errors.join('; ')}`,
          category: 'bad_request'
        };
      }

      deliverableContent = envelope.content || '';
      contentType = envelope.contentTypeHint || detectDeliverableContentType(deliverableContent);
      artifacts = envelope.artifacts;
      deliverableTitle = envelope.title;
      deliverableSummary = envelope.summary;
    } else {
      deliverableContent = result.content;
      contentType = detectDeliverableContentType(result.content);
    }

    // Create deliverable from result with token usage tracking
    const deliverable = await createDeliverable(
      task.id,
      agent.id,
      deliverableContent,
      deliverableTitle || task.title,
      result.usage,
      agent.provider,
      agent.provider_model,
      contentType,
      artifacts,
      deliverableSummary
    );

    // Update task status
    await db.exec(`
      UPDATE tasks
      SET status = 'review', updated_at = datetime('now')
      WHERE id = ?
    `, [task.id]);

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
 * Execute a one-off prompt through an agent's configured provider.
 *
 * `options.onDelta`, when provided, is called synchronously for each text
 * fragment and is not awaited. Callers must not rely on it for backpressure.
 * Callback errors are logged and ignored so generation can continue.
 *
 * @param {Object} agent - Agent record from database
 * @param {Object} options - {title, description, projectId, context, maxTokens|max_tokens, onDelta, signal}
 * @returns {Promise<Object>} Direct prompt execution result
 */
export async function executeDirectAgentPrompt(agent, options = {}) {
  try {
    ensureSupportedProvider(agent.provider);
    const apiKey = resolveProviderApiKey(agent);
    const task = createDirectPromptTask(options);
    const context = await gatherTaskContext(task);
    const systemPrompt = agent.system_prompt || getDefaultSystemPrompt(agent);
    const userPrompt = buildTaskPrompt(task, context);
    const maxTokens = options.maxTokens ?? options.max_tokens ?? agent.max_tokens ?? 4096;

    const result = await executeProviderPrompt(agent, apiKey, systemPrompt, userPrompt, maxTokens, {
      onDelta: options.onDelta,
      signal: options.signal
    });

    return {
      success: true,
      content: result.content,
      usage: result.usage,
      provider: agent.provider,
      model: agent.provider_model || getDefaultProviderModel(agent.provider)
    };
  } catch (error) {
    console.error('[AgentExecutor] Direct prompt failed:', error);
    return {
      success: false,
      error: error.message,
      category: error.category || null,
      retryable: Boolean(error.retryable)
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
export async function testConnection(provider, apiKey, model, baseUrl) {
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
    } else if (provider === 'openai' || provider === 'openai_compatible') {
      const base = baseUrl || 'https://api.openai.com';
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model || 'gpt-4o',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Hi' }]
        })
      });

      if (response.ok) {
        return { success: true, message: 'Connection successful' };
      } else {
        const error = await response.json().catch(() => ({}));
        return { success: false, message: error.error?.message || `Connection failed (HTTP ${response.status})` };
      }
    } else if (provider === 'google') {
      const modelId = model || 'gemini-2.5-pro';
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
          generationConfig: { maxOutputTokens: 10 }
        })
      });

      if (response.ok) {
        return { success: true, message: 'Connection successful' };
      } else {
        const error = await response.json().catch(() => ({}));
        return { success: false, message: error.error?.message || `Connection failed (HTTP ${response.status})` };
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
  } else if (status === 403 || code === 'insufficient_quota' || message.toLowerCase().includes('payment') || message.toLowerCase().includes('plan')) {
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
async function executeAnthropic(apiKey, model, systemPrompt, userPrompt, maxTokens, temperature, options = {}) {
  if (hasDeltaCallback(options)) {
    return await executeAnthropicStream(apiKey, model, systemPrompt, userPrompt, maxTokens, temperature, options);
  }

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

async function executeAnthropicStream(apiKey, model, systemPrompt, userPrompt, maxTokens, temperature, options) {
  const stream = createStreamingAbortController(options);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: stream.signal,
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
        messages: [{ role: 'user', content: userPrompt }],
        stream: true
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw classifyApiError(response.status, error, 'anthropic');
    }

    let content = '';
    let sawStop = false;
    const usage = { inputTokens: undefined, outputTokens: undefined };

    for await (const event of parseSSEStream(response.body, { onChunk: stream.resetIdleTimeout })) {
      if (!event.data.trim()) continue;
      const data = parseStreamJson(event.data, 'anthropic');
      const eventType = event.event || data.type;

      if (eventType === 'error' || data.type === 'error') {
        throw classifyApiError(0, data, 'anthropic');
      }

      if (eventType === 'message_start' || data.type === 'message_start') {
        if (data.message?.usage?.input_tokens !== undefined) {
          usage.inputTokens = data.message.usage.input_tokens;
        }
        if (data.message?.usage?.output_tokens !== undefined) {
          usage.outputTokens = data.message.usage.output_tokens;
        }
        continue;
      }

      if (eventType === 'content_block_delta' || data.type === 'content_block_delta') {
        if (data.delta?.type === 'text_delta') {
          const text = data.delta.text || '';
          content += text;
          safeCallDelta(options, text);
        }
        continue;
      }

      if (eventType === 'message_delta' || data.type === 'message_delta') {
        if (data.usage?.output_tokens !== undefined) {
          usage.outputTokens = data.usage.output_tokens;
        }
        if (data.usage?.input_tokens !== undefined) {
          usage.inputTokens = data.usage.input_tokens;
        }
        continue;
      }

      if (eventType === 'message_stop' || data.type === 'message_stop') {
        sawStop = true;
        break;
      }
    }

    if (!sawStop) {
      throw createUnexpectedStreamEndError('anthropic');
    }

    return { content, usage };
  } catch (error) {
    throw normalizeStreamingAbort(error, 'anthropic', stream.getAbortReason());
  } finally {
    stream.cleanup();
  }
}

/**
 * Execute using OpenAI API
 */
async function executeOpenAI(apiKey, model, systemPrompt, userPrompt, maxTokens, temperature, baseUrl, options = {}) {
  if (hasDeltaCallback(options)) {
    return await executeOpenAIStream(apiKey, model, systemPrompt, userPrompt, maxTokens, temperature, baseUrl, options);
  }

  const base = (baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXECUTION_TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers,
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

async function executeOpenAIStream(apiKey, model, systemPrompt, userPrompt, maxTokens, temperature, baseUrl, options) {
  const base = (baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
  const stream = createStreamingAbortController(options);

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const body = {
      model: model || 'gpt-4o',
      max_tokens: maxTokens || 4096,
      temperature: temperature ?? 0.7,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    };

    if (base === 'https://api.openai.com') {
      body.stream_options = { include_usage: true };
    }

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      signal: stream.signal,
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw classifyApiError(response.status, error, 'openai');
    }

    let content = '';
    let sawDone = false;
    const usage = { inputTokens: undefined, outputTokens: undefined };

    for await (const event of parseSSEStream(response.body, { onChunk: stream.resetIdleTimeout })) {
      const raw = event.data.trim();
      if (!raw) continue;
      if (raw === '[DONE]') {
        sawDone = true;
        break;
      }

      const data = parseStreamJson(raw, 'openai');
      if (data.error) {
        throw classifyApiError(0, data, 'openai');
      }

      if (data.usage) {
        usage.inputTokens = data.usage.prompt_tokens;
        usage.outputTokens = data.usage.completion_tokens;
      }

      const text = data.choices?.[0]?.delta?.content;
      if (typeof text === 'string' && text.length > 0) {
        content += text;
        safeCallDelta(options, text);
      }
    }

    if (!sawDone) {
      throw createUnexpectedStreamEndError('openai');
    }

    return { content, usage };
  } catch (error) {
    throw normalizeStreamingAbort(error, 'openai', stream.getAbortReason());
  } finally {
    stream.cleanup();
  }
}

/**
 * Execute using Google Gemini API
 */
async function executeGoogle(apiKey, model, systemPrompt, userPrompt, maxTokens, temperature, options = {}) {
  if (hasDeltaCallback(options)) {
    return await executeGoogleStream(apiKey, model, systemPrompt, userPrompt, maxTokens, temperature, options);
  }

  const modelId = model || 'gemini-2.5-pro';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXECUTION_TIMEOUT_MS);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
          }
        ],
        generationConfig: {
          maxOutputTokens: maxTokens || 4096,
          temperature: temperature ?? 0.7
        }
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw classifyApiError(response.status, error, 'google');
    }

    const data = await response.json();
    const content = data?.candidates?.[0]?.content?.parts
      ?.map(p => p?.text || '')
      .join('') || '';

    return {
      content,
      usage: {
        inputTokens: data?.usageMetadata?.promptTokenCount,
        outputTokens: data?.usageMetadata?.candidatesTokenCount
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function executeGoogleStream(apiKey, model, systemPrompt, userPrompt, maxTokens, temperature, options) {
  const modelId = model || 'gemini-2.5-pro';
  const stream = createStreamingAbortController(options);

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      signal: stream.signal,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }]
          }
        ],
        generationConfig: {
          maxOutputTokens: maxTokens || 4096,
          temperature: temperature ?? 0.7
        }
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw classifyApiError(response.status, error, 'google');
    }

    let content = '';
    let usageMetadata = null;

    for await (const event of parseSSEStream(response.body, { onChunk: stream.resetIdleTimeout })) {
      const raw = event.data.trim();
      if (!raw) continue;
      const data = parseStreamJson(raw, 'google');

      if (data.error) {
        throw classifyApiError(data.error.code || 0, data, 'google');
      }

      const text = data?.candidates?.[0]?.content?.parts
        ?.map(p => p?.text || '')
        .join('') || '';
      if (text) {
        content += text;
        safeCallDelta(options, text);
      }

      if (data.usageMetadata) {
        usageMetadata = data.usageMetadata;
      }
    }

    return {
      content,
      usage: {
        inputTokens: usageMetadata?.promptTokenCount,
        outputTokens: usageMetadata?.candidatesTokenCount
      }
    };
  } catch (error) {
    throw normalizeStreamingAbort(error, 'google', stream.getAbortReason());
  } finally {
    stream.cleanup();
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
4. Produce a clear, well-structured deliverable (markdown by default)
5. Include relevant details and explanations
6. Be thorough but concise

If your task requires producing binary artifacts (files like PDF, DOCX, images, CSV, etc.), return a JSON envelope:
{
  "title": "optional title",
  "summary": "optional summary",
  "content": "inline text content (markdown, html, etc.)",
  "content_type": "markdown",
  "artifacts": [
    {
      "filename": "report.pdf",
      "mime_type": "application/pdf",
      "encoding": "base64",
      "content": "<base64-encoded file content>"
    }
  ]
}
Only use the envelope format when you need to include file artifacts. For text-only deliverables, respond with plain text.`;
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

  prompt += `## Instructions\nPlease complete this task and provide your deliverable below. Use markdown formatting for text content. If the task requires binary file outputs, use the JSON envelope format described in your system instructions.`;

  return prompt;
}

/**
 * Create deliverable record from execution result.
 * Handles revision linking: if previous deliverables exist for this task,
 * sets parent_id to the most recent one and updates its status to 'revised'.
 */
async function createDeliverable(taskId, agentId, content, title, usage, provider, model, contentType = 'markdown', artifacts = [], summary = null) {
  // Get project_id from the task so route dispatch works on review
  const task = await db.one('SELECT project_id FROM tasks WHERE id = ?', [taskId]);
  const projectId = task?.project_id || null;

  // Insert with version retry (Issue #15: prevents duplicate versions)
  const MAX_VERSION_RETRIES = 3;
  let insertResult;

  for (let attempt = 1; attempt <= MAX_VERSION_RETRIES; attempt++) {
    try {
      insertResult = await db.tx(async (tx) => {
        // Re-read version inside transaction for atomicity
        const existing = await tx.one(`
          SELECT id, version FROM deliverables WHERE task_id = ? ORDER BY version DESC LIMIT 1
        `, [taskId]);

        const version = (existing?.version || 0) + 1;
        const parentId = existing?.id || null;

        const result = await tx.insert(`
          INSERT INTO deliverables (
            task_id, project_id, agent_id, title, summary, content, content_type, status, version, parent_id,
            input_tokens, output_tokens, provider, model
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
        `, [
          taskId,
          projectId,
          agentId,
          `Deliverable: ${title}`,
          summary || null,
          content,
          contentType,
          version,
          parentId,
          usage?.inputTokens || null,
          usage?.outputTokens || null,
          provider || null,
          model || null
        ]);

        // If this is a revision, update the parent deliverable status to 'revised'
        if (parentId) {
          await tx.exec(`
            UPDATE deliverables SET status = 'revised', updated_at = datetime('now') WHERE id = ?
          `, [parentId]);
        }

        return { id: result.lastInsertRowid, version };
      });
      break; // success — exit retry loop
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' && attempt < MAX_VERSION_RETRIES) {
        continue; // retry — transaction rolled back, re-read version
      }
      throw err;
    }
  }

  const deliverableId = insertResult.id;
  const finalVersion = insertResult.version;

  // Save artifact files if present (outside transaction — failures propagate)
  let savedFiles = [];
  if (artifacts && artifacts.length > 0) {
    await ensureUploadsDir();
    const usedNames = [];
    for (const artifact of artifacts) {
      const mimeType = artifact.mime_type || getMimeType(artifact.filename);
      const savedFile = await saveDeliverableFile(
        artifact.filename,
        artifact.content,
        deliverableId,
        { isBase64: true, existingNames: usedNames }
      );
      usedNames.push(savedFile.filename);
      savedFiles.push({ ...savedFile, mimeType });
    }

    // Update deliverable with file references
    await db.exec(`
      UPDATE deliverables SET files = ?, updated_at = datetime('now') WHERE id = ?
    `, [JSON.stringify(savedFiles), deliverableId]);
  }

  // Dispatch deliverable.submitted event for delivery routes (outside transaction)
  if (projectId) {
    const project = await db.one('SELECT id, name FROM projects WHERE id = ?', [projectId]);
    const agent = await db.one('SELECT id, name FROM agents WHERE id = ?', [agentId]);

    dispatchEvent('deliverable.submitted', {
      project: project ? { id: project.id, name: project.name } : { id: projectId },
      projectId,
      deliverable: {
        id: deliverableId,
        title: `Deliverable: ${title}`,
        content,
        content_type: contentType,
        status: 'pending',
        version: finalVersion,
        files: savedFiles,
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

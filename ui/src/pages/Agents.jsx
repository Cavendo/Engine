import { useState, useEffect } from 'react';
import { Plus, Key, Copy, Check, Trash2, Settings, BarChart3 } from 'lucide-react';
import { api } from '../lib/api';
import Button from '../components/Button';
import Card, { CardHeader, CardBody } from '../components/Card';
import { StatusBadge } from '../components/Badge';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import { Input, TextArea, Select } from '../components/Input';
import { safeTimeAgo } from '../lib/dates';

function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export default function Agents() {
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [modelsConfig, setModelsConfig] = useState(null);

  useEffect(() => {
    loadAgents();
    loadModels();
  }, []);

  const loadAgents = async () => {
    try {
      const data = await api.agents.list();
      setAgents(data);
    } catch (err) {
      console.error('Failed to load agents:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadModels = async () => {
    try {
      const data = await api.settings.getModels();
      setModelsConfig(data);
    } catch (err) {
      console.error('Failed to load models config:', err);
    }
  };

  const handleCreateAgent = async (data) => {
    // Modal handles its own API calls (two-step: create + execution config)
    // data is null when modal already created successfully
    if (data === null) {
      loadAgents();
      setShowCreateModal(false);
      return;
    }
    try {
      await api.agents.create(data);
      loadAgents();
      setShowCreateModal(false);
    } catch (err) {
      console.error('Failed to create agent:', err);
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="h-32 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agents</h1>
          <p className="text-gray-500">Manage AI agents and their API keys</p>
        </div>
        <Button onClick={() => setShowCreateModal(true)}>
          <Plus className="w-4 h-4" />
          Register Agent
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {agents.map((agent) => (
          <Card key={agent.id}>
            <CardHeader className="flex items-start justify-between">
              <div>
                <h3 className="font-semibold text-gray-900">{agent.name}</h3>
                <p className="text-sm text-gray-500 capitalize">{agent.type}</p>
              </div>
              <StatusBadge status={agent.status} />
            </CardHeader>
            <CardBody className="space-y-4">
              {agent.description && (
                <p className="text-sm text-gray-600">{agent.description}</p>
              )}

              <div className="flex flex-wrap gap-1">
                {agent.provider ? (
                  <span className="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded-full">
                    Task Execution ({agent.provider === 'anthropic' ? 'Claude' : agent.provider === 'openai_compatible' ? (agent.provider_label || 'Local') : 'OpenAI'}{agent.providerModel ? ` / ${agent.providerModel}` : ''})
                  </span>
                ) : (
                  <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">External / MCP</span>
                )}
                {agent.capabilities?.map((cap, i) => (
                  <span key={i} className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">
                    {cap}
                  </span>
                ))}
              </div>

              {agent.totalTokens > 0 && (
                <div className="text-xs text-gray-400">
                  {formatTokenCount(agent.totalTokens)} tokens used
                </div>
              )}

              <div className="flex gap-2 pt-2">
                <Button variant="secondary" size="sm" onClick={() => setSelectedAgent(agent)}>
                  <Settings className="w-4 h-4" /> Manage
                </Button>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      {agents.length === 0 && (
        <Card>
          <CardBody className="text-center py-12">
            <p className="text-gray-500">No agents registered yet</p>
            <Button className="mt-4" onClick={() => setShowCreateModal(true)}>
              Register your first agent
            </Button>
          </CardBody>
        </Card>
      )}

      <CreateAgentModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreateAgent}
        modelsConfig={modelsConfig}
      />

      <AgentSettingsModal
        agent={selectedAgent}
        onClose={() => setSelectedAgent(null)}
        onSaved={loadAgents}
        modelsConfig={modelsConfig}
      />
    </div>
  );
}

function AgentSettingsModal({ agent, onClose, onSaved, modelsConfig }) {
  const [tab, setTab] = useState('general');
  const [general, setGeneral] = useState({ name: '', type: 'supervised', description: '', capabilities: '', status: 'active' });
  const [exec, setExec] = useState({ provider: '', providerApiKey: '', providerModel: '', providerBaseUrl: '', providerLabel: '', systemPrompt: '', executionMode: 'manual', maxTokens: 4096, temperature: 0.7 });
  const [agentDetail, setAgentDetail] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [newKey, setNewKey] = useState(null);
  const [copied, setCopied] = useState(false);
  const [configTab, setConfigTab] = useState('claude-desktop');
  const [configCopied, setConfigCopied] = useState(false);

  useEffect(() => {
    if (agent) {
      setGeneral({
        name: agent.name || '',
        type: agent.type || 'supervised',
        description: agent.description || '',
        capabilities: (agent.capabilities || []).join(', '),
        status: agent.status || 'active'
      });
      setExec({
        provider: agent.provider || '',
        providerApiKey: '',
        providerModel: agent.providerModel || agent.provider_model || '',
        providerBaseUrl: agent.providerBaseUrl || agent.provider_base_url || '',
        providerLabel: agent.providerLabel || agent.provider_label || '',
        systemPrompt: agent.systemPrompt || agent.system_prompt || '',
        executionMode: agent.executionMode || agent.execution_mode || 'manual',
        maxTokens: agent.maxTokens || agent.max_tokens || 4096,
        temperature: agent.temperature ?? 0.7
      });
      setError(null);
      setSuccess(false);
      setNewKey(null);
      setMetrics(null);
      setTab('general');
      loadAgentDetail();
    }
  }, [agent]);

  const loadAgentDetail = async () => {
    if (!agent) return;
    try {
      const detail = await api.agents.get(agent.id);
      setAgentDetail(detail);
    } catch (err) {
      console.error('Failed to load agent detail:', err);
    }
  };

  const loadMetrics = async () => {
    if (!agent || metrics) return;
    setMetricsLoading(true);
    try {
      const data = await api.agents.getMetrics(agent.id);
      setMetrics(data);
    } catch (err) {
      console.error('Failed to load metrics:', err);
    } finally {
      setMetricsLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'metrics') loadMetrics();
  }, [tab]);

  const handleSaveGeneral = async (e) => {
    e.preventDefault();
    setSaving(true); setError(null); setSuccess(false);
    try {
      await api.agents.update(agent.id, {
        name: general.name.trim(),
        type: general.type,
        description: general.description,
        capabilities: general.capabilities ? general.capabilities.split(',').map(s => s.trim()) : [],
        status: general.status
      });
      setSuccess(true);
      onSaved();
      setTimeout(() => onClose(), 800);
    } catch (err) { setError(err.message || 'Failed to save'); }
    finally { setSaving(false); }
  };

  const handleSaveExec = async (e) => {
    e.preventDefault();
    setSaving(true); setError(null); setSuccess(false);
    try {
      const payload = {
        provider: exec.provider || null,
        providerModel: exec.providerModel || null,
        providerBaseUrl: exec.providerBaseUrl || null,
        providerLabel: exec.providerLabel || null,
        systemPrompt: exec.systemPrompt || null,
        executionMode: exec.executionMode,
        maxTokens: parseInt(exec.maxTokens) || 4096,
        temperature: parseFloat(exec.temperature) ?? 0.7
      };
      if (exec.providerApiKey) payload.providerApiKey = exec.providerApiKey;
      await api.agents.updateExecution(agent.id, payload);
      setSuccess(true);
      onSaved();
      setTimeout(() => onClose(), 800);
    } catch (err) { setError(err.message || 'Failed to save'); }
    finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) return;
    try {
      await api.agents.delete(agent.id);
      onSaved();
      onClose();
    } catch (err) { setError(err.message || 'Failed to delete'); }
  };

  const handleGenerateKey = async () => {
    setError(null);
    try {
      const result = await api.agents.generateKey(agent.id, {});
      setNewKey(result);
      loadAgentDetail();
    } catch (err) { setError(err.message || 'Failed to generate key'); }
  };

  const handleRevokeKey = async (keyId) => {
    if (!confirm('Revoke this key? This cannot be undone.')) return;
    setError(null);
    try {
      await api.agents.revokeKey(agent.id, keyId);
      loadAgentDetail();
    } catch (err) { setError(err.message || 'Failed to revoke key'); }
  };

  const copyKey = () => {
    navigator.clipboard.writeText(newKey?.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const serverUrl = window.location.origin;

  const getConfigSnippet = (platform) => {
    const key = newKey?.key || 'cav_ak_YOUR_KEY_HERE';
    if (platform === 'claude-desktop') {
      return JSON.stringify({
        mcpServers: {
          cavendo: {
            command: 'npx',
            args: ['@cavendo/mcp-server'],
            env: {
              CAVENDO_AGENT_KEY: key,
              CAVENDO_URL: serverUrl
            }
          }
        }
      }, null, 2);
    }
    if (platform === 'claude-code') {
      return `claude mcp add cavendo -- npx @cavendo/mcp-server \\
  --env CAVENDO_AGENT_KEY=${key} \\
  --env CAVENDO_URL=${serverUrl}`;
    }
    if (platform === 'api') {
      return `# List assigned tasks
curl ${serverUrl}/api/tasks?status=assigned \\
  -H "Authorization: Bearer ${key}"

# Submit a deliverable
curl -X POST ${serverUrl}/api/deliverables \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"taskId": 1, "title": "My Deliverable", "content": "..."}'`;
    }
    return '';
  };

  const copyConfig = (platform) => {
    navigator.clipboard.writeText(getConfigSnippet(platform));
    setConfigCopied(true);
    setTimeout(() => setConfigCopied(false), 2000);
  };

  if (!agent) return null;

  const tabClass = (t) => `px-4 py-2 text-sm font-medium rounded-t-lg ${tab === t ? 'bg-white text-gray-900 border border-b-0 border-gray-200' : 'text-gray-500 hover:text-gray-700'}`;
  const keys = (agentDetail?.keys || []).filter(k => !k.revokedAt);

  return (
    <Modal isOpen={!!agent} onClose={onClose} title={`Settings: ${agent.name}`} size="lg">
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        <button type="button" className={tabClass('general')} onClick={() => setTab('general')}>General</button>
        <button type="button" className={tabClass('keys')} onClick={() => setTab('keys')}>MCP / API Access</button>
        <button type="button" className={tabClass('execution')} onClick={() => setTab('execution')}>Task Execution</button>
        <button type="button" className={tabClass('metrics')} onClick={() => setTab('metrics')}>Metrics</button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4"><p className="text-sm text-red-700">{error}</p></div>}
      {success && <div className="bg-green-50 border border-green-200 rounded-lg p-3 mb-4"><p className="text-sm text-green-700">Saved.</p></div>}

      {tab === 'general' && (
        <form onSubmit={handleSaveGeneral} className="space-y-4">
          <Input label="Name" value={general.name} onChange={(e) => setGeneral({ ...general, name: e.target.value })} required />
          <Select label="Type" value={general.type} onChange={(e) => setGeneral({ ...general, type: e.target.value })}
            options={[
              { value: 'supervised', label: 'Supervised' },
              { value: 'semi-autonomous', label: 'Semi-autonomous' },
              { value: 'autonomous', label: 'Autonomous' }
            ]}
          />
          <TextArea label="Description" value={general.description} onChange={(e) => setGeneral({ ...general, description: e.target.value })} />
          <CapabilityInput value={general.capabilities} onChange={(val) => setGeneral({ ...general, capabilities: val })} />
          <Select label="Status" value={general.status} onChange={(e) => setGeneral({ ...general, status: e.target.value })}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'paused', label: 'Paused' },
              { value: 'disabled', label: 'Disabled' }
            ]}
          />
          <div className="flex justify-between pt-4">
            <Button type="button" variant="danger" onClick={handleDelete}><Trash2 className="w-4 h-4" /> Delete</Button>
            <div className="flex gap-3">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button type="submit" loading={saving}>Save</Button>
            </div>
          </div>
        </form>
      )}

      {tab === 'keys' && (
        <div className="space-y-4">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-1">
            <p className="text-sm text-blue-700 font-medium">For external tools connecting to Cavendo</p>
            <p className="text-sm text-blue-600">
              Generate an agent key, then use the setup instructions below to connect your AI tool.
            </p>
          </div>

          {newKey && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 space-y-2">
              <p className="text-sm text-yellow-800 font-medium">New key generated — copy it now, it won't be shown again:</p>
              <div className="flex gap-2">
                <code className="flex-1 bg-white px-3 py-2 rounded text-sm font-mono break-all border">
                  {newKey.key}
                </code>
                <Button variant="secondary" onClick={copyKey}>
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          )}

          {/* Platform setup configs — shown when a key exists (new or existing) */}
          {(newKey || keys.length > 0) && (
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <div className="flex border-b border-gray-200 bg-gray-50">
                {[
                  { id: 'claude-desktop', label: 'Claude Desktop' },
                  { id: 'claude-code', label: 'Claude Code' },
                  { id: 'api', label: 'REST API' }
                ].map(p => (
                  <button key={p.id} type="button" onClick={() => setConfigTab(p.id)}
                    className={`px-4 py-2 text-xs font-medium transition-colors ${
                      configTab === p.id
                        ? 'bg-white text-gray-900 border-b-2 border-primary-500'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >{p.label}</button>
                ))}
              </div>
              <div className="p-4 space-y-3">
                {configTab === 'claude-desktop' && (
                  <>
                    <p className="text-sm text-gray-600">
                      Add this to your Claude Desktop config file:
                    </p>
                    <p className="text-xs text-gray-400">
                      macOS: <code className="font-mono">~/Library/Application Support/Claude/claude_desktop_config.json</code><br />
                      Windows: <code className="font-mono">%APPDATA%\Claude\claude_desktop_config.json</code>
                    </p>
                  </>
                )}
                {configTab === 'claude-code' && (
                  <p className="text-sm text-gray-600">
                    Run this command in your terminal to add the Cavendo MCP server:
                  </p>
                )}
                {configTab === 'api' && (
                  <p className="text-sm text-gray-600">
                    Use the agent key as a Bearer token in API calls:
                  </p>
                )}
                <div className="relative">
                  <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                    {getConfigSnippet(configTab)}
                  </pre>
                  <Button variant="secondary" size="sm"
                    onClick={() => copyConfig(configTab)}
                    className="absolute top-2 right-2"
                  >
                    {configCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  </Button>
                </div>
                {!newKey && (
                  <p className="text-xs text-amber-600">
                    Replace <code className="font-mono">cav_ak_YOUR_KEY_HERE</code> with your actual agent key.
                    If you've lost it, generate a new one below.
                  </p>
                )}
              </div>
            </div>
          )}

          <Button variant="secondary" onClick={handleGenerateKey}>
            <Key className="w-4 h-4" /> Generate New Key
          </Button>

          <div className="space-y-2">
            {keys.map((key) => (
              <div key={key.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <div>
                  <div className="flex items-center gap-2">
                    <code className="text-sm font-mono">{key.keyPrefix}...</code>
                    {key.name && <span className="text-sm text-gray-500">({key.name})</span>}
                  </div>
                  <div className="text-xs text-gray-400">
                    Created {safeTimeAgo(key.createdAt)}
                    {key.lastUsedAt && <> · Last used {safeTimeAgo(key.lastUsedAt)}</>}
                    {key.expiresAt && <> · Expires {safeTimeAgo(key.expiresAt)}</>}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleRevokeKey(key.id)}>
                  <Trash2 className="w-4 h-4 text-red-500" />
                </Button>
              </div>
            ))}
            {keys.length === 0 && !newKey && (
              <p className="text-center text-gray-500 py-4">No active keys. Generate one to get started.</p>
            )}
          </div>
        </div>
      )}

      {tab === 'execution' && (
        <form onSubmit={handleSaveExec} className="space-y-4">
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 space-y-1">
            <p className="text-sm text-purple-700 font-medium">For server-side task execution</p>
            <p className="text-sm text-purple-600">
              Configure an AI provider API key so Cavendo can execute tasks directly. When a task is assigned,
              Cavendo sends the task details along with project knowledge and context to the AI model,
              then creates a deliverable from the response.
            </p>
          </div>
          <Select label="Execution Mode" value={exec.executionMode} onChange={(e) => setExec({ ...exec, executionMode: e.target.value })}
            options={[
              { value: 'manual', label: 'Manual - Agent works via MCP/API only' },
              { value: 'auto', label: 'Auto - Execute tasks automatically via provider' },
              { value: 'human', label: 'Human - Assigned person works the task (no AI execution)' }
            ]}
          />
          <Select label="Provider" value={exec.provider} onChange={(e) => setExec({ ...exec, provider: e.target.value })}
            options={[
              { value: '', label: 'None' },
              { value: 'anthropic', label: 'Anthropic (Claude)' },
              { value: 'openai', label: 'OpenAI (GPT)' },
              { value: 'openai_compatible', label: 'OpenAI-Compatible (Local)' }
            ]}
          />
          {exec.provider && (
            <>
              {exec.provider === 'openai_compatible' && (
                <div>
                  <Input label="Base URL" value={exec.providerBaseUrl || ''}
                    onChange={(e) => setExec({ ...exec, providerBaseUrl: e.target.value })}
                    placeholder="http://localhost:11434" />
                  <div className="flex gap-2 mt-1">
                    <button type="button" className="text-xs text-primary-600 hover:underline"
                      onClick={() => setExec({ ...exec, providerBaseUrl: 'http://localhost:11434', providerLabel: 'Ollama' })}>
                      Ollama
                    </button>
                    <button type="button" className="text-xs text-primary-600 hover:underline"
                      onClick={() => setExec({ ...exec, providerBaseUrl: 'http://localhost:1234', providerLabel: 'LM Studio' })}>
                      LM Studio
                    </button>
                    <button type="button" className="text-xs text-primary-600 hover:underline"
                      onClick={() => setExec({ ...exec, providerBaseUrl: 'http://localhost:8000', providerLabel: 'vLLM' })}>
                      vLLM
                    </button>
                  </div>
                  <Input label="Label (optional)" value={exec.providerLabel || ''}
                    onChange={(e) => setExec({ ...exec, providerLabel: e.target.value })}
                    placeholder="e.g., Ollama, LM Studio" className="mt-3" />
                </div>
              )}
              <div>
                <Input label="API Key" type="password" value={exec.providerApiKey} onChange={(e) => setExec({ ...exec, providerApiKey: e.target.value })}
                  placeholder={agent.hasApiKey ? '••••••••  (saved — leave blank to keep)' : exec.provider === 'openai_compatible' ? 'Optional — most local models don\'t need a key' : 'Enter provider API key'} />
                {agent.hasApiKey && <p className="text-xs text-gray-500 mt-1">A key is already configured. Leave blank to keep it.</p>}
              </div>
              <ModelSelect provider={exec.provider} value={exec.providerModel} onChange={(val) => setExec({ ...exec, providerModel: val })} modelsConfig={modelsConfig} />
              <div className="grid grid-cols-2 gap-4">
                <Input label="Max Tokens" type="number" value={exec.maxTokens} onChange={(e) => setExec({ ...exec, maxTokens: e.target.value })} min="256" max="200000" />
                <Input label="Temperature" type="number" value={exec.temperature} onChange={(e) => setExec({ ...exec, temperature: e.target.value })} min="0" max="2" step="0.1" />
              </div>
              <TextArea label="System Prompt" value={exec.systemPrompt} onChange={(e) => setExec({ ...exec, systemPrompt: e.target.value })} placeholder="Optional instructions for the AI..." rows={4} />
            </>
          )}
          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={saving}>Save Configuration</Button>
          </div>
        </form>
      )}

      {tab === 'metrics' && (
        <div className="space-y-4">
          {metricsLoading ? (
            <div className="animate-pulse space-y-2">
              <div className="h-20 bg-gray-200 rounded"></div>
              <div className="h-20 bg-gray-200 rounded"></div>
            </div>
          ) : metrics ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-green-50 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-green-600">{metrics.metrics?.tasksCompleted || 0}</div>
                  <div className="text-xs text-green-600">Tasks Completed</div>
                </div>
                <div className="bg-blue-50 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-blue-600">{metrics.metrics?.tasksInProgress || 0}</div>
                  <div className="text-xs text-blue-600">In Progress</div>
                </div>
                <div className="bg-purple-50 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-purple-600">{metrics.metrics?.deliverablesSubmitted || 0}</div>
                  <div className="text-xs text-purple-600">Deliverables Submitted</div>
                </div>
                <div className="bg-green-50 rounded-lg p-4 text-center">
                  <div className="text-2xl font-bold text-green-600">{metrics.metrics?.deliverablesApproved || 0}</div>
                  <div className="text-xs text-green-600">Approved</div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-lg font-semibold text-gray-700">
                    {metrics.metrics?.approvalRate != null ? `${Math.round(metrics.metrics.approvalRate)}%` : '-'}
                  </div>
                  <div className="text-xs text-gray-500">Approval Rate</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-lg font-semibold text-gray-700">
                    {metrics.metrics?.firstTimeApprovalRate != null ? `${Math.round(metrics.metrics.firstTimeApprovalRate)}%` : '-'}
                  </div>
                  <div className="text-xs text-gray-500">First-Time Approval</div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-lg font-semibold text-gray-700">
                    {metrics.metrics?.avgCompletionTimeMinutes != null ? `${Math.round(metrics.metrics.avgCompletionTimeMinutes)}m` : '-'}
                  </div>
                  <div className="text-xs text-gray-500">Avg Completion</div>
                </div>
              </div>

              {(metrics.metrics?.totalTokens > 0) && (
                <div className="grid grid-cols-3 gap-4">
                  <div className="bg-gray-50 rounded-lg p-3 text-center">
                    <div className="text-lg font-semibold text-gray-700">
                      {formatTokenCount(metrics.metrics.totalInputTokens)}
                    </div>
                    <div className="text-xs text-gray-500">Input Tokens</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 text-center">
                    <div className="text-lg font-semibold text-gray-700">
                      {formatTokenCount(metrics.metrics.totalOutputTokens)}
                    </div>
                    <div className="text-xs text-gray-500">Output Tokens</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-3 text-center">
                    <div className="text-lg font-semibold text-gray-700">
                      {formatTokenCount(metrics.metrics.totalTokens)}
                    </div>
                    <div className="text-xs text-gray-500">Total Tokens</div>
                  </div>
                </div>
              )}

              {metrics.metrics?.deliverablesRevisionRequested > 0 || metrics.metrics?.deliverablesRejected > 0 ? (
                <div className="flex gap-4 text-sm">
                  <span className="text-yellow-600">{metrics.metrics.deliverablesRevisionRequested} revisions requested</span>
                  <span className="text-red-600">{metrics.metrics.deliverablesRejected} rejected</span>
                </div>
              ) : null}

              {metrics.recentActivity?.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Recent Activity (last 30 days)</h4>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {metrics.recentActivity.map((day, i) => (
                      <div key={i} className="flex items-center justify-between text-sm p-2 bg-gray-50 rounded">
                        <span className="text-gray-600">{day.date}</span>
                        <div className="flex gap-4">
                          {day.tasksCompleted > 0 && <Badge variant="green">{day.tasksCompleted} completed</Badge>}
                          {day.deliverablesSubmitted > 0 && <Badge variant="blue">{day.deliverablesSubmitted} submitted</Badge>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-center text-gray-500 py-8">No metrics available</p>
          )}
        </div>
      )}
    </Modal>
  );
}

function CreateAgentModal({ isOpen, onClose, onSubmit, modelsConfig }) {
  const [mode, setMode] = useState(null); // 'execution' or 'external'
  const [formData, setFormData] = useState({
    name: '',
    type: 'supervised',
    description: '',
    capabilities: '',
    provider: 'anthropic',
    providerApiKey: '',
    providerModel: '',
    providerBaseUrl: '',
    providerLabel: '',
    executionMode: 'auto'
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Post-creation state for external agents
  const [createdKey, setCreatedKey] = useState(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [setupTab, setSetupTab] = useState('claude-desktop');
  const [setupCopied, setSetupCopied] = useState(false);

  const serverUrl = window.location.origin;

  const resetForm = () => {
    setMode(null);
    setFormData({ name: '', type: 'supervised', description: '', capabilities: '', provider: 'anthropic', providerApiKey: '', providerModel: '', providerBaseUrl: '', providerLabel: '', executionMode: 'auto' });
    setError(null);
    setCreatedKey(null);
    setKeyCopied(false);
    setSetupTab('claude-desktop');
    setSetupCopied(false);
  };

  const getSetupSnippet = (platform) => {
    const key = createdKey?.key || 'cav_ak_YOUR_KEY_HERE';
    if (platform === 'claude-desktop') {
      return JSON.stringify({
        mcpServers: {
          cavendo: {
            command: 'npx',
            args: ['@cavendo/mcp-server'],
            env: {
              CAVENDO_AGENT_KEY: key,
              CAVENDO_URL: serverUrl
            }
          }
        }
      }, null, 2);
    }
    if (platform === 'claude-code') {
      return `claude mcp add cavendo -- npx @cavendo/mcp-server \\
  --env CAVENDO_AGENT_KEY=${key} \\
  --env CAVENDO_URL=${serverUrl}`;
    }
    if (platform === 'api') {
      return `# List assigned tasks
curl ${serverUrl}/api/tasks?status=assigned \\
  -H "Authorization: Bearer ${key}"

# Submit a deliverable
curl -X POST ${serverUrl}/api/deliverables \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"taskId": 1, "title": "My Deliverable", "content": "..."}'`;
    }
    return '';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      // Step 1: Create the agent
      const agent = await api.agents.create({
        name: formData.name,
        type: formData.type,
        description: formData.description,
        capabilities: formData.capabilities
          ? formData.capabilities.split(',').map(s => s.trim())
          : []
      });

      // Step 2: If task execution mode, configure the provider
      if (mode === 'execution' && formData.provider) {
        try {
          const execPayload = {
            provider: formData.provider,
            providerModel: formData.providerModel || null,
            providerBaseUrl: formData.providerBaseUrl || null,
            providerLabel: formData.providerLabel || null,
            executionMode: formData.executionMode
          };
          if (formData.providerApiKey) execPayload.providerApiKey = formData.providerApiKey;
          await api.agents.updateExecution(agent.id, execPayload);
        } catch (err) {
          console.error('Agent created but execution config failed:', err);
          setError('Agent created, but provider setup failed. You can configure it in Manage > Task Execution.');
          setLoading(false);
          return;
        }
      }

      // Step 3: For external agents, auto-generate a key and show setup
      if (mode === 'external') {
        try {
          const keyResult = await api.agents.generateKey(agent.id, {});
          setCreatedKey(keyResult);
          onSubmit(null); // reload agent list in background
          return; // Don't close — show the key setup screen
        } catch (err) {
          console.error('Agent created but key generation failed:', err);
          setError('Agent created, but key generation failed. Go to Manage > MCP / API Access to generate a key.');
          setLoading(false);
          return;
        }
      }

      resetForm();
      onSubmit(null);
    } catch (err) {
      setError(err.message || 'Failed to create agent');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={createdKey ? 'Agent Ready — Copy Your Key' : 'Register Agent'} size={mode || createdKey ? 'lg' : 'default'}>
      {createdKey ? (
        <div className="space-y-4">
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <p className="text-sm text-green-800 font-medium">Agent registered and key generated.</p>
            <p className="text-sm text-green-700 mt-1">Copy this key now — it won't be shown again.</p>
          </div>

          <div className="flex gap-2">
            <code className="flex-1 bg-white px-3 py-2 rounded text-sm font-mono break-all border border-gray-300">
              {createdKey.key}
            </code>
            <Button variant="secondary" onClick={() => {
              navigator.clipboard.writeText(createdKey.key);
              setKeyCopied(true);
              setTimeout(() => setKeyCopied(false), 2000);
            }}>
              {keyCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>

          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="flex border-b border-gray-200 bg-gray-50">
              {[
                { id: 'claude-desktop', label: 'Claude Desktop' },
                { id: 'claude-code', label: 'Claude Code' },
                { id: 'api', label: 'REST API' }
              ].map(p => (
                <button key={p.id} type="button" onClick={() => setSetupTab(p.id)}
                  className={`px-4 py-2 text-xs font-medium transition-colors ${
                    setupTab === p.id
                      ? 'bg-white text-gray-900 border-b-2 border-primary-500'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >{p.label}</button>
              ))}
            </div>
            <div className="p-4 space-y-3">
              {setupTab === 'claude-desktop' && (
                <>
                  <p className="text-sm text-gray-600">Add this to your Claude Desktop config file:</p>
                  <p className="text-xs text-gray-400">
                    macOS: <code className="font-mono">~/Library/Application Support/Claude/claude_desktop_config.json</code><br />
                    Windows: <code className="font-mono">%APPDATA%\Claude\claude_desktop_config.json</code>
                  </p>
                </>
              )}
              {setupTab === 'claude-code' && (
                <p className="text-sm text-gray-600">Run this command in your terminal:</p>
              )}
              {setupTab === 'api' && (
                <p className="text-sm text-gray-600">Use the agent key as a Bearer token in API calls:</p>
              )}
              <div className="relative">
                <pre className="bg-gray-900 text-gray-100 rounded-lg p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap">
                  {getSetupSnippet(setupTab)}
                </pre>
                <Button variant="secondary" size="sm"
                  onClick={() => {
                    navigator.clipboard.writeText(getSetupSnippet(setupTab));
                    setSetupCopied(true);
                    setTimeout(() => setSetupCopied(false), 2000);
                  }}
                  className="absolute top-2 right-2"
                >
                  {setupCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                </Button>
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={handleClose}>Done</Button>
          </div>
        </div>
      ) : !mode ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">What kind of agent are you setting up?</p>

          <button type="button" onClick={() => setMode('execution')}
            className="w-full text-left p-5 rounded-lg border-2 border-gray-200 hover:border-purple-500 hover:bg-purple-50 transition-colors group"
          >
            <div className="text-lg font-semibold text-gray-900 group-hover:text-purple-700">Agent for Task Execution</div>
            <p className="text-sm text-gray-500 mt-2">
              Create an AI-powered agent that automatically executes tasks. You provide an API key from
              your AI provider, and Cavendo handles the rest — sending tasks, project context, and
              knowledge base to the model and collecting the deliverable.
            </p>
            <div className="mt-4 flex items-center gap-3 text-xs text-gray-400 flex-wrap">
              <span className="font-medium text-gray-500">Works with:</span>
              <span className="px-2 py-1 bg-purple-50 text-purple-600 rounded">Anthropic (Claude)</span>
              <span className="px-2 py-1 bg-green-50 text-green-600 rounded">OpenAI (GPT)</span>
              <span className="px-2 py-1 bg-orange-50 text-orange-600 rounded">Ollama / Local Models</span>
            </div>
          </button>

          <div className="relative flex items-center gap-4">
            <div className="flex-1 border-t border-gray-200"></div>
            <span className="text-xs text-gray-400">or</span>
            <div className="flex-1 border-t border-gray-200"></div>
          </div>

          <button type="button" onClick={() => setMode('external')}
            className="w-full text-left p-5 rounded-lg border-2 border-gray-200 hover:border-blue-500 hover:bg-blue-50 transition-colors group"
          >
            <div className="text-lg font-semibold text-gray-900 group-hover:text-blue-700">Connect My Existing AI</div>
            <p className="text-sm text-gray-500 mt-2">
              Already using an AI tool like Claude Desktop or ChatGPT? Connect it to Cavendo so it can
              pick up tasks, access your project knowledge, and submit deliverables — all from the tool you're
              already working in.
            </p>
            <div className="mt-4 flex items-center gap-3 text-xs text-gray-400">
              <span className="font-medium text-gray-500">Works with:</span>
              <span className="px-2 py-1 bg-blue-50 text-blue-600 rounded">Claude Desktop</span>
              <span className="px-2 py-1 bg-blue-50 text-blue-600 rounded">Claude Code</span>
              <span className="px-2 py-1 bg-blue-50 text-blue-600 rounded">ChatGPT</span>
              <span className="px-2 py-1 bg-gray-50 text-gray-600 rounded">Any AI tool</span>
            </div>
          </button>

          <div className="text-center pt-2">
            <p className="text-xs text-gray-400">
              Looking to add a team member?{' '}
              <a href="/users" className="text-primary-600 hover:text-primary-700 underline">Go to Users</a>
            </p>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Mode indicator */}
          <div className={`rounded-lg p-3 text-sm flex items-center justify-between ${mode === 'execution' ? 'bg-purple-50 border border-purple-200 text-purple-700' : 'bg-blue-50 border border-blue-200 text-blue-700'}`}>
            <span>
              {mode === 'execution'
                ? 'Setting up an agent for task execution'
                : 'Connecting your existing AI tool'}
            </span>
            <button type="button" onClick={() => setMode(null)} className="underline text-xs opacity-75 hover:opacity-100">Change</button>
          </div>

          {/* Common fields */}
          <Input label="Agent Name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder={mode === 'execution' ? 'e.g. Research Agent (Sonnet)' : 'e.g. My Claude Desktop'} required />
          <TextArea label="Description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            placeholder={mode === 'execution' ? 'Handles research and analysis tasks for the marketing team' : 'Jonathan\'s Claude Desktop instance for content work'} />
          <CapabilityInput value={formData.capabilities} onChange={(val) => setFormData({ ...formData, capabilities: val })} />
          <Select label="Approval Mode" value={formData.type} onChange={(e) => setFormData({ ...formData, type: e.target.value })}
            options={[
              { value: 'supervised', label: 'Supervised - All deliverables require human review' },
              { value: 'semi-autonomous', label: 'Semi-autonomous - Low-priority tasks auto-approved' },
              { value: 'autonomous', label: 'Autonomous - Deliverables auto-approved' }
            ]}
          />

          {/* Task Execution fields */}
          {mode === 'execution' && (
            <div className="border-t border-gray-200 pt-4 space-y-3">
              <h3 className="text-sm font-medium text-gray-700">AI Provider</h3>
              <Select label="Provider" value={formData.provider} onChange={(e) => setFormData({ ...formData, provider: e.target.value })}
                options={[
                  { value: 'anthropic', label: 'Anthropic (Claude)' },
                  { value: 'openai', label: 'OpenAI (GPT)' },
                  { value: 'openai_compatible', label: 'OpenAI-Compatible (Local)' }
                ]}
              />
              {formData.provider === 'openai_compatible' && (
                <div>
                  <Input label="Base URL" value={formData.providerBaseUrl || ''}
                    onChange={(e) => setFormData({ ...formData, providerBaseUrl: e.target.value })}
                    placeholder="http://localhost:11434" />
                  <div className="flex gap-2 mt-1">
                    <button type="button" className="text-xs text-primary-600 hover:underline"
                      onClick={() => setFormData({ ...formData, providerBaseUrl: 'http://localhost:11434', providerLabel: 'Ollama' })}>
                      Ollama
                    </button>
                    <button type="button" className="text-xs text-primary-600 hover:underline"
                      onClick={() => setFormData({ ...formData, providerBaseUrl: 'http://localhost:1234', providerLabel: 'LM Studio' })}>
                      LM Studio
                    </button>
                    <button type="button" className="text-xs text-primary-600 hover:underline"
                      onClick={() => setFormData({ ...formData, providerBaseUrl: 'http://localhost:8000', providerLabel: 'vLLM' })}>
                      vLLM
                    </button>
                  </div>
                  <Input label="Label (optional)" value={formData.providerLabel || ''}
                    onChange={(e) => setFormData({ ...formData, providerLabel: e.target.value })}
                    placeholder="e.g., Ollama, LM Studio" className="mt-3" />
                </div>
              )}
              <Input label="API Key" type="password" value={formData.providerApiKey} onChange={(e) => setFormData({ ...formData, providerApiKey: e.target.value })}
                placeholder={formData.provider === 'anthropic' ? 'sk-ant-api03-...' : formData.provider === 'openai_compatible' ? 'Optional — most local models don\'t need a key' : 'sk-...'}
                required={formData.provider !== 'openai_compatible'} />
              <ModelSelect provider={formData.provider} value={formData.providerModel} onChange={(val) => setFormData({ ...formData, providerModel: val })} modelsConfig={modelsConfig} />
              <Select label="Execution Mode" value={formData.executionMode} onChange={(e) => setFormData({ ...formData, executionMode: e.target.value })}
                options={[
                  { value: 'auto', label: 'Auto - Execute tasks automatically when assigned' },
                  { value: 'manual', label: 'Manual - Trigger execution from the UI' },
                  { value: 'human', label: 'Human - Person works the task (no AI execution)' }
                ]}
              />
            </div>
          )}

          {/* External/MCP info */}
          {mode === 'external' && (
            <div className="border-t border-gray-200 pt-4">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
                <h3 className="text-sm font-medium text-blue-800">What happens next?</h3>
                <div className="text-sm text-blue-700 space-y-2">
                  <p>
                    <strong>1.</strong> Register this agent (click below)
                  </p>
                  <p>
                    <strong>2.</strong> Open the agent's <strong>Manage</strong> panel and go to <strong>MCP / API Access</strong>
                  </p>
                  <p>
                    <strong>3.</strong> Generate a key and follow the setup guide for your AI tool — we'll give you
                    the exact config to copy and paste
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="secondary" onClick={handleClose}>Cancel</Button>
            <Button type="submit" loading={loading}>Register Agent</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

const CAPABILITY_SUGGESTIONS = ['research', 'writing', 'code', 'code-review', 'analysis', 'design', 'testing', 'data'];

function CapabilityInput({ value, onChange, label = 'Capabilities (comma-separated)', placeholder = 'research, writing, code-review' }) {
  const addChip = (cap) => {
    const existing = value ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (!existing.includes(cap)) {
      onChange(existing.length > 0 ? `${value.trimEnd()}, ${cap}` : cap);
    }
  };

  return (
    <div>
      <Input label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      <div className="flex flex-wrap gap-1 mt-1.5">
        {CAPABILITY_SUGGESTIONS.map((cap) => {
          const existing = value ? value.split(',').map(s => s.trim()) : [];
          const active = existing.includes(cap);
          return (
            <button
              key={cap}
              type="button"
              onClick={() => addChip(cap)}
              className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                active
                  ? 'bg-primary-100 border-primary-300 text-primary-700 cursor-default'
                  : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100 hover:border-gray-300'
              }`}
            >
              {cap}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Model selector dropdown that uses the models config from the API.
 * Falls back to a text input if config isn't loaded yet.
 */
function ModelSelect({ provider, value, onChange, modelsConfig }) {
  const providerModels = modelsConfig?.providers?.[provider]?.models || [];

  if (providerModels.length === 0) {
    return (
      <Input
        label="Model"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={provider === 'anthropic' ? 'claude-sonnet-4-5-20250929' : 'gpt-4o'}
      />
    );
  }

  // For openai_compatible, show suggestions but allow free-text entry
  if (provider === 'openai_compatible') {
    return (
      <div>
        <Input
          label="Model"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g., qwen2.5:latest, llama3.2:latest"
          list="openai-compat-models"
        />
        <datalist id="openai-compat-models">
          {providerModels.map(m => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </datalist>
        <div className="flex flex-wrap gap-1 mt-1.5">
          {providerModels.map(m => (
            <button
              key={m.id}
              type="button"
              onClick={() => onChange(m.id)}
              className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                value === m.id
                  ? 'bg-primary-100 border-primary-300 text-primary-700 cursor-default'
                  : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100 hover:border-gray-300'
              }`}
            >
              {m.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const defaultModel = providerModels.find(m => m.default)?.id || providerModels[0]?.id;
  if (!value && defaultModel) {
    setTimeout(() => onChange(defaultModel), 0);
  }

  const selected = providerModels.find(m => m.id === value);

  return (
    <div>
      <Select
        label="Model"
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        options={providerModels.map(m => ({
          value: m.id,
          label: `${m.name}${m.default ? ' (Recommended)' : ''}`
        }))}
      />
      {selected?.description && (
        <p className="text-xs text-gray-500 mt-1">{selected.description}</p>
      )}
    </div>
  );
}

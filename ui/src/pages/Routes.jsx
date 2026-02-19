import { useState, useEffect } from 'react';
import { Plus, Route, Trash2, Pencil, Play, RefreshCw, ChevronDown, ChevronRight, Settings, Loader2, Copy } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import Button from '../components/Button';
import Card, { CardHeader, CardBody } from '../components/Card';
import { StatusBadge } from '../components/Badge';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import { Input, TextArea, Select } from '../components/Input';
import { safeTimeAgo } from '../lib/dates';
import { toSnakeCase } from '../lib/transform';

// Keep in sync with TRIGGER_EVENTS in server/utils/validation.js
const TRIGGER_EVENTS = [
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

const DESTINATION_TYPES = [
  { value: 'webhook', label: 'Webhook' },
  { value: 'email', label: 'Email' },
  { value: 'slack', label: 'Slack' },
  { value: 'storage', label: 'S3 Storage' }
];

export default function DeliveryRoutes() {
  const location = useLocation();
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [duplicateSource, setDuplicateSource] = useState(null);
  const [showCopyFromProject, setShowCopyFromProject] = useState(false);
  const [editRoute, setEditRoute] = useState(null);
  const [logsRoute, setLogsRoute] = useState(null);

  useEffect(() => {
    if (location.state?.openCreate && location.state?.projectId) {
      setSelectedProjectId(String(location.state.projectId));
      setShowCreateModal(true);
      window.history.replaceState({}, '');
    } else if (location.state?.selectRouteId) {
      api.routes.get(location.state.selectRouteId).then(route => setEditRoute(route)).catch(() => {});
      window.history.replaceState({}, '');
    }
  }, [location.state]);

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (selectedProjectId) {
      loadRoutes();
    } else {
      setRoutes([]);
    }
  }, [selectedProjectId]);

  const loadProjects = async () => {
    try {
      const data = await api.projects.list();
      setProjects(data);
      if (data.length > 0) {
        setSelectedProjectId(String(data[0].id));
      }
    } catch (err) {
      console.error('Failed to load projects:', err);
    } finally {
      setLoading(false);
    }
  };

  const isGlobal = selectedProjectId === 'global';

  const loadRoutes = async () => {
    try {
      const data = isGlobal
        ? await api.routes.listGlobal()
        : await api.routes.listForProject(selectedProjectId);
      setRoutes(data);
    } catch (err) {
      console.error('Failed to load routes:', err);
    }
  };

  const handleCreateRoute = async (data) => {
    const payload = { ...data, destination_config: toSnakeCase(data.destination_config) };
    try {
      if (isGlobal) {
        await api.routes.createGlobal(payload);
      } else {
        await api.routes.create(selectedProjectId, payload);
      }
      loadRoutes();
      setShowCreateModal(false);
      setDuplicateSource(null);
    } catch (err) {
      console.error('Failed to create route:', err);
      throw err;
    }
  };

  const handleDuplicateRoute = (route) => {
    setDuplicateSource(route);
    setShowCreateModal(true);
  };

  const handleCopyFromProject = async (sourceProjectId) => {
    try {
      const sourceRoutes = await api.routes.listForProject(sourceProjectId);
      let copied = 0;
      for (const route of sourceRoutes) {
        await api.routes.create(selectedProjectId, {
          name: route.name,
          description: route.description || '',
          trigger_event: route.triggerEvent,
          destination_type: route.destinationType,
          destination_config: toSnakeCase(route.destinationConfig || {}),
          trigger_conditions: toSnakeCase(route.triggerConditions || null),
          retry_policy: toSnakeCase(route.retryPolicy || null),
          field_mapping: toSnakeCase(route.fieldMapping || null),
          enabled: route.enabled !== false
        });
        copied++;
      }
      loadRoutes();
      setShowCopyFromProject(false);
      return copied;
    } catch (err) {
      console.error('Failed to copy routes:', err);
      throw err;
    }
  };

  const handleUpdateRoute = async (id, data) => {
    const payload = { ...data, destination_config: toSnakeCase(data.destination_config) };
    await api.routes.update(id, payload);
    loadRoutes();
    setEditRoute(null);
  };

  const handleDeleteRoute = async (id) => {
    if (!confirm('Delete this delivery route?')) return;
    try {
      await api.routes.delete(id);
      loadRoutes();
      setEditRoute(null);
    } catch (err) {
      console.error('Failed to delete route:', err);
    }
  };

  const handleTestRoute = async (id) => {
    try {
      const result = await api.routes.test(id);
      alert(result.success ? 'Test successful!' : `Test failed: ${result.error}`);
    } catch (err) {
      let msg = `Test failed: ${err.message}`;
      if (err.detail) {
        const d = err.detail;
        const parts = [];
        if (d.code) parts.push(`Code: ${d.code}`);
        if (d.httpStatus) parts.push(`HTTP ${d.httpStatus}`);
        if (d.region) parts.push(`Region: ${d.region}`);
        if (d.message && d.message !== err.message) parts.push(d.message);
        if (parts.length) msg += `\n\n${parts.join('\n')}`;
      }
      alert(msg);
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="h-64 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Delivery Routes</h1>
          <p className="text-gray-500">Auto-dispatch content to external systems</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setShowCopyFromProject(true)} disabled={!selectedProjectId || isGlobal}>
            <Copy className="w-4 h-4" />
            Copy from Project
          </Button>
          <Button onClick={() => { setDuplicateSource(null); setShowCreateModal(true); }} disabled={!selectedProjectId}>
            <Plus className="w-4 h-4" />
            Create Route
          </Button>
        </div>
      </div>

      <div className="flex gap-4 mb-6">
        <Select value={selectedProjectId} onChange={(e) => setSelectedProjectId(e.target.value)}
          options={[
            { value: '', label: 'Select a project' },
            { value: 'global', label: 'Global (all projects)' },
            ...projects.map(p => ({ value: String(p.id), label: p.name }))
          ]}
          className="w-64"
        />
      </div>

      {!selectedProjectId && (
        <Card>
          <CardBody className="text-center py-12">
            <p className="text-gray-500">Select a project to view its delivery routes</p>
          </CardBody>
        </Card>
      )}

      {selectedProjectId && (
        <div className="space-y-4">
          {routes.map((route) => (
            <Card key={route.id}>
              <CardBody>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-semibold text-gray-900">{route.name}</h3>
                      <Badge variant={route.enabled ? 'green' : 'gray'}>
                        {route.enabled ? 'Enabled' : 'Disabled'}
                      </Badge>
                      <Badge variant="blue">{route.destinationType}</Badge>
                    </div>

                    {route.description && (
                      <p className="text-sm text-gray-500 mb-2">{route.description}</p>
                    )}

                    <div className="flex items-center gap-4 text-sm text-gray-500">
                      <span>Trigger: <code className="bg-gray-100 px-1 rounded">{route.triggerEvent}</code></span>
                      {route.lastFiredAt && (
                        <span>Last fired: {safeTimeAgo(route.lastFiredAt)}</span>
                      )}
                    </div>

                    {route.destinationType === 'webhook' && route.destinationConfig?.url && (
                      <p className="text-xs font-mono text-gray-400 mt-1">{route.destinationConfig.url}</p>
                    )}
                    {route.destinationType === 'email' && route.destinationConfig?.to && (
                      <p className="text-xs text-gray-400 mt-1">To: {Array.isArray(route.destinationConfig.to) ? route.destinationConfig.to.join(', ') : route.destinationConfig.to}</p>
                    )}
                    {route.destinationType === 'slack' && (route.destinationConfig?.channelLabel || route.destinationConfig?.channel_label) && (
                      <p className="text-xs text-gray-400 mt-1">Channel: {route.destinationConfig.channelLabel || route.destinationConfig.channel_label}</p>
                    )}
                    {route.destinationType === 'storage' && route.destinationConfig?.bucket && (
                      <p className="text-xs font-mono text-gray-400 mt-1">s3://{route.destinationConfig.bucket}/{route.destinationConfig.pathPrefix || route.destinationConfig.path_prefix || ''}</p>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => handleTestRoute(route.id)} title="Test route">
                      <Play className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setLogsRoute(route)} title="View logs">
                      Logs
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDuplicateRoute(route)} title="Duplicate route">
                      <Copy className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditRoute(route)} title="Edit route">
                      <Pencil className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}

          {routes.length === 0 && (
            <Card>
              <CardBody className="text-center py-12">
                <p className="text-gray-500">No delivery routes configured for this project</p>
                <Button className="mt-4" onClick={() => setShowCreateModal(true)}>
                  Create your first route
                </Button>
              </CardBody>
            </Card>
          )}
        </div>
      )}

      <CreateRouteModal
        isOpen={showCreateModal}
        onClose={() => { setShowCreateModal(false); setDuplicateSource(null); }}
        onSubmit={handleCreateRoute}
        duplicateSource={duplicateSource}
      />

      <EditRouteModal
        route={editRoute}
        onClose={() => setEditRoute(null)}
        onSave={handleUpdateRoute}
        onDelete={handleDeleteRoute}
      />

      <RouteLogsModal
        route={logsRoute}
        onClose={() => setLogsRoute(null)}
      />

      <CopyFromProjectModal
        isOpen={showCopyFromProject}
        onClose={() => setShowCopyFromProject(false)}
        projects={projects}
        currentProjectId={selectedProjectId}
        onCopy={handleCopyFromProject}
      />
    </div>
  );
}

function DestinationConfigFields({ type, config, onChange }) {
  if (type === 'webhook') {
    return (
      <>
        <Input label="Webhook URL" type="url" value={config.url || ''} onChange={(e) => onChange({ ...config, url: e.target.value })} required />
        <Select label="HTTP Method" value={config.method || 'POST'} onChange={(e) => onChange({ ...config, method: e.target.value })}
          options={[
            { value: 'POST', label: 'POST' },
            { value: 'PUT', label: 'PUT' },
            { value: 'PATCH', label: 'PATCH' }
          ]}
        />
      </>
    );
  }

  if (type === 'email') {
    return (
      <>
        <Input label="To (comma-separated emails)" value={Array.isArray(config.to) ? config.to.join(', ') : (config.to || '')} onChange={(e) => onChange({ ...config, to: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} required />
        <Input label="CC (optional)" value={Array.isArray(config.cc) ? config.cc.join(', ') : (config.cc || '')} onChange={(e) => onChange({ ...config, cc: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
        <Input label="From Name (optional)" value={config.from_name || ''} onChange={(e) => onChange({ ...config, from_name: e.target.value })} />
        <Input label="Subject Template (optional)" value={config.subject_template || ''} onChange={(e) => onChange({ ...config, subject_template: e.target.value })} placeholder="New deliverable: {{title}}" />
      </>
    );
  }

  if (type === 'slack') {
    return (
      <>
        <Input label="Slack Webhook URL" type="url" value={config.webhook_url || ''} onChange={(e) => onChange({ ...config, webhook_url: e.target.value })} placeholder="https://hooks.slack.com/services/T.../B.../xxx" required />
        <div className="grid grid-cols-2 gap-4">
          <Input label="Channel Label (display only)" value={config.channel_label || ''} onChange={(e) => onChange({ ...config, channel_label: e.target.value })} placeholder="#approvals" />
          <Select label="Message Style" value={config.message_style || 'rich'} onChange={(e) => onChange({ ...config, message_style: e.target.value })}
            options={[
              { value: 'rich', label: 'Rich (Block Kit)' },
              { value: 'simple', label: 'Simple (text only)' }
            ]}
          />
        </div>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={config.include_content_preview !== false} onChange={(e) => onChange({ ...config, include_content_preview: e.target.checked })} className="rounded border-gray-300" />
            Content Preview
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={config.include_files_list !== false} onChange={(e) => onChange({ ...config, include_files_list: e.target.checked })} className="rounded border-gray-300" />
            File List
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={config.include_actions !== false} onChange={(e) => onChange({ ...config, include_actions: e.target.checked })} className="rounded border-gray-300" />
            Actions
          </label>
        </div>
      </>
    );
  }

  if (type === 'storage') {
    return <StorageConfigFields config={config} onChange={onChange} />;
  }

  return null;
}

function StorageConfigFields({ config, onChange }) {
  const [connections, setConnections] = useState([]);
  const [showManage, setShowManage] = useState(false);
  const useConnection = !!config.connection_id;

  useEffect(() => {
    api.connections.list().then(setConnections).catch(() => {});
  }, [showManage]);

  const handleConnectionChange = (value) => {
    if (value === 'manual') {
      const { connection_id, ...rest } = config;
      onChange({ ...rest, provider: 's3', bucket: '', region: 'us-east-1', access_key_id: '', secret_access_key: '' });
    } else {
      const conn = connections.find(c => c.id === Number(value));
      if (conn) {
        onChange({
          provider: 's3',
          connection_id: conn.id,
          path_prefix: config.path_prefix || '',
          upload_content: config.upload_content !== false,
          upload_files: config.upload_files !== false
        });
      }
    }
  };

  const selectedConn = useConnection ? connections.find(c => c.id === config.connection_id) : null;

  return (
    <>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Select
            label="Connection"
            value={useConnection ? String(config.connection_id) : 'manual'}
            onChange={(e) => handleConnectionChange(e.target.value)}
            options={[
              { value: 'manual', label: 'Enter credentials manually' },
              ...connections.map(c => ({ value: String(c.id), label: `${c.name} (${c.bucket})` }))
            ]}
          />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => setShowManage(true)} title="Manage Connections">
          <Settings className="w-4 h-4" />
        </Button>
      </div>

      {useConnection && selectedConn && (
        <div className="text-sm text-gray-500 bg-gray-50 rounded-lg p-3">
          <span className="font-medium">{selectedConn.name}</span> &mdash; s3://{selectedConn.bucket}
          {selectedConn.region && <span className="ml-2 text-gray-400">({selectedConn.region})</span>}
          <span className="ml-2 text-gray-400">Key: {selectedConn.accessKeyIdPreview}</span>
        </div>
      )}

      {!useConnection && (
        <>
          <Select label="Provider" value={config.provider || 's3'} onChange={(e) => onChange({ ...config, provider: e.target.value })}
            options={[{ value: 's3', label: 'S3-Compatible' }]}
          />
          <Input label="Bucket" value={config.bucket || ''} onChange={(e) => onChange({ ...config, bucket: e.target.value })} required />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Region" value={config.region || 'us-east-1'} onChange={(e) => onChange({ ...config, region: e.target.value })} />
            <Input label="Endpoint URL (optional)" value={config.endpoint || ''} onChange={(e) => onChange({ ...config, endpoint: e.target.value || undefined })} placeholder="Leave empty for AWS S3" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label="Access Key ID" value={config.access_key_id || ''} onChange={(e) => onChange({ ...config, access_key_id: e.target.value })} required />
            <Input label="Secret Access Key" type="password" value={config.secret_access_key || ''} onChange={(e) => onChange({ ...config, secret_access_key: e.target.value })} required />
          </div>
        </>
      )}

      <Input label="Path Prefix (optional)" value={config.path_prefix || ''} onChange={(e) => onChange({ ...config, path_prefix: e.target.value })} placeholder="cavendo/deliverables/" />
      <div className="flex gap-6">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={config.upload_content !== false} onChange={(e) => onChange({ ...config, upload_content: e.target.checked })} className="rounded border-gray-300" />
          Upload Content
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={config.upload_files !== false} onChange={(e) => onChange({ ...config, upload_files: e.target.checked })} className="rounded border-gray-300" />
          Upload File Attachments
        </label>
      </div>

      <StorageConnectionsModal isOpen={showManage} onClose={() => setShowManage(false)} />
    </>
  );
}

function CreateRouteModal({ isOpen, onClose, onSubmit, duplicateSource }) {
  const defaultForm = {
    name: '', description: '', trigger_event: 'deliverable.approved',
    destination_type: 'webhook', destination_config: { url: '', method: 'POST' },
    enabled: true
  };

  const [formData, setFormData] = useState(defaultForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (duplicateSource && isOpen) {
      setFormData({
        name: `${duplicateSource.name} (copy)`,
        description: duplicateSource.description || '',
        trigger_event: duplicateSource.triggerEvent || 'deliverable.approved',
        destination_type: duplicateSource.destinationType || 'webhook',
        destination_config: toSnakeCase(duplicateSource.destinationConfig) || { url: '', method: 'POST' },
        enabled: duplicateSource.enabled !== false
      });
    } else if (isOpen && !duplicateSource) {
      setFormData(defaultForm);
    }
  }, [duplicateSource, isOpen]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onSubmit(formData);
      setFormData(defaultForm);
    } catch (err) {
      setError(err.message || 'Failed to create route');
    } finally { setLoading(false); }
  };

  const handleDestTypeChange = (type) => {
    const config = type === 'webhook' ? { url: '', method: 'POST' }
      : type === 'slack' ? { webhook_url: '', message_style: 'rich', include_content_preview: true, include_files_list: true, include_actions: true }
      : type === 'storage' ? { provider: 's3', bucket: '', region: 'us-east-1', access_key_id: '', secret_access_key: '', upload_content: true, upload_files: true }
      : { to: [] };
    setFormData({ ...formData, destination_type: type, destination_config: config });
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={duplicateSource ? 'Duplicate Delivery Route' : 'Create Delivery Route'} size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="Route name" required />
        <TextArea label="Description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} rows={2} />

        <div className="grid grid-cols-2 gap-4">
          <Select label="Trigger Event" value={formData.trigger_event} onChange={(e) => setFormData({ ...formData, trigger_event: e.target.value })}
            options={TRIGGER_EVENTS.map(e => ({ value: e, label: e }))}
          />
          <Select label="Destination Type" value={formData.destination_type} onChange={(e) => handleDestTypeChange(e.target.value)}
            options={DESTINATION_TYPES}
          />
        </div>

        <DestinationConfigFields type={formData.destination_type} config={formData.destination_config}
          onChange={(config) => setFormData({ ...formData, destination_config: config })}
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Create</Button>
        </div>
      </form>
    </Modal>
  );
}

function EditRouteModal({ route, onClose, onSave, onDelete }) {
  const [formData, setFormData] = useState({
    name: '', description: '', trigger_event: '', destination_type: 'webhook',
    destination_config: {}, enabled: true
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (route) {
      setFormData({
        name: route.name || '',
        description: route.description || '',
        trigger_event: route.triggerEvent || '',
        destination_type: route.destinationType || 'webhook',
        destination_config: toSnakeCase(route.destinationConfig || {}),
        enabled: route.enabled !== false
      });
      setError('');
    }
  }, [route]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await onSave(route.id, formData);
    } catch (err) {
      setError(err.message || 'Failed to save route');
    } finally { setSaving(false); }
  };

  const handleDestTypeChange = (type) => {
    const config = type === 'webhook' ? { url: '', method: 'POST' }
      : type === 'slack' ? { webhook_url: '', message_style: 'rich', include_content_preview: true, include_files_list: true, include_actions: true }
      : type === 'storage' ? { provider: 's3', bucket: '', region: 'us-east-1', access_key_id: '', secret_access_key: '', upload_content: true, upload_files: true }
      : { to: [] };
    setFormData({ ...formData, destination_type: type, destination_config: config });
  };

  if (!route) return null;

  return (
    <Modal isOpen={!!route} onClose={onClose} title="Edit Delivery Route" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} required />
        <TextArea label="Description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} rows={2} />

        <div className="grid grid-cols-2 gap-4">
          <Select label="Trigger Event" value={formData.trigger_event} onChange={(e) => setFormData({ ...formData, trigger_event: e.target.value })}
            options={TRIGGER_EVENTS.map(e => ({ value: e, label: e }))}
          />
          <Select label="Destination Type" value={formData.destination_type} onChange={(e) => handleDestTypeChange(e.target.value)}
            options={DESTINATION_TYPES}
          />
        </div>

        <DestinationConfigFields type={formData.destination_type} config={formData.destination_config}
          onChange={(config) => setFormData({ ...formData, destination_config: config })}
        />

        <Select label="Status" value={formData.enabled ? 'true' : 'false'} onChange={(e) => setFormData({ ...formData, enabled: e.target.value === 'true' })}
          options={[
            { value: 'true', label: 'Enabled' },
            { value: 'false', label: 'Disabled' }
          ]}
        />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex justify-between pt-4">
          <Button type="button" variant="danger" onClick={() => onDelete(route.id)}>
            <Trash2 className="w-4 h-4" /> Delete
          </Button>
          <div className="flex gap-3">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={saving}>Save</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function RouteLogsModal({ route, onClose }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (route) {
      loadLogs();
    }
  }, [route]);

  const loadLogs = async () => {
    setLoading(true);
    try {
      const data = await api.routes.getLogs(route.id);
      setLogs(data.logs || []);
    } catch (err) {
      console.error('Failed to load logs:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = async (logId) => {
    try {
      await api.routes.retryLog(route.id, logId);
      loadLogs();
    } catch (err) {
      console.error('Failed to retry:', err);
    }
  };

  if (!route) return null;

  return (
    <Modal isOpen={!!route} onClose={onClose} title={`Delivery Logs: ${route.name}`} size="xl">
      {loading ? (
        <div className="animate-pulse space-y-2">
          <div className="h-12 bg-gray-200 rounded"></div>
          <div className="h-12 bg-gray-200 rounded"></div>
        </div>
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {logs.map((log) => (
            <div key={log.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <div className="flex items-center gap-4">
                <StatusBadge status={log.status} />
                <span className="text-sm font-mono">{log.eventType}</span>
                <span className="text-xs text-gray-500">{safeTimeAgo(log.dispatchedAt)}</span>
                {log.responseStatus && (
                  <span className="text-xs text-gray-500">HTTP {log.responseStatus}</span>
                )}
                {log.errorMessage && (
                  <span className="text-xs text-red-500 truncate max-w-xs">{log.errorMessage}</span>
                )}
              </div>
              {log.status === 'failed' && (
                <Button size="sm" variant="secondary" onClick={() => handleRetry(log.id)}>
                  <RefreshCw className="w-3 h-3" /> Retry
                </Button>
              )}
            </div>
          ))}

          {logs.length === 0 && (
            <p className="text-center text-gray-500 py-8">No delivery logs yet</p>
          )}
        </div>
      )}
    </Modal>
  );
}

function StorageConnectionsModal({ isOpen, onClose }) {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editConn, setEditConn] = useState(null);
  const [formData, setFormData] = useState({ name: '', bucket: '', region: 'us-east-1', endpoint: '', access_key_id: '', secret_access_key: '' });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) loadConnections();
  }, [isOpen]);

  const loadConnections = async () => {
    setLoading(true);
    try {
      const data = await api.connections.list();
      setConnections(data);
    } catch (err) {
      console.error('Failed to load connections:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    setEditConn(null);
    setFormData({ name: '', bucket: '', region: 'us-east-1', endpoint: '', access_key_id: '', secret_access_key: '' });
    setShowForm(true);
    setError('');
  };

  const handleEdit = (conn) => {
    setEditConn(conn);
    setFormData({ name: conn.name, bucket: conn.bucket, region: conn.region || 'us-east-1', endpoint: conn.endpoint || '', access_key_id: '', secret_access_key: '' });
    setShowForm(true);
    setError('');
  };

  const handleSubmit = async () => {
    setSaving(true);
    setError('');
    try {
      const payload = { ...formData };
      if (!payload.endpoint) delete payload.endpoint;
      if (editConn) {
        // Only send changed credential fields
        if (!payload.access_key_id) delete payload.access_key_id;
        if (!payload.secret_access_key) delete payload.secret_access_key;
        await api.connections.update(editConn.id, payload);
      } else {
        await api.connections.create(payload);
      }
      setShowForm(false);
      loadConnections();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this storage connection?')) return;
    try {
      await api.connections.delete(id);
      loadConnections();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleTest = async (id) => {
    setTesting(id);
    try {
      await api.connections.test(id);
      alert('Connection successful!');
    } catch (err) {
      alert(`Connection failed: ${err.message}`);
    } finally {
      setTesting(null);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Manage Storage Connections" size="lg">
      {showForm ? (
        <div className="space-y-4">
          <Input label="Connection Name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="e.g. Production S3" />
          <Input label="Bucket" value={formData.bucket} onChange={(e) => setFormData({ ...formData, bucket: e.target.value })} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Region" value={formData.region} onChange={(e) => setFormData({ ...formData, region: e.target.value })} />
            <Input label="Endpoint URL (optional)" value={formData.endpoint} onChange={(e) => setFormData({ ...formData, endpoint: e.target.value })} placeholder="Leave empty for AWS S3" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label={editConn ? 'Access Key ID (leave blank to keep)' : 'Access Key ID'} value={formData.access_key_id} onChange={(e) => setFormData({ ...formData, access_key_id: e.target.value })} />
            <Input label={editConn ? 'Secret Access Key (leave blank to keep)' : 'Secret Access Key'} type="password" value={formData.secret_access_key} onChange={(e) => setFormData({ ...formData, secret_access_key: e.target.value })} />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>Back</Button>
            <Button type="button" loading={saving} onClick={handleSubmit} disabled={saving || (!editConn && (!formData.name || !formData.bucket || !formData.access_key_id || !formData.secret_access_key))}>{editConn ? 'Update' : 'Create'}</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex justify-end mb-4">
            <Button size="sm" onClick={handleCreate}><Plus className="w-4 h-4" /> New Connection</Button>
          </div>
          {loading ? (
            <div className="animate-pulse space-y-2">
              <div className="h-12 bg-gray-200 rounded"></div>
            </div>
          ) : connections.length === 0 ? (
            <p className="text-center text-gray-500 py-8">No stored connections yet</p>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {connections.map((conn) => (
                <div key={conn.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <span className="font-medium text-gray-900">{conn.name}</span>
                    <span className="text-sm text-gray-500 ml-2">s3://{conn.bucket}</span>
                    <span className="text-xs text-gray-400 ml-2">{conn.region}</span>
                    <span className="text-xs text-gray-400 ml-2">Key: {conn.accessKeyIdPreview}</span>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => handleTest(conn.id)} disabled={testing === conn.id}>
                      {testing === conn.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleEdit(conn)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(conn.id)}>
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function CopyFromProjectModal({ isOpen, onClose, projects, currentProjectId, onCopy }) {
  const [sourceProjectId, setSourceProjectId] = useState('');
  const [sourceRoutes, setSourceRoutes] = useState([]);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [copying, setCopying] = useState(false);
  const [result, setResult] = useState(null);

  const otherProjects = projects.filter(p => String(p.id) !== String(currentProjectId));

  useEffect(() => {
    if (!isOpen) {
      setSourceProjectId('');
      setSourceRoutes([]);
      setResult(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (sourceProjectId) {
      setLoadingPreview(true);
      setResult(null);
      api.routes.listForProject(sourceProjectId)
        .then(setSourceRoutes)
        .catch(() => setSourceRoutes([]))
        .finally(() => setLoadingPreview(false));
    } else {
      setSourceRoutes([]);
    }
  }, [sourceProjectId]);

  const handleCopy = async () => {
    setCopying(true);
    try {
      const count = await onCopy(sourceProjectId);
      setResult({ success: true, count });
    } catch {
      setResult({ success: false });
    } finally {
      setCopying(false);
    }
  };

  const currentProjectName = projects.find(p => String(p.id) === String(currentProjectId))?.name || 'current project';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Copy Routes from Another Project" size="lg">
      <div className="space-y-4">
        <Select
          label="Source Project"
          value={sourceProjectId}
          onChange={(e) => setSourceProjectId(e.target.value)}
          options={[
            { value: '', label: 'Select a project to copy from...' },
            ...otherProjects.map(p => ({ value: String(p.id), label: p.name }))
          ]}
        />

        {loadingPreview && (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading routes...
          </div>
        )}

        {sourceProjectId && !loadingPreview && sourceRoutes.length === 0 && (
          <p className="text-sm text-gray-500 py-4 text-center">No routes found in this project</p>
        )}

        {sourceRoutes.length > 0 && (
          <>
            <p className="text-sm text-gray-600">
              {sourceRoutes.length} route{sourceRoutes.length !== 1 ? 's' : ''} will be copied to <span className="font-medium">{currentProjectName}</span>:
            </p>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {sourceRoutes.map((route) => (
                <div key={route.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <div>
                    <span className="font-medium text-gray-900 text-sm">{route.name}</span>
                    <span className="text-xs text-gray-500 ml-2">{route.triggerEvent}</span>
                  </div>
                  <div className="flex gap-2">
                    <Badge variant="blue">{route.destinationType}</Badge>
                    <Badge variant={route.enabled ? 'green' : 'gray'}>
                      {route.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {result && (
          <p className={`text-sm ${result.success ? 'text-green-600' : 'text-red-600'}`}>
            {result.success ? `Copied ${result.count} route${result.count !== 1 ? 's' : ''} successfully.` : 'Failed to copy routes.'}
          </p>
        )}

        <div className="flex justify-end gap-3 pt-4">
          <Button variant="secondary" onClick={onClose}>
            {result?.success ? 'Done' : 'Cancel'}
          </Button>
          {!result?.success && (
            <Button onClick={handleCopy} disabled={sourceRoutes.length === 0 || copying} loading={copying}>
              <Copy className="w-4 h-4" />
              Copy {sourceRoutes.length > 0 ? `${sourceRoutes.length} Route${sourceRoutes.length !== 1 ? 's' : ''}` : 'Routes'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

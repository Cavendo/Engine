import { useState, useEffect } from 'react';
import { Plus, Webhook as WebhookIcon, RefreshCw, Trash2, Pencil, Settings, Copy, Check, Key } from 'lucide-react';
import { api } from '../lib/api';
import Button from '../components/Button';
import Card, { CardHeader, CardBody } from '../components/Card';
import { StatusBadge } from '../components/Badge';
import Modal from '../components/Modal';
import { Input, Select } from '../components/Input';
import { safeTimeAgo } from '../lib/dates';

// Keep in sync with TRIGGER_EVENTS in server/utils/validation.js
const WEBHOOK_EVENTS = [
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

export default function Webhooks() {
  const [webhooks, setWebhooks] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editWebhook, setEditWebhook] = useState(null);
  const [selectedWebhook, setSelectedWebhook] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [webhooksData, agentsData] = await Promise.all([
        api.webhooks.list(),
        api.agents.list()
      ]);
      setWebhooks(webhooksData);
      setAgents(agentsData);
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateWebhook = async (data) => {
    try {
      const result = await api.webhooks.create(data);
      alert(`Webhook created! Secret: ${result.secret}\n\nStore this securely - it won't be shown again.`);
      loadData();
      setShowCreateModal(false);
    } catch (err) {
      console.error('Failed to create webhook:', err);
    }
  };

  const handleUpdateWebhook = async (id, data) => {
    try {
      await api.webhooks.update(id, data);
      loadData();
      setEditWebhook(null);
    } catch (err) {
      console.error('Failed to update webhook:', err);
    }
  };

  const handleDeleteWebhook = async (id) => {
    if (!confirm('Delete this webhook?')) return;
    try {
      await api.webhooks.delete(id);
      loadData();
      setEditWebhook(null);
    } catch (err) {
      console.error('Failed to delete webhook:', err);
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
          <h1 className="text-2xl font-bold text-gray-900">Webhooks</h1>
          <p className="text-gray-500">Configure outbound event notifications</p>
        </div>
        <Button onClick={() => setShowCreateModal(true)}>
          <Plus className="w-4 h-4" />
          Create Webhook
        </Button>
      </div>

      <div className="space-y-4">
        {webhooks.map((webhook) => (
          <Card key={webhook.id}>
            <CardBody>
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <WebhookIcon className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <div className="flex items-center gap-3">
                      <code className="text-sm font-mono bg-gray-100 px-2 py-1 rounded">
                        {webhook.url}
                      </code>
                      <StatusBadge status={webhook.status} />
                    </div>
                    <p className="text-sm text-gray-500 mt-1">
                      Agent: {webhook.agentName}
                    </p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {webhook.events?.map((event, i) => (
                        <span
                          key={i}
                          className="px-2 py-0.5 bg-blue-50 text-blue-700 text-xs rounded"
                        >
                          {event}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditWebhook(webhook)}
                  >
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedWebhook(webhook)}
                  >
                    View Deliveries
                  </Button>
                </div>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      {webhooks.length === 0 && (
        <Card>
          <CardBody className="text-center py-12">
            <WebhookIcon className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-500">No webhooks configured</p>
            <Button className="mt-4" onClick={() => setShowCreateModal(true)}>
              Create your first webhook
            </Button>
          </CardBody>
        </Card>
      )}

      <CreateWebhookModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreateWebhook}
        agents={agents}
      />

      <EditWebhookModal
        webhook={editWebhook}
        onClose={() => setEditWebhook(null)}
        onSave={handleUpdateWebhook}
        onDelete={handleDeleteWebhook}
        agents={agents}
      />

      <DeliveriesModal
        isOpen={!!selectedWebhook}
        onClose={() => setSelectedWebhook(null)}
        webhook={selectedWebhook}
      />
    </div>
  );
}

function EditWebhookModal({ webhook, onClose, onSave, onDelete, agents }) {
  const [formData, setFormData] = useState({ url: '', events: [], status: 'active' });
  const [saving, setSaving] = useState(false);
  const [newSecret, setNewSecret] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (webhook) {
      setFormData({
        url: webhook.url || '',
        events: (webhook.events || []).filter(e => WEBHOOK_EVENTS.includes(e)),
        status: webhook.status || 'active'
      });
      setNewSecret(null);
    }
  }, [webhook]);

  const toggleEvent = (event) => {
    setFormData(prev => ({
      ...prev,
      events: prev.events.includes(event)
        ? prev.events.filter(e => e !== event)
        : [...prev.events, event]
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (formData.events.length === 0) {
      alert('Select at least one event');
      return;
    }
    setSaving(true);
    try {
      await onSave(webhook.id, {
        url: formData.url,
        events: formData.events,
        status: formData.status
      });
    } finally { setSaving(false); }
  };

  const handleRotateSecret = async () => {
    if (!confirm('Rotate webhook secret? The old secret will stop working immediately.')) return;
    try {
      const result = await api.webhooks.rotateSecret(webhook.id);
      setNewSecret(result.secret);
    } catch (err) {
      console.error('Failed to rotate secret:', err);
    }
  };

  const copySecret = () => {
    navigator.clipboard.writeText(newSecret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!webhook) return null;

  return (
    <Modal isOpen={!!webhook} onClose={onClose} title="Edit Webhook" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        {newSecret && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 space-y-2">
            <p className="text-sm text-yellow-800 font-medium">New secret generated — copy it now:</p>
            <div className="flex gap-2">
              <code className="flex-1 bg-white px-3 py-2 rounded text-sm font-mono break-all border">
                {newSecret}
              </code>
              <Button type="button" variant="secondary" onClick={copySecret}>
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
          </div>
        )}

        <Input label="Webhook URL" type="url" value={formData.url} onChange={(e) => setFormData({ ...formData, url: e.target.value })} required />

        <Select label="Status" value={formData.status} onChange={(e) => setFormData({ ...formData, status: e.target.value })}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' }
          ]}
        />

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Events</label>
          <div className="grid grid-cols-2 gap-2">
            {WEBHOOK_EVENTS.map((event) => (
              <label
                key={event}
                className={`flex items-center gap-2 p-3 rounded-lg border cursor-pointer transition-colors ${
                  formData.events.includes(event)
                    ? 'border-primary-500 bg-primary-50'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={formData.events.includes(event)}
                  onChange={() => toggleEvent(event)}
                  className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-sm">{event}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex justify-between pt-4">
          <div className="flex gap-2">
            <Button type="button" variant="danger" onClick={() => onDelete(webhook.id)}>
              <Trash2 className="w-4 h-4" /> Delete
            </Button>
            <Button type="button" variant="secondary" onClick={handleRotateSecret}>
              <Key className="w-4 h-4" /> Rotate Secret
            </Button>
          </div>
          <div className="flex gap-3">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={saving}>Save</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function CreateWebhookModal({ isOpen, onClose, onSubmit, agents }) {
  const [formData, setFormData] = useState({
    agentId: '',
    url: '',
    events: []
  });
  const [loading, setLoading] = useState(false);

  const toggleEvent = (event) => {
    setFormData(prev => ({
      ...prev,
      events: prev.events.includes(event)
        ? prev.events.filter(e => e !== event)
        : [...prev.events, event]
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (formData.events.length === 0) {
      alert('Select at least one event');
      return;
    }
    setLoading(true);
    try {
      await onSubmit({
        ...formData,
        agentId: parseInt(formData.agentId)
      });
      setFormData({ agentId: '', url: '', events: [] });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Webhook" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Select
          label="Agent"
          value={formData.agentId}
          onChange={(e) => setFormData({ ...formData, agentId: e.target.value })}
          options={[
            { value: '', label: 'Select an agent' },
            ...agents.map(a => ({ value: a.id, label: a.name }))
          ]}
          required
        />

        <Input
          label="Webhook URL"
          type="url"
          value={formData.url}
          onChange={(e) => setFormData({ ...formData, url: e.target.value })}
          placeholder="https://example.com/webhook"
          required
        />

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Events
          </label>
          <div className="grid grid-cols-2 gap-2">
            {WEBHOOK_EVENTS.map((event) => (
              <label
                key={event}
                className={`
                  flex items-center gap-2 p-3 rounded-lg border cursor-pointer transition-colors
                  ${formData.events.includes(event)
                    ? 'border-primary-500 bg-primary-50'
                    : 'border-gray-200 hover:bg-gray-50'
                  }
                `}
              >
                <input
                  type="checkbox"
                  checked={formData.events.includes(event)}
                  onChange={() => toggleEvent(event)}
                  className="rounded border-gray-300 text-primary-600 focus:ring-primary-500"
                />
                <span className="text-sm">{event}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeliveriesModal({ isOpen, onClose, webhook }) {
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (webhook) {
      loadDeliveries();
    }
  }, [webhook]);

  const loadDeliveries = async () => {
    try {
      const data = await api.webhooks.getDeliveries(webhook.id);
      setDeliveries(data);
    } catch (err) {
      console.error('Failed to load deliveries:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = async (deliveryId) => {
    try {
      await api.webhooks.retryDelivery(webhook.id, deliveryId);
      loadDeliveries();
    } catch (err) {
      console.error('Failed to retry:', err);
    }
  };

  if (!webhook) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Webhook Deliveries" size="xl">
      {loading ? (
        <div className="animate-pulse space-y-2">
          <div className="h-12 bg-gray-200 rounded"></div>
          <div className="h-12 bg-gray-200 rounded"></div>
        </div>
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {deliveries.map((delivery) => (
            <div
              key={delivery.id}
              className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
            >
              <div className="flex items-center gap-4">
                <StatusBadge status={delivery.status} />
                <span className="text-sm font-mono">{delivery.eventType}</span>
                <span className="text-xs text-gray-500">
                  {safeTimeAgo(delivery.createdAt)}
                </span>
                {delivery.responseStatus && (
                  <span className="text-xs text-gray-500">
                    HTTP {delivery.responseStatus}
                  </span>
                )}
                {delivery.error && (
                  <span className="text-xs text-red-500">{delivery.error}</span>
                )}
              </div>
              {delivery.status === 'failed' && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => handleRetry(delivery.id)}
                >
                  <RefreshCw className="w-3 h-3" />
                  Retry
                </Button>
              )}
            </div>
          ))}

          {deliveries.length === 0 && (
            <p className="text-center text-gray-500 py-8">No deliveries yet</p>
          )}
        </div>
      )}
    </Modal>
  );
}

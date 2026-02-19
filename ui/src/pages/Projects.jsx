import { useState, useEffect, useCallback } from 'react';
import { Plus, Folder, Pencil, Trash2, Play, Bot } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { safeTimeAgo } from '../lib/dates';
import Button from '../components/Button';
import Card, { CardHeader, CardBody } from '../components/Card';
import { StatusBadge, PriorityBadge } from '../components/Badge';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import { Input, TextArea, Select } from '../components/Input';

export default function Projects() {
  const [projects, setProjects] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editProject, setEditProject] = useState(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [projectsData, agentsData] = await Promise.all([
        api.projects.list(),
        api.agents.list()
      ]);
      setProjects(projectsData);
      setAgents(agentsData);
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateProject = async (data) => {
    try {
      await api.projects.create(data);
      loadData();
      setShowCreateModal(false);
    } catch (err) {
      console.error('Failed to create project:', err);
    }
  };

  const handleUpdateProject = async (id, data) => {
    try {
      await api.projects.update(id, data);
      loadData();
      setEditProject(null);
    } catch (err) {
      console.error('Failed to update project:', err);
    }
  };

  const handleDeleteProject = async (id) => {
    if (!confirm('Delete this project? Tasks will be unlinked.')) return;
    try {
      await api.projects.delete(id);
      loadData();
      setEditProject(null);
    } catch (err) {
      console.error('Failed to delete project:', err);
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
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Projects</h1>
          <p className="text-gray-500">Organize tasks and knowledge by project</p>
        </div>
        <Button onClick={() => setShowCreateModal(true)}>
          <Plus className="w-4 h-4" />
          Create Project
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {projects.map((project) => (
          <Card key={project.id} className="hover:shadow-md transition-shadow">
            <CardHeader className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-primary-100 rounded-lg flex items-center justify-center">
                  <Folder className="w-5 h-5 text-primary-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">{project.name}</h3>
                  <StatusBadge status={project.status} />
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setEditProject(project)}>
                <Pencil className="w-4 h-4" />
              </Button>
            </CardHeader>
            <CardBody className="space-y-4">
              {project.description && (
                <p className="text-sm text-gray-600">{project.description}</p>
              )}
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-yellow-50 rounded-lg p-2">
                  <div className="text-lg font-semibold text-yellow-600">
                    {project.taskCounts?.pending || 0}
                  </div>
                  <div className="text-xs text-yellow-600">Pending</div>
                </div>
                <div className="bg-blue-50 rounded-lg p-2">
                  <div className="text-lg font-semibold text-blue-600">
                    {project.taskCounts?.inProgress || 0}
                  </div>
                  <div className="text-xs text-blue-600">In Progress</div>
                </div>
                <div className="bg-green-50 rounded-lg p-2">
                  <div className="text-lg font-semibold text-green-600">
                    {project.taskCounts?.completed || 0}
                  </div>
                  <div className="text-xs text-green-600">Completed</div>
                </div>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      {projects.length === 0 && (
        <Card>
          <CardBody className="text-center py-12">
            <Folder className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-500">No projects yet</p>
            <Button className="mt-4" onClick={() => setShowCreateModal(true)}>
              Create your first project
            </Button>
          </CardBody>
        </Card>
      )}

      <CreateProjectModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreateProject}
      />

      <EditProjectModal
        project={editProject}
        onClose={() => setEditProject(null)}
        onSave={handleUpdateProject}
        onDelete={handleDeleteProject}
        agents={agents}
      />
    </div>
  );
}

function EditProjectModal({ project, onClose, onSave, onDelete, agents }) {
  const [tab, setTab] = useState('overview');
  const [formData, setFormData] = useState({ name: '', description: '', status: 'active' });
  const [saving, setSaving] = useState(false);
  const [routingRules, setRoutingRules] = useState([]);
  const [defaultAgentId, setDefaultAgentId] = useState('');
  const [routingLoading, setRoutingLoading] = useState(false);
  const [routingSaving, setRoutingSaving] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testData, setTestData] = useState({ tags: '', priority: '3' });

  // Lazy-loaded tab data
  const [tasks, setTasks] = useState(null);
  const [deliverables, setDeliverables] = useState(null);
  const [knowledge, setKnowledge] = useState(null);
  const [routes, setRoutes] = useState(null);
  const [tabLoading, setTabLoading] = useState(false);

  useEffect(() => {
    if (project) {
      setFormData({
        name: project.name || '',
        description: project.description || '',
        status: project.status || 'active'
      });
      setTab('overview');
      setTestResult(null);
      // Reset lazy data
      setTasks(null);
      setDeliverables(null);
      setKnowledge(null);
      setRoutes(null);
    }
  }, [project]);

  const loadTabData = useCallback(async (tabName) => {
    if (!project) return;
    setTabLoading(true);
    try {
      if (tabName === 'tasks' && tasks === null) {
        const data = await api.tasks.list({ projectId: project.id });
        setTasks(Array.isArray(data) ? data : []);
      } else if (tabName === 'deliverables' && deliverables === null) {
        const data = await api.deliverables.list({ projectId: project.id });
        setDeliverables(Array.isArray(data) ? data : []);
      } else if (tabName === 'knowledge' && knowledge === null) {
        const data = await api.projects.getKnowledge(project.id);
        const items = data?.knowledge || data;
        setKnowledge(Array.isArray(items) ? items : []);
      } else if (tabName === 'routes' && routes === null) {
        const data = await api.routes.listForProject(project.id);
        setRoutes(Array.isArray(data) ? data : []);
      } else if (tabName === 'routing') {
        loadRoutingRules();
      }
    } catch (err) {
      console.error(`Failed to load ${tabName}:`, err);
    } finally {
      setTabLoading(false);
    }
  }, [project, tasks, deliverables, knowledge, routes]);

  useEffect(() => {
    if (project && tab !== 'overview') {
      loadTabData(tab);
    }
  }, [tab, project]);

  const loadRoutingRules = async () => {
    setRoutingLoading(true);
    try {
      const data = await api.projects.getRoutingRules(project.id);
      setRoutingRules(data.taskRoutingRules || []);
      setDefaultAgentId(data.defaultAgentId ? String(data.defaultAgentId) : '');
    } catch (err) {
      console.error('Failed to load routing rules:', err);
    } finally {
      setRoutingLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(project.id, formData);
    } finally { setSaving(false); }
  };

  const handleSaveRouting = async () => {
    setRoutingSaving(true);
    try {
      await api.projects.updateRoutingRules(project.id, {
        task_routing_rules: routingRules,
        default_agent_id: defaultAgentId ? parseInt(defaultAgentId) : null
      });
      alert('Routing rules saved.');
    } catch (err) {
      alert(`Failed to save: ${err.message}`);
    } finally { setRoutingSaving(false); }
  };

  const handleTestRouting = async () => {
    try {
      const result = await api.projects.testRoutingRules(project.id, {
        tags: testData.tags ? testData.tags.split(',').map(s => s.trim()) : [],
        priority: parseInt(testData.priority) || 3
      });
      setTestResult(result);
    } catch (err) {
      setTestResult({ matched: false, decision: err.message });
    }
  };

  const addRule = () => {
    setRoutingRules([...routingRules, {
      id: `rule-${Date.now()}`,
      name: 'New Rule',
      conditions: {},
      assign_to: null,
      fallback_to: null,
      rule_priority: routingRules.length + 1,
      enabled: true
    }]);
  };

  const updateRule = (index, updates) => {
    const updated = [...routingRules];
    updated[index] = { ...updated[index], ...updates };
    setRoutingRules(updated);
  };

  const removeRule = (index) => {
    setRoutingRules(routingRules.filter((_, i) => i !== index));
  };

  const navigate = useNavigate();

  if (!project) return null;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'tasks', label: 'Tasks' },
    { id: 'deliverables', label: 'Deliverables' },
    { id: 'knowledge', label: 'Knowledge' },
    { id: 'routes', label: 'Routes' },
    { id: 'routing', label: 'Routing' },
  ];

  const tabClass = (t) => `px-4 py-2 text-sm font-medium rounded-t-lg whitespace-nowrap ${tab === t ? 'bg-white text-gray-900 border border-b-0 border-gray-200' : 'text-gray-500 hover:text-gray-700'}`;

  const LoadingPlaceholder = () => (
    <div className="animate-pulse space-y-2">
      <div className="h-10 bg-gray-200 rounded"></div>
      <div className="h-10 bg-gray-200 rounded"></div>
      <div className="h-10 bg-gray-200 rounded"></div>
    </div>
  );

  const EmptyState = ({ message }) => (
    <p className="text-center text-gray-500 py-8 text-sm">{message}</p>
  );

  const goTo = (path, state) => { onClose(); navigate(path, { state }); };

  return (
    <Modal isOpen={!!project} onClose={onClose} title={`Project: ${project.name}`} size="xl">
      <div className="flex gap-1 mb-4 border-b border-gray-200 overflow-x-auto">
        {tabs.map(t => (
          <button key={t.id} type="button" className={tabClass(t.id)} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input label="Name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} required />
          <TextArea label="Description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} />
          <Select label="Status" value={formData.status} onChange={(e) => setFormData({ ...formData, status: e.target.value })}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'archived', label: 'Archived' },
              { value: 'completed', label: 'Completed' }
            ]}
          />
          <div className="flex justify-between pt-4">
            <Button type="button" variant="danger" onClick={() => onDelete(project.id)}>
              <Trash2 className="w-4 h-4" /> Delete
            </Button>
            <div className="flex gap-3">
              <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button type="submit" loading={saving}>Save</Button>
            </div>
          </div>
        </form>
      )}

      {tab === 'tasks' && (
        <div>
          <div className="flex justify-end mb-3">
            <Button size="sm" onClick={() => goTo('/tasks', { openCreate: true, projectId: project.id })}>
              <Plus className="w-3 h-3" /> Add Task
            </Button>
          </div>
          {tabLoading && tasks === null ? <LoadingPlaceholder /> : tasks && tasks.length > 0 ? (
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Title</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Priority</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Agent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {tasks.map(t => (
                  <tr key={t.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => goTo('/tasks', { selectTaskId: t.id })}>
                    <td className="px-4 py-2 text-sm text-gray-900">{t.title}</td>
                    <td className="px-4 py-2"><StatusBadge status={t.status} /></td>
                    <td className="px-4 py-2"><PriorityBadge priority={t.priority} /></td>
                    <td className="px-4 py-2 text-sm text-gray-600">
                      {t.agentName ? (
                        <span className="flex items-center gap-1"><Bot className="w-3 h-3 text-gray-400" />{t.agentName}</span>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyState message="No tasks in this project" />}
        </div>
      )}

      {tab === 'deliverables' && (
        <div>
          <div className="flex justify-end mb-3">
            <Button size="sm" variant="secondary" onClick={() => goTo('/deliverables')}>
              View All Deliverables
            </Button>
          </div>
          {tabLoading && deliverables === null ? <LoadingPlaceholder /> : deliverables && deliverables.length > 0 ? (
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Title</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Agent</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {deliverables.map(d => (
                  <tr key={d.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => goTo('/deliverables', { selectDeliverableId: d.id })}>
                    <td className="px-4 py-2 text-sm text-gray-900">{d.title}</td>
                    <td className="px-4 py-2"><StatusBadge status={d.status} /></td>
                    <td className="px-4 py-2 text-sm text-gray-600">
                      {d.agentName ? (
                        <span className="flex items-center gap-1"><Bot className="w-3 h-3 text-gray-400" />{d.agentName}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-500">{safeTimeAgo(d.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyState message="No deliverables in this project" />}
        </div>
      )}

      {tab === 'knowledge' && (
        <div>
          <div className="flex justify-end mb-3">
            <Button size="sm" onClick={() => goTo('/knowledge', { openCreate: true })}>
              <Plus className="w-3 h-3" /> Add Knowledge
            </Button>
          </div>
          {tabLoading && knowledge === null ? <LoadingPlaceholder /> : knowledge && knowledge.length > 0 ? (
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Title</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {knowledge.map(k => (
                  <tr key={k.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => goTo('/knowledge', { selectKnowledgeId: k.id })}>
                    <td className="px-4 py-2 text-sm text-gray-900">{k.title}</td>
                    <td className="px-4 py-2 text-sm text-gray-600">{k.category || '—'}</td>
                    <td className="px-4 py-2 text-sm text-gray-500">{safeTimeAgo(k.updatedAt || k.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyState message="No knowledge items in this project" />}
        </div>
      )}

      {tab === 'routes' && (
        <div>
          <div className="flex justify-end mb-3">
            <Button size="sm" onClick={() => goTo('/routes', { openCreate: true, projectId: project.id })}>
              <Plus className="w-3 h-3" /> Add Route
            </Button>
          </div>
          {tabLoading && routes === null ? <LoadingPlaceholder /> : routes && routes.length > 0 ? (
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Trigger Event</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Destination</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {routes.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => goTo('/routes', { selectRouteId: r.id })}>
                    <td className="px-4 py-2 text-sm text-gray-900">{r.name}</td>
                    <td className="px-4 py-2 text-sm text-gray-600">{r.triggerEvent || r.trigger_event}</td>
                    <td className="px-4 py-2 text-sm text-gray-600">{r.destinationType || r.destination_type}</td>
                    <td className="px-4 py-2">
                      <Badge variant={r.enabled !== false ? 'green' : 'gray'}>
                        {r.enabled !== false ? 'Active' : 'Disabled'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyState message="No delivery routes configured" />}
        </div>
      )}

      {tab === 'routing' && (
        <div className="space-y-4">
          {routingLoading ? (
            <LoadingPlaceholder />
          ) : (
            <>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-sm text-blue-700">
                  Routing rules automatically assign tasks to agents based on tags, priority, and capabilities.
                </p>
              </div>

              <Select label="Default Agent" value={defaultAgentId} onChange={(e) => setDefaultAgentId(e.target.value)}
                options={[
                  { value: '', label: 'None (unassigned)' },
                  ...agents.filter(a => a.status === 'active').map(a => ({ value: String(a.id), label: a.name }))
                ]}
              />

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-medium text-gray-700">Rules</h4>
                  <Button variant="secondary" size="sm" onClick={addRule}>
                    <Plus className="w-3 h-3" /> Add Rule
                  </Button>
                </div>

                <div className="space-y-3">
                  {routingRules.map((rule, i) => (
                    <div key={rule.id} className="border border-gray-200 rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <Input value={rule.name} onChange={(e) => updateRule(i, { name: e.target.value })} className="flex-1 mr-2" placeholder="Rule name" />
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1 text-sm">
                            <input type="checkbox" checked={rule.enabled} onChange={(e) => updateRule(i, { enabled: e.target.checked })}
                              className="rounded border-gray-300 text-primary-600" />
                            Enabled
                          </label>
                          <Button variant="ghost" size="sm" onClick={() => removeRule(i)}>
                            <Trash2 className="w-3 h-3 text-red-500" />
                          </Button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Input label="Tags (match any)" value={(rule.conditions?.tags?.includes_any || []).join(', ')}
                          onChange={(e) => updateRule(i, {
                            conditions: { ...rule.conditions, tags: { includes_any: e.target.value ? e.target.value.split(',').map(s => s.trim()) : [] } }
                          })} placeholder="urgent, high-priority" />
                        <Select label="Max Priority" value={rule.conditions?.priority?.lte || ''}
                          onChange={(e) => updateRule(i, {
                            conditions: { ...rule.conditions, priority: e.target.value ? { lte: parseInt(e.target.value) } : undefined }
                          })}
                          options={[
                            { value: '', label: 'Any' },
                            { value: '1', label: '1 (Critical only)' },
                            { value: '2', label: '2 (High+)' },
                            { value: '3', label: '3 (Medium+)' },
                            { value: '4', label: '4 (All)' }
                          ]}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Select label="Assign to" value={rule.assign_to ? String(rule.assign_to) : ''}
                          onChange={(e) => updateRule(i, { assign_to: e.target.value ? parseInt(e.target.value) : null })}
                          options={[
                            { value: '', label: 'None' },
                            ...agents.filter(a => a.status === 'active').map(a => ({ value: String(a.id), label: a.name }))
                          ]}
                        />
                        <Select label="Fallback to" value={rule.fallback_to ? String(rule.fallback_to) : ''}
                          onChange={(e) => updateRule(i, { fallback_to: e.target.value ? parseInt(e.target.value) : null })}
                          options={[
                            { value: '', label: 'None' },
                            ...agents.filter(a => a.status === 'active').map(a => ({ value: String(a.id), label: a.name }))
                          ]}
                        />
                      </div>
                    </div>
                  ))}

                  {routingRules.length === 0 && (
                    <p className="text-center text-gray-500 py-4 text-sm">No routing rules. Tasks will use the default agent.</p>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <Button variant="secondary" onClick={onClose}>Cancel</Button>
                <Button onClick={handleSaveRouting} loading={routingSaving}>Save Rules</Button>
              </div>

              <div className="border-t border-gray-200 pt-4">
                <h4 className="text-sm font-medium text-gray-700 mb-2">Test Routing</h4>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <Input label="Tags" value={testData.tags} onChange={(e) => setTestData({ ...testData, tags: e.target.value })} placeholder="urgent, code" />
                  <Select label="Priority" value={testData.priority} onChange={(e) => setTestData({ ...testData, priority: e.target.value })}
                    options={[
                      { value: '1', label: '1 - Critical' },
                      { value: '2', label: '2 - High' },
                      { value: '3', label: '3 - Medium' },
                      { value: '4', label: '4 - Low' }
                    ]}
                  />
                </div>
                <Button variant="secondary" size="sm" onClick={handleTestRouting}>
                  <Play className="w-3 h-3" /> Test
                </Button>
                {testResult && (
                  <div className={`mt-2 p-3 rounded-lg text-sm ${testResult.matched ? 'bg-green-50 border border-green-200' : 'bg-gray-50 border border-gray-200'}`}>
                    {testResult.matched ? (
                      <p className="text-green-700">
                        Matched rule "{testResult.ruleName}" → Agent: {testResult.agent?.name || 'unknown'}
                        {testResult.agent?.currentLoad && <span className="text-gray-500"> (load: {testResult.agent.currentLoad})</span>}
                      </p>
                    ) : (
                      <p className="text-gray-600">No rule matched. Decision: {testResult.decision}</p>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function CreateProjectModal({ isOpen, onClose, onSubmit }) {
  const [formData, setFormData] = useState({ name: '', description: '' });
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit(formData);
      setFormData({ name: '', description: '' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Project">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="Project name" required />
        <TextArea label="Description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="What is this project about?" />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Create</Button>
        </div>
      </form>
    </Modal>
  );
}

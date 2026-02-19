import { useState, useEffect, useMemo } from 'react';
import { Plus, Pencil, Trash2, Bot, Eye, Play, AlertTriangle, ListTodo, ChevronUp, ChevronDown } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { safeTimeAgo } from '../lib/dates';
import Button from '../components/Button';
import Card, { CardHeader, CardBody } from '../components/Card';
import { StatusBadge, PriorityBadge } from '../components/Badge';
import Modal from '../components/Modal';
import { Input, TextArea, Select } from '../components/Input';

/**
 * Build grouped agent options for Select dropdowns.
 * Groups into "People" (human agents) and "AI Agents", with optional prefix items.
 */
function buildAgentOptions(agents, { prefix = [], activeOnly = false } = {}) {
  const list = activeOnly ? agents.filter(a => a.status === 'active') : agents;
  const people = list.filter(a => a.executionMode === 'human');
  const ai = list.filter(a => a.executionMode !== 'human');

  const groups = [];
  if (people.length > 0) {
    groups.push({ group: 'People', options: people.map(a => ({ value: a.id, label: a.name })) });
  }
  if (ai.length > 0) {
    groups.push({ group: 'AI Agents', options: ai.map(a => ({ value: a.id, label: a.name })) });
  }

  return [...prefix, ...groups];
}

export default function Tasks() {
  const location = useLocation();
  const [tasks, setTasks] = useState([]);
  const [agents, setAgents] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ status: '', agentId: '', projectId: '' });
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editTask, setEditTask] = useState(null);
  const [sortField, setSortField] = useState('createdAt');
  const [sortDir, setSortDir] = useState('desc');

  useEffect(() => {
    if (location.state?.openCreate) {
      setShowCreateModal(true);
      if (location.state.projectId) {
        setFilter(f => ({ ...f, projectId: String(location.state.projectId) }));
      }
      window.history.replaceState({}, '');
    } else if (location.state?.selectTaskId) {
      api.tasks.get(location.state.selectTaskId).then(task => setEditTask(task)).catch(() => {});
      window.history.replaceState({}, '');
    }
  }, [location.state]);

  useEffect(() => {
    loadData();
  }, [filter]);

  const loadData = async () => {
    try {
      const [tasksData, agentsData, projectsData] = await Promise.all([
        api.tasks.list(filter),
        api.agents.list(),
        api.projects.list()
      ]);
      setTasks(tasksData);
      setAgents(agentsData);
      setProjects(projectsData);
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTask = async (data) => {
    try {
      await api.tasks.create(data);
      loadData();
      setShowCreateModal(false);
    } catch (err) {
      console.error('Failed to create task:', err);
    }
  };

  const handleUpdateTask = async (id, data) => {
    try {
      await api.tasks.update(id, data);
      loadData();
      setEditTask(null);
    } catch (err) {
      console.error('Failed to update task:', err);
    }
  };

  const handleDeleteTask = async (id) => {
    if (!confirm('Delete this task?')) return;
    try {
      await api.tasks.delete(id);
      loadData();
      setEditTask(null);
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  };

  const toggleSort = (field) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const SortIcon = ({ field }) => {
    if (sortField !== field) return null;
    return sortDir === 'asc' ? <ChevronUp className="w-3 h-3 inline ml-1" /> : <ChevronDown className="w-3 h-3 inline ml-1" />;
  };

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      let av = a[sortField], bv = b[sortField];
      if (sortField === 'title' || sortField === 'status' || sortField === 'agentName') {
        av = (av || '').toLowerCase();
        bv = (bv || '').toLowerCase();
      }
      if (sortField === 'priority') {
        av = av ?? 99;
        bv = bv ?? 99;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [tasks, sortField, sortDir]);

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
          <h1 className="text-2xl font-bold text-gray-900">Tasks</h1>
          <p className="text-gray-500">Manage and assign tasks to agents</p>
        </div>
        <Button onClick={() => setShowCreateModal(true)}>
          <Plus className="w-4 h-4" />
          Create Task
        </Button>
      </div>

      <div className="flex gap-4 mb-6">
        <Select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}
          options={[
            { value: '', label: 'All Statuses' },
            { value: 'pending', label: 'Pending' },
            { value: 'assigned', label: 'Assigned' },
            { value: 'in_progress', label: 'In Progress' },
            { value: 'review', label: 'In Review' },
            { value: 'completed', label: 'Completed' }
          ]} className="w-40"
        />
        <Select value={filter.agentId} onChange={(e) => setFilter({ ...filter, agentId: e.target.value })}
          options={buildAgentOptions(agents, { prefix: [{ value: '', label: 'All Agents' }] })}
          className="w-40"
        />
        <Select value={filter.projectId} onChange={(e) => setFilter({ ...filter, projectId: e.target.value })}
          options={[
            { value: '', label: 'All Projects' },
            ...projects.map(p => ({ value: p.id, label: p.name }))
          ]} className="w-40"
        />
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('title')}>Title<SortIcon field="title" /></th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('status')}>Status<SortIcon field="status" /></th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('priority')}>Priority<SortIcon field="priority" /></th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('agentName')}>Agent<SortIcon field="agentName" /></th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Project</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('createdAt')}>Created<SortIcon field="createdAt" /></th>
                <th className="px-6 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {sortedTasks.map((task) => (
                <tr key={task.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div>
                      <div className="font-medium text-gray-900">{task.title}</div>
                      {task.description && (
                        <div className="text-sm text-gray-500 truncate max-w-md">{task.description}</div>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={task.status} />
                      {task.context?.lastExecutionError && (
                        <span title={task.context.lastExecutionError.error} className="text-red-500">
                          <AlertTriangle className="w-4 h-4" />
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4"><PriorityBadge priority={task.priority} /></td>
                  <td className="px-6 py-4">
                    {task.agentName ? (
                      <div className="flex items-center gap-2">
                        <Bot className="w-4 h-4 text-gray-400" />
                        <span className="text-sm">{task.agentName}</span>
                      </div>
                    ) : (
                      <span className="text-sm text-gray-400">Unassigned</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-sm text-gray-600">{task.projectName || '-'}</span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-sm text-gray-500">{safeTimeAgo(task.createdAt)}</span>
                  </td>
                  <td className="px-6 py-4">
                    <Button size="sm" variant="ghost" onClick={() => setEditTask(task)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {tasks.length === 0 && (
          <CardBody className="text-center py-12">
            <ListTodo className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-500 mb-1">No tasks found</p>
            {projects.length === 0 && (
              <p className="text-sm text-gray-400">Create a project first, then add tasks for your agents.</p>
            )}
            {projects.length > 0 && agents.length === 0 && (
              <p className="text-sm text-gray-400">Register an agent in the Agents page, then create tasks to assign to them.</p>
            )}
          </CardBody>
        )}
      </Card>

      <CreateTaskModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreateTask}
        agents={agents}
        projects={projects}
      />

      <EditTaskModal
        task={editTask}
        onClose={() => setEditTask(null)}
        onSave={handleUpdateTask}
        onDelete={handleDeleteTask}
        onExecuted={loadData}
        agents={agents}
        projects={projects}
      />
    </div>
  );
}

function EditTaskModal({ task, onClose, onSave, onDelete, onExecuted, agents, projects }) {
  const [formData, setFormData] = useState({ title: '', description: '', projectId: '', assignedAgentId: '', priority: '2', status: 'pending', dueDate: '', tags: '' });
  const [saving, setSaving] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState(null);
  const [context, setContext] = useState(null);
  const [showContext, setShowContext] = useState(false);
  const [contextLoading, setContextLoading] = useState(false);

  // Parse execution error from task context
  const execError = task?.context?.lastExecutionError;

  useEffect(() => {
    if (task) {
      const taskTags = Array.isArray(task.tags) ? task.tags.join(', ') : (task.tags || '');
      // Extract date portion from ISO timestamp for date input
      const dueDateValue = task.dueDate ? task.dueDate.split('T')[0] : '';
      setFormData({
        title: task.title || '',
        description: task.description || '',
        projectId: task.projectId ? String(task.projectId) : '',
        assignedAgentId: task.assignedAgentId ? String(task.assignedAgentId) : '',
        priority: String(task.priority || 2),
        status: task.status || 'pending',
        dueDate: dueDateValue,
        tags: taskTags
      });
      setContext(null);
      setShowContext(false);
      setExecResult(null);
    }
  }, [task]);

  const handleExecute = async () => {
    setExecuting(true);
    setExecResult(null);
    try {
      const result = await api.tasks.execute(task.id);
      setExecResult(result);
      if (onExecuted) onExecuted();
    } catch (err) {
      setExecResult({ success: false, error: err.message });
    } finally {
      setExecuting(false);
    }
  };

  const loadContext = async () => {
    if (context) { setShowContext(!showContext); return; }
    setContextLoading(true);
    try {
      const data = await api.tasks.getContext(task.id);
      setContext(data);
      setShowContext(true);
    } catch (err) {
      console.error('Failed to load context:', err);
    } finally { setContextLoading(false); }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave(task.id, {
        title: formData.title,
        description: formData.description,
        projectId: formData.projectId ? parseInt(formData.projectId) : null,
        assignedAgentId: (formData.assignedAgentId && formData.assignedAgentId !== 'auto') ? parseInt(formData.assignedAgentId) : null,
        priority: parseInt(formData.priority),
        status: formData.status,
        dueDate: formData.dueDate || null,
        tags: formData.tags ? formData.tags.split(',').map(s => s.trim()).filter(Boolean) : []
      });
    } finally { setSaving(false); }
  };

  if (!task) return null;

  return (
    <Modal isOpen={!!task} onClose={onClose} title="Edit Task">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Title" value={formData.title} onChange={(e) => setFormData({ ...formData, title: e.target.value })} required />
        <TextArea label="Description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} />
        <div className="grid grid-cols-3 gap-4">
          <Select label="Status" value={formData.status} onChange={(e) => setFormData({ ...formData, status: e.target.value })}
            options={[
              { value: 'pending', label: 'Pending' },
              { value: 'assigned', label: 'Assigned' },
              { value: 'in_progress', label: 'In Progress' },
              { value: 'review', label: 'In Review' },
              { value: 'completed', label: 'Completed' },
              { value: 'cancelled', label: 'Cancelled' }
            ]}
          />
          <Select label="Priority" value={formData.priority} onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
            options={[
              { value: '1', label: 'Critical' },
              { value: '2', label: 'High' },
              { value: '3', label: 'Medium' },
              { value: '4', label: 'Low' }
            ]}
          />
          <Input label="Due Date" type="date" value={formData.dueDate} onChange={(e) => setFormData({ ...formData, dueDate: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Select label="Project" value={formData.projectId} onChange={(e) => setFormData({ ...formData, projectId: e.target.value })}
            options={[{ value: '', label: 'None' }, ...projects.map(p => ({ value: p.id, label: p.name }))]}
          />
          <Select label="Assign to Agent" value={formData.assignedAgentId} onChange={(e) => setFormData({ ...formData, assignedAgentId: e.target.value })}
            options={buildAgentOptions(agents, {
              activeOnly: true,
              prefix: [
                { value: '', label: 'Unassigned' },
                { value: 'auto', label: 'Auto-assign (best available)' }
              ]
            })}
          />
        </div>
        <TagInput value={formData.tags} onChange={(v) => setFormData({ ...formData, tags: v })} />
        {/* Execution error banner */}
        {execError && !execResult && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-red-800">Execution failed</p>
              <p className="text-sm text-red-600 mt-0.5">{execError.error}</p>
              <p className="text-xs text-red-400 mt-1">
                {execError.agent} · {safeTimeAgo(execError.timestamp)}
                {execError.retryable && ' · Will auto-retry'}
              </p>
            </div>
          </div>
        )}

        {/* Execution result */}
        {execResult && (
          <div className={`rounded-lg p-3 border ${execResult.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
            <p className={`text-sm font-medium ${execResult.success ? 'text-green-800' : 'text-red-800'}`}>
              {execResult.success
                ? `Executed successfully — deliverable #${execResult.deliverableId} created`
                : `Execution failed: ${execResult.error}`}
            </p>
          </div>
        )}

        {/* Execute + Context buttons */}
        <div className="border-t border-gray-200 pt-4 flex items-center gap-4">
          {task.assignedAgentId && ['pending', 'assigned'].includes(task.status) &&
            agents.find(a => String(a.id) === String(task.assignedAgentId))?.executionMode !== 'human' && (
            <Button type="button" size="sm" variant="secondary" onClick={handleExecute} loading={executing}>
              <Play className="w-4 h-4" /> Execute Now
            </Button>
          )}
          <button type="button" onClick={loadContext}
            className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            <Eye className="w-4 h-4" />
            {contextLoading ? 'Loading...' : showContext ? 'Hide Context' : 'View Context'}
          </button>

          {showContext && context && (
            <div className="mt-3 space-y-3 max-h-64 overflow-y-auto">
              {context.knowledge?.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Knowledge</h4>
                  {context.knowledge.map((k, i) => (
                    <div key={i} className="text-sm bg-gray-50 rounded p-2 mb-1">
                      <span className="font-medium">{k.title}</span>
                      {k.category && <span className="text-xs text-gray-400 ml-2">{k.category}</span>}
                    </div>
                  ))}
                </div>
              )}
              {context.deliverables?.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Deliverables</h4>
                  {context.deliverables.map((d, i) => (
                    <div key={i} className="text-sm bg-gray-50 rounded p-2 mb-1 flex items-center justify-between">
                      <span className="font-medium">{d.title}</span>
                      <StatusBadge status={d.status} />
                    </div>
                  ))}
                </div>
              )}
              {context.history?.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">History</h4>
                  {context.history.map((h, i) => (
                    <div key={i} className="text-sm text-gray-600 bg-gray-50 rounded p-2 mb-1">
                      <span className="font-medium">{h.action || h.event}</span>
                      <span className="text-xs text-gray-400 ml-2">{safeTimeAgo(h.createdAt || h.timestamp)}</span>
                    </div>
                  ))}
                </div>
              )}
              {!context.knowledge?.length && !context.deliverables?.length && !context.history?.length && (
                <p className="text-sm text-gray-400">No context available for this task.</p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-between pt-4">
          <Button type="button" variant="danger" onClick={() => onDelete(task.id)}>
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

const TAG_SUGGESTIONS = ['urgent', 'content', 'code', 'research', 'design', 'review', 'bug-fix', 'feature'];

function TagInput({ value, onChange }) {
  const addChip = (tag) => {
    const existing = value ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (!existing.includes(tag)) {
      onChange(existing.length > 0 ? `${value.trimEnd()}, ${tag}` : tag);
    }
  };

  return (
    <div>
      <Input label="Tags (comma-separated)" value={value} onChange={(e) => onChange(e.target.value)} placeholder="urgent, code, review" />
      <div className="flex flex-wrap gap-1 mt-1.5">
        {TAG_SUGGESTIONS.map((tag) => {
          const existing = value ? value.split(',').map(s => s.trim()) : [];
          const active = existing.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={() => addChip(tag)}
              className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                active
                  ? 'bg-primary-100 border-primary-300 text-primary-700 cursor-default'
                  : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100 hover:border-gray-300'
              }`}
            >
              {tag}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CreateTaskModal({ isOpen, onClose, onSubmit, agents, projects }) {
  const [formData, setFormData] = useState({ title: '', description: '', projectId: '', assignedAgentId: '', priority: '2', dueDate: '', tags: '' });
  const [loading, setLoading] = useState(false);

  const showAutoHint = formData.assignedAgentId === 'auto' && !formData.projectId;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onSubmit({
        title: formData.title,
        description: formData.description,
        projectId: formData.projectId ? parseInt(formData.projectId) : null,
        assignedAgentId: (formData.assignedAgentId && formData.assignedAgentId !== 'auto') ? parseInt(formData.assignedAgentId) : null,
        priority: parseInt(formData.priority),
        dueDate: formData.dueDate || null,
        tags: formData.tags ? formData.tags.split(',').map(s => s.trim()).filter(Boolean) : []
      });
      setFormData({ title: '', description: '', projectId: '', assignedAgentId: '', priority: '2', dueDate: '', tags: '' });
    } finally { setLoading(false); }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Task">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Title" value={formData.title} onChange={(e) => setFormData({ ...formData, title: e.target.value })} placeholder="Task title" required />
        <TextArea label="Description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="Describe what needs to be done..." />
        <div className="grid grid-cols-2 gap-4">
          <Select label="Project" value={formData.projectId} onChange={(e) => setFormData({ ...formData, projectId: e.target.value })}
            options={[{ value: '', label: 'None' }, ...projects.map(p => ({ value: p.id, label: p.name }))]}
          />
          <div>
            <Select label="Assign to Agent" value={formData.assignedAgentId} onChange={(e) => setFormData({ ...formData, assignedAgentId: e.target.value })}
              options={buildAgentOptions(agents, {
                prefix: [{ value: '', label: 'Unassigned' }, { value: 'auto', label: 'Auto-assign (best available)' }],
                activeOnly: true
              })}
            />
            {showAutoHint && (
              <p className="text-xs text-amber-600 mt-1">Select a project for auto-assign to work via routing rules.</p>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Select label="Priority" value={formData.priority} onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
            options={[{ value: '1', label: 'Critical' }, { value: '2', label: 'High' }, { value: '3', label: 'Medium' }, { value: '4', label: 'Low' }]}
          />
          <Input label="Due Date" type="date" value={formData.dueDate} onChange={(e) => setFormData({ ...formData, dueDate: e.target.value })} />
        </div>
        <TagInput value={formData.tags} onChange={(v) => setFormData({ ...formData, tags: v })} />
        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Create</Button>
        </div>
      </form>
    </Modal>
  );
}

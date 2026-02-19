import { useState, useEffect } from 'react';
import { Plus, Search, BookOpen, Tag, Trash2, Pencil } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import Button from '../components/Button';
import Card, { CardHeader, CardBody } from '../components/Card';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import { Input, TextArea, Select } from '../components/Input';
import { safeTimeAgo } from '../lib/dates';

export default function Knowledge() {
  const location = useLocation();
  const [knowledge, setKnowledge] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);

  useEffect(() => {
    if (location.state?.openCreate) {
      setShowCreateModal(true);
      window.history.replaceState({}, '');
    } else if (location.state?.selectKnowledgeId) {
      api.knowledge.get(location.state.selectKnowledgeId).then(item => setSelectedItem(item)).catch(() => {});
      window.history.replaceState({}, '');
    }
  }, [location.state]);

  useEffect(() => {
    loadData();
  }, [projectFilter]);

  const loadData = async () => {
    try {
      const [knowledgeData, projectsData] = await Promise.all([
        api.knowledge.list(projectFilter ? { projectId: projectFilter } : {}),
        api.projects.list()
      ]);
      setKnowledge(knowledgeData);
      setProjects(projectsData);
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = async () => {
    if (!search.trim()) {
      loadData();
      return;
    }

    try {
      const data = await api.knowledge.search({
        q: search,
        ...(projectFilter ? { projectId: projectFilter } : {})
      });
      setKnowledge(data);
    } catch (err) {
      console.error('Failed to search:', err);
    }
  };

  const handleCreateKnowledge = async (data) => {
    await api.knowledge.create(data);
    loadData();
    setShowCreateModal(false);
  };

  const handleUpdateKnowledge = async (id, data) => {
    await api.knowledge.update(id, data);
    loadData();
    setSelectedItem(null);
  };

  const handleDeleteKnowledge = async (id) => {
    if (!confirm('Delete this knowledge entry?')) return;
    try {
      await api.knowledge.delete(id);
      loadData();
      setSelectedItem(null);
    } catch (err) {
      console.error('Failed to delete knowledge:', err);
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
          <h1 className="text-2xl font-bold text-gray-900">Knowledge Base</h1>
          <p className="text-gray-500">Project documentation and context for agents</p>
        </div>
        <Button onClick={() => setShowCreateModal(true)}>
          <Plus className="w-4 h-4" />
          Add Knowledge
        </Button>
      </div>

      <div className="flex gap-4 mb-6">
        <div className="flex-1 flex gap-2">
          <Input
            placeholder="Search knowledge base..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="flex-1"
          />
          <Button variant="secondary" onClick={handleSearch}>
            <Search className="w-4 h-4" />
          </Button>
        </div>
        <Select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          options={[
            { value: '', label: 'All Projects' },
            ...projects.map(p => ({ value: p.id, label: p.name }))
          ]}
          className="w-48"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {knowledge.map((item) => (
          <Card
            key={item.id}
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => setSelectedItem(item)}
          >
            <CardBody>
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <BookOpen className="w-5 h-5 text-purple-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900 truncate">{item.title}</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    {item.projectName || 'No project'}
                    {item.category && ` • ${item.category}`}
                  </p>

                  {item.snippet && (
                    <p className="text-sm text-gray-600 mt-2 line-clamp-2">
                      {item.snippet}
                    </p>
                  )}

                  {item.tags?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {item.tags.slice(0, 3).map((tag, i) => (
                        <Badge key={i} variant="purple">{tag}</Badge>
                      ))}
                      {item.tags.length > 3 && (
                        <Badge variant="gray">+{item.tags.length - 3}</Badge>
                      )}
                    </div>
                  )}

                  <p className="text-xs text-gray-400 mt-2">
                    Updated {safeTimeAgo(item.updatedAt)}
                  </p>
                </div>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      {knowledge.length === 0 && (
        <Card>
          <CardBody className="text-center py-12">
            <BookOpen className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-500">
              {search ? 'No results found' : 'No knowledge entries yet'}
            </p>
            {!search && (
              <Button className="mt-4" onClick={() => setShowCreateModal(true)}>
                Add your first entry
              </Button>
            )}
          </CardBody>
        </Card>
      )}

      <CreateKnowledgeModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreateKnowledge}
        projects={projects}
      />

      <EditKnowledgeModal
        item={selectedItem}
        onClose={() => setSelectedItem(null)}
        onSave={handleUpdateKnowledge}
        onDelete={handleDeleteKnowledge}
        projects={projects}
      />
    </div>
  );
}

function EditKnowledgeModal({ item, onClose, onSave, onDelete, projects }) {
  const [formData, setFormData] = useState({ title: '', content: '', projectId: '', category: '', tags: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (item) {
      setFormData({
        title: item.title || '',
        content: item.content || '',
        projectId: item.projectId ? String(item.projectId) : '',
        category: item.category || '',
        tags: (item.tags || []).join(', ')
      });
    }
  }, [item]);

  useEffect(() => {
    if (item) setError(null);
  }, [item]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(item.id, {
        title: formData.title,
        content: formData.content,
        projectId: formData.projectId ? parseInt(formData.projectId) : null,
        category: formData.category || null,
        tags: formData.tags ? formData.tags.split(',').map(s => s.trim()) : []
      });
    } catch (err) {
      setError(err.message || 'Failed to update knowledge entry');
    } finally { setSaving(false); }
  };

  if (!item) return null;

  return (
    <Modal isOpen={!!item} onClose={onClose} title="Edit Knowledge" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
        <Input label="Title" value={formData.title} onChange={(e) => setFormData({ ...formData, title: e.target.value })} required />

        <div className="grid grid-cols-2 gap-4">
          <Select label="Project" value={formData.projectId} onChange={(e) => setFormData({ ...formData, projectId: e.target.value })}
            options={[{ value: '', label: 'None' }, ...projects.map(p => ({ value: p.id, label: p.name }))]}
          />
          <Input label="Category" value={formData.category} onChange={(e) => setFormData({ ...formData, category: e.target.value })} placeholder="e.g., guidelines, reference" />
        </div>

        <TextArea label="Content (Markdown)" value={formData.content} onChange={(e) => setFormData({ ...formData, content: e.target.value })} rows={10} required />

        <Input label="Tags (comma-separated)" value={formData.tags} onChange={(e) => setFormData({ ...formData, tags: e.target.value })} placeholder="api, integration, guide" />

        <div className="flex justify-between pt-4">
          <Button type="button" variant="danger" onClick={() => onDelete(item.id)}>
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

function CreateKnowledgeModal({ isOpen, onClose, onSubmit, projects }) {
  const [formData, setFormData] = useState({
    title: '',
    content: '',
    projectId: '',
    category: '',
    tags: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await onSubmit({
        ...formData,
        projectId: formData.projectId ? parseInt(formData.projectId) : null,
        tags: formData.tags ? formData.tags.split(',').map(s => s.trim()) : []
      });
      setFormData({ title: '', content: '', projectId: '', category: '', tags: '' });
    } catch (err) {
      setError(err.message || 'Failed to create knowledge entry');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Knowledge" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
        <Input
          label="Title"
          value={formData.title}
          onChange={(e) => setFormData({ ...formData, title: e.target.value })}
          placeholder="Knowledge entry title"
          required
        />

        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Project"
            value={formData.projectId}
            onChange={(e) => setFormData({ ...formData, projectId: e.target.value })}
            options={[
              { value: '', label: 'None' },
              ...projects.map(p => ({ value: p.id, label: p.name }))
            ]}
          />
          <Input
            label="Category"
            value={formData.category}
            onChange={(e) => setFormData({ ...formData, category: e.target.value })}
            placeholder="e.g., guidelines, reference"
          />
        </div>

        <TextArea
          label="Content (Markdown)"
          value={formData.content}
          onChange={(e) => setFormData({ ...formData, content: e.target.value })}
          placeholder="Enter the knowledge content..."
          rows={10}
          required
        />

        <Input
          label="Tags (comma-separated)"
          value={formData.tags}
          onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
          placeholder="api, integration, guide"
        />

        <div className="flex justify-end gap-3 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

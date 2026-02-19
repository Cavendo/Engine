import { useState, useEffect, useMemo } from 'react';
import { CheckCircle, XCircle, RotateCcw, Eye, Folder, Bot, ListTodo, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import Button from '../components/Button';
import Card, { CardHeader, CardBody } from '../components/Card';
import { StatusBadge } from '../components/Badge';
import Modal from '../components/Modal';
import { TextArea, Select } from '../components/Input';
import { safeTimeAgo } from '../lib/dates';
import ContentRenderer from '../components/ContentRenderer';
import FileList from '../components/FileList';

export default function Review() {
  const [deliverables, setDeliverables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDeliverable, setSelectedDeliverable] = useState(null);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [setupStatus, setSetupStatus] = useState(null);
  const [agents, setAgents] = useState([]);
  const [projects, setProjects] = useState([]);
  const [sortBy, setSortBy] = useState('newest');
  const [filterAgent, setFilterAgent] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    loadDeliverables();
    loadSetupStatus();
  }, []);

  const loadSetupStatus = async () => {
    try {
      const [projectsData, agentsData, tasks] = await Promise.all([
        api.projects.list(),
        api.agents.list(),
        api.tasks.list({ limit: 1 })
      ]);
      const projectsList = Array.isArray(projectsData) ? projectsData : [];
      const agentsList = Array.isArray(agentsData) ? agentsData : [];
      setProjects(projectsList);
      setAgents(agentsList);
      setSetupStatus({
        projects: projectsList.length,
        agents: agentsList.length,
        tasks: Array.isArray(tasks) ? tasks.length : 0
      });
    } catch (_) {
      // Non-critical, don't block the page
    }
  };

  const loadDeliverables = async () => {
    try {
      const data = await api.deliverables.pending();
      setDeliverables(data);
    } catch (err) {
      console.error('Failed to load deliverables:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleReview = async (id, decision, feedback) => {
    try {
      await api.deliverables.review(id, decision, feedback);
      loadDeliverables();
      setShowReviewModal(false);
      setSelectedDeliverable(null);
    } catch (err) {
      console.error('Failed to review:', err);
    }
  };

  const openReview = async (deliverable) => {
    try {
      const full = await api.deliverables.get(deliverable.id);
      setSelectedDeliverable(full);
      setShowReviewModal(true);
    } catch (err) {
      console.error('Failed to load deliverable:', err);
    }
  };

  const filteredDeliverables = useMemo(() => {
    let result = [...deliverables];
    if (filterAgent) result = result.filter(d => String(d.agentId) === filterAgent);
    if (filterProject) result = result.filter(d => String(d.projectId) === filterProject);
    if (sortBy === 'newest') result.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    else if (sortBy === 'oldest') result.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    else if (sortBy === 'title') result.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    return result;
  }, [deliverables, filterAgent, filterProject, sortBy]);

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
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Review Queue</h1>
        <p className="text-gray-500">Review and approve agent deliverables</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card>
          <CardBody className="text-center">
            <div className="text-3xl font-bold text-yellow-600">{deliverables.length}</div>
            <div className="text-sm text-gray-500">Pending Review</div>
          </CardBody>
        </Card>
      </div>

      {/* Filter Bar */}
      {deliverables.length > 0 && (
        <div className="flex gap-3 mb-6">
          <Select value={filterAgent} onChange={(e) => setFilterAgent(e.target.value)}
            options={[{ value: '', label: 'All Agents' }, ...agents.map(a => ({ value: String(a.id), label: a.name }))]}
            className="w-40"
          />
          <Select value={filterProject} onChange={(e) => setFilterProject(e.target.value)}
            options={[{ value: '', label: 'All Projects' }, ...projects.map(p => ({ value: String(p.id), label: p.name }))]}
            className="w-40"
          />
          <Select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
            options={[
              { value: 'newest', label: 'Newest First' },
              { value: 'oldest', label: 'Oldest First' },
              { value: 'title', label: 'Title A-Z' }
            ]}
            className="w-40"
          />
        </div>
      )}

      {/* Deliverables List */}
      <div className="space-y-4">
        {filteredDeliverables.map((deliverable) => (
          <Card key={deliverable.id}>
            <CardBody>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="font-semibold text-gray-900">{deliverable.title}</h3>
                    <StatusBadge status={deliverable.status} />
                    <span className="text-sm text-gray-500">v{deliverable.version}</span>
                  </div>

                  <div className="text-sm text-gray-600 space-y-1">
                    <p>
                      <span className="font-medium">Task:</span> {deliverable.taskTitle}
                    </p>
                    <p>
                      <span className="font-medium">Agent:</span> {deliverable.agentName}
                    </p>
                    {deliverable.projectName && (
                      <p>
                        <span className="font-medium">Project:</span> {deliverable.projectName}
                      </p>
                    )}
                    <p className="text-gray-400">
                      Submitted {safeTimeAgo(deliverable.createdAt)}
                    </p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openReview(deliverable)}
                  >
                    <Eye className="w-4 h-4" />
                    Review
                  </Button>
                </div>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      {deliverables.length === 0 && setupStatus && (setupStatus.agents === 0 || setupStatus.tasks === 0) && (
        <Card>
          <CardHeader>
            <h3 className="font-semibold text-gray-900">Getting Started</h3>
            <p className="text-sm text-gray-500">Follow these steps to start using Cavendo Engine</p>
          </CardHeader>
          <CardBody className="space-y-3">
            <SetupStep
              number={1}
              title="Create a project"
              description="Projects organize your tasks, knowledge, and delivery routes."
              done={setupStatus.projects > 0}
              onClick={() => navigate('/projects')}
            />
            <SetupStep
              number={2}
              title="Register an agent"
              description="Add an AI agent (Claude, GPT, or external via MCP) to do the work."
              done={setupStatus.agents > 0}
              onClick={() => navigate('/agents')}
            />
            <SetupStep
              number={3}
              title="Create a task"
              description="Assign a task to your agent. If execution is set to automatic, the agent will start immediately."
              done={setupStatus.tasks > 0}
              onClick={() => navigate('/tasks')}
            />
            <SetupStep
              number={4}
              title="Review deliverables"
              description="When the agent completes a task, its deliverable appears here for your review."
              done={false}
            />
          </CardBody>
        </Card>
      )}

      {deliverables.length === 0 && (!setupStatus || (setupStatus.agents > 0 && setupStatus.tasks > 0)) && (
        <Card>
          <CardBody className="text-center py-12">
            <CheckCircle className="w-12 h-12 text-green-500 mx-auto mb-4" />
            <p className="text-gray-500">All caught up! No deliverables pending review.</p>
          </CardBody>
        </Card>
      )}

      {/* Review Modal */}
      <ReviewModal
        isOpen={showReviewModal}
        onClose={() => {
          setShowReviewModal(false);
          setSelectedDeliverable(null);
        }}
        deliverable={selectedDeliverable}
        onReview={handleReview}
      />
    </div>
  );
}

function ReviewModal({ isOpen, onClose, deliverable, action, onReview }) {
  const [feedback, setFeedback] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [viewData, setViewData] = useState(null);
  const [loadingVersion, setLoadingVersion] = useState(false);

  useEffect(() => {
    if (deliverable) {
      setFeedback('');
      setViewData(deliverable);
    }
  }, [deliverable]);

  const loadVersion = async (versionId) => {
    setLoadingVersion(true);
    try {
      const data = await api.deliverables.get(versionId);
      setViewData(data);
    } catch (err) {
      console.error('Failed to load version:', err);
    } finally {
      setLoadingVersion(false);
    }
  };

  const handleAction = async (decision) => {
    setReviewing(true);
    try {
      await onReview(deliverable.id, decision, feedback || undefined);
      setFeedback('');
    } finally {
      setReviewing(false);
    }
  };

  if (!deliverable) return null;

  const d = viewData || deliverable;
  const versions = d.versions || [];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Deliverable: ${d.title}`} size="xl">
      <div className="space-y-4">
        {loadingVersion && (
          <div className="animate-pulse h-2 bg-primary-200 rounded"></div>
        )}

        {/* Metadata */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm bg-gray-50 border border-gray-200 rounded-lg p-4">
          <div>
            <span className="text-gray-500">Status:</span>{' '}
            <StatusBadge status={d.status} />
          </div>
          <div>
            <span className="text-gray-500">Created:</span>{' '}
            <span className="text-gray-700">{safeTimeAgo(d.createdAt)}</span>
          </div>
          <div>
            <span className="text-gray-500">Task:</span>{' '}
            <span className="text-gray-700">{d.taskTitle || 'Standalone'}</span>
          </div>
          <div>
            <span className="text-gray-500">Agent:</span>{' '}
            <span className="text-gray-700">{d.agentName || '—'}</span>
          </div>
          <div>
            <span className="text-gray-500">Type:</span>{' '}
            <span className="text-gray-700">{d.contentType || 'markdown'}</span>
          </div>
          <div>
            <span className="text-gray-500">Version:</span>{' '}
            <span className="text-gray-700">{d.version || 1}</span>
          </div>
        </div>

        {/* Summary */}
        {d.summary && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <h4 className="text-sm font-medium text-gray-700 mb-1">Summary</h4>
            <p className="text-sm text-gray-600">{d.summary}</p>
          </div>
        )}

        {/* Content */}
        {d.content && (
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-1">Content</h4>
            <ContentRenderer content={d.content} contentType={d.contentType} maxHeight="max-h-64" />
          </div>
        )}

        <FileList files={d.files} />

        {/* Previous feedback if revision */}
        {d.feedback && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <h4 className="text-sm font-medium text-yellow-800 mb-1">Review Feedback</h4>
            <p className="text-sm text-yellow-700">{d.feedback}</p>
          </div>
        )}

        {/* Version History */}
        {versions.length > 1 && (
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-2">Version History</h4>
            <div className="border border-gray-200 rounded-lg divide-y divide-gray-200">
              {versions.map((v) => (
                <div key={v.id} className={`flex items-center justify-between px-3 py-2 text-sm ${v.id === d.id ? 'bg-primary-50' : 'hover:bg-gray-50'}`}>
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-gray-700">v{v.version}</span>
                    {v.id === d.id && <span className="text-xs text-primary-600 font-medium">(viewing)</span>}
                    <StatusBadge status={v.status} />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-gray-400 text-xs">{safeTimeAgo(v.createdAt || v.created_at)}</span>
                    {v.id !== d.id && (
                      <Button variant="ghost" size="sm" onClick={() => loadVersion(v.id)}>View</Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Feedback + Review actions (only for the original pending deliverable) */}
        {d.id === deliverable.id && (
          <>
            <TextArea
              label="Feedback (optional)"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Provide feedback for the agent..."
              rows={3}
            />
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="danger" onClick={() => handleAction('rejected')} loading={reviewing}>
                Reject
              </Button>
              <Button variant="secondary" onClick={() => handleAction('revision_requested')} loading={reviewing}>
                Request Revision
              </Button>
              <Button onClick={() => handleAction('approved')} loading={reviewing}>
                Approve
              </Button>
            </div>
          </>
        )}

        {d.id !== deliverable.id && (
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setViewData(deliverable)}>Back to Current</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function SetupStep({ number, title, description, done, onClick }) {
  return (
    <div
      className={`flex items-center gap-4 p-4 rounded-lg border transition-colors ${
        done ? 'bg-green-50 border-green-200' : 'bg-white border-gray-200 hover:border-primary-300'
      } ${onClick && !done ? 'cursor-pointer' : ''}`}
      onClick={!done && onClick ? onClick : undefined}
    >
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
        done ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-600'
      }`}>
        {done ? <CheckCircle className="w-5 h-5" /> : number}
      </div>
      <div className="flex-1">
        <div className={`font-medium ${done ? 'text-green-700 line-through' : 'text-gray-900'}`}>{title}</div>
        <div className={`text-sm ${done ? 'text-green-600' : 'text-gray-500'}`}>{description}</div>
      </div>
      {onClick && !done && (
        <ArrowRight className="w-5 h-5 text-gray-400" />
      )}
    </div>
  );
}

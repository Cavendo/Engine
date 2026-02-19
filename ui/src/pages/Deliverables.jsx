import { useState, useEffect, useMemo } from 'react';
import { FileCheck, Eye, Bot, ChevronUp, ChevronDown } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import Button from '../components/Button';
import Card, { CardHeader, CardBody } from '../components/Card';
import { StatusBadge, PriorityBadge } from '../components/Badge';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import { Select, TextArea } from '../components/Input';
import { safeTimeAgo } from '../lib/dates';
import ContentRenderer from '../components/ContentRenderer';
import FileList from '../components/FileList';

export default function Deliverables() {
  const location = useLocation();
  const [deliverables, setDeliverables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ status: '' });
  const [selectedDeliverable, setSelectedDeliverable] = useState(null);
  const [sortField, setSortField] = useState('createdAt');
  const [sortDir, setSortDir] = useState('desc');

  useEffect(() => {
    if (location.state?.selectDeliverableId) {
      api.deliverables.get(location.state.selectDeliverableId).then(d => setSelectedDeliverable(d)).catch(() => {});
      window.history.replaceState({}, '');
    }
  }, [location.state]);

  useEffect(() => {
    loadDeliverables();
  }, [filter]);

  const loadDeliverables = async () => {
    try {
      const params = {};
      if (filter.status) params.status = filter.status;
      const data = await api.deliverables.list(params);
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
      setSelectedDeliverable(null);
    } catch (err) {
      console.error('Failed to review deliverable:', err);
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

  const sortedDeliverables = useMemo(() => {
    return [...deliverables].sort((a, b) => {
      let av = a[sortField], bv = b[sortField];
      if (sortField === 'title' || sortField === 'status' || sortField === 'agentName') {
        av = (av || '').toLowerCase();
        bv = (bv || '').toLowerCase();
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [deliverables, sortField, sortDir]);

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
          <h1 className="text-2xl font-bold text-gray-900">Deliverables</h1>
          <p className="text-gray-500">Browse and review agent deliverables</p>
        </div>
      </div>

      <div className="flex gap-4 mb-6">
        <Select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}
          options={[
            { value: '', label: 'All Statuses' },
            { value: 'pending', label: 'Pending Review' },
            { value: 'approved', label: 'Approved' },
            { value: 'revision_requested', label: 'Revision Requested' },
            { value: 'revised', label: 'Revised' },
            { value: 'rejected', label: 'Rejected' }
          ]} className="w-48"
        />
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('title')}>Title<SortIcon field="title" /></th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('status')}>Status<SortIcon field="status" /></th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('agentName')}>Agent<SortIcon field="agentName" /></th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Task</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-gray-700" onClick={() => toggleSort('createdAt')}>Created<SortIcon field="createdAt" /></th>
                <th className="px-6 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {sortedDeliverables.map((d) => (
                <tr key={d.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div>
                      <div className="font-medium text-gray-900">{d.title}</div>
                      {d.summary && (
                        <div className="text-sm text-gray-500 truncate max-w-md">{d.summary}</div>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4"><StatusBadge status={d.status} /></td>
                  <td className="px-6 py-4">
                    {d.agentName ? (
                      <div className="flex items-center gap-2">
                        <Bot className="w-4 h-4 text-gray-400" />
                        <span className="text-sm">{d.agentName}</span>
                      </div>
                    ) : (
                      <span className="text-sm text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-sm text-gray-600">{d.taskTitle || 'Standalone'}</span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-sm text-gray-500">{safeTimeAgo(d.createdAt)}</span>
                  </td>
                  <td className="px-6 py-4">
                    <Button size="sm" variant="ghost" onClick={() => setSelectedDeliverable(d)}>
                      <Eye className="w-4 h-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {deliverables.length === 0 && (
          <CardBody className="text-center py-12">
            <FileCheck className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <p className="text-gray-500">No deliverables found</p>
          </CardBody>
        )}
      </Card>

      <DeliverableDetailModal
        deliverable={selectedDeliverable}
        onClose={() => setSelectedDeliverable(null)}
        onReview={handleReview}
      />
    </div>
  );
}

function DeliverableDetailModal({ deliverable, onClose, onReview }) {
  const [feedback, setFeedback] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [fullData, setFullData] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  useEffect(() => {
    if (deliverable) {
      setFeedback('');
      setFullData(null);
      setLoadingDetail(true);
      api.deliverables.get(deliverable.id).then(data => {
        setFullData(data);
      }).catch(err => {
        console.error('Failed to load deliverable detail:', err);
        setFullData(deliverable);
      }).finally(() => setLoadingDetail(false));
    }
  }, [deliverable]);

  const loadVersion = async (versionId) => {
    setLoadingDetail(true);
    try {
      const data = await api.deliverables.get(versionId);
      setFullData(data);
    } catch (err) {
      console.error('Failed to load version:', err);
    } finally {
      setLoadingDetail(false);
    }
  };

  const handleAction = async (decision) => {
    setReviewing(true);
    try {
      await onReview((fullData || deliverable).id, decision, feedback || undefined);
    } finally { setReviewing(false); }
  };

  if (!deliverable) return null;

  const d = fullData || deliverable;
  const files = d.files || [];
  const actions = d.actions || [];
  const versions = d.versions || [];
  const canReview = d.status === 'pending' || d.status === 'revision_requested';

  return (
    <Modal isOpen={!!deliverable} onClose={onClose} title={d.title} size="xl">
      <div className="space-y-4">
        {loadingDetail && (
          <div className="animate-pulse h-2 bg-primary-200 rounded"></div>
        )}

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

        {d.summary && (
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <h4 className="text-sm font-medium text-gray-700 mb-1">Summary</h4>
            <p className="text-sm text-gray-600">{d.summary}</p>
          </div>
        )}

        {d.content && (
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-1">Content</h4>
            <ContentRenderer content={d.content} contentType={d.contentType} maxHeight="max-h-64" />
          </div>
        )}

        <FileList files={files} />

        {actions.length > 0 && (
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-2">Follow-up Actions</h4>
            <div className="space-y-1">
              {actions.map((action, i) => (
                <div key={i} className="flex items-center gap-3 p-2 bg-gray-50 rounded">
                  <span className="text-sm">{action.actionText}</span>
                  {action.estimatedTimeMinutes && (
                    <Badge variant="gray">{action.estimatedTimeMinutes}m</Badge>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {d.inputTokens > 0 && (
          <div className="flex gap-4 text-xs text-gray-500">
            <span>Input tokens: {d.inputTokens?.toLocaleString()}</span>
            <span>Output tokens: {d.outputTokens?.toLocaleString()}</span>
            {d.model && <span>Model: {d.model}</span>}
          </div>
        )}

        {d.feedback && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <h4 className="text-sm font-medium text-yellow-800 mb-1">Review Feedback</h4>
            <p className="text-sm text-yellow-700">{d.feedback}</p>
          </div>
        )}

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

        {canReview && (
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

        {!canReview && (
          <div className="flex justify-end pt-2">
            <Button onClick={onClose}>Close</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

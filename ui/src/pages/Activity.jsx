import { useState, useEffect } from 'react';
import { Bot, AlertTriangle, CheckCircle, Play, FileText, RefreshCw, Clock, Zap } from 'lucide-react';
import { api } from '../lib/api';
import Card, { CardHeader, CardBody } from '../components/Card';
import { Select } from '../components/Input';
import { safeTimeAgo } from '../lib/dates';

export default function Activity() {
  const [activities, setActivities] = useState([]);
  const [agents, setAgents] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ agentId: '', period: '7d' });

  useEffect(() => {
    loadData();
  }, [filter]);

  const loadData = async () => {
    setLoading(true);
    try {
      const listParams = { period: filter.period, limit: 100 };
      if (filter.agentId) listParams.agentId = filter.agentId;
      const statsParams = { period: filter.period };
      if (filter.agentId) statsParams.agentId = filter.agentId;

      const [activitiesData, agentsData, statsData] = await Promise.all([
        api.activity.list(listParams),
        api.agents.list(),
        api.activity.stats(statsParams)
      ]);
      setActivities(activitiesData);
      setAgents(agentsData);
      setStats(statsData);
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading && activities.length === 0) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/4"></div>
          <div className="h-24 bg-gray-200 rounded"></div>
          <div className="h-64 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Activity Log</h1>
          <p className="text-gray-500">Track agent actions and system events</p>
        </div>
        <button
          type="button"
          onClick={loadData}
          className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          <Card>
            <CardBody className="text-center py-4">
              <div className="text-3xl font-bold text-primary-600">{stats.totalActions}</div>
              <div className="text-sm text-gray-500">Total Actions ({filter.period})</div>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="text-center py-4">
              <div className="text-3xl font-bold text-green-600">
                {stats.actionsByAgent?.filter(a => a.count > 0).length || 0}
              </div>
              <div className="text-sm text-gray-500">Active Agents</div>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="text-center py-4">
              <div className="text-3xl font-bold text-blue-600">
                {stats.actionsByType?.find(a => a.action === 'deliverable.submitted')?.count || 0}
              </div>
              <div className="text-sm text-gray-500">Deliverables Submitted</div>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="text-center py-4">
              <div className="text-3xl font-bold text-red-500">
                {stats.actionsByType?.find(a => a.action === 'task.execution_failed')?.count || 0}
              </div>
              <div className="text-sm text-gray-500">Execution Errors</div>
            </CardBody>
          </Card>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        <Select
          value={filter.agentId}
          onChange={(e) => setFilter({ ...filter, agentId: e.target.value })}
          options={[
            { value: '', label: 'All Agents' },
            ...agents.map(a => ({ value: a.id, label: a.name }))
          ]}
          className="w-48"
        />
        <Select
          value={filter.period}
          onChange={(e) => setFilter({ ...filter, period: e.target.value })}
          options={[
            { value: '24h', label: 'Last 24 hours' },
            { value: '7d', label: 'Last 7 days' },
            { value: '30d', label: 'Last 30 days' }
          ]}
          className="w-48"
        />
      </div>

      {/* Activity Feed */}
      <Card>
        <CardBody className="p-0">
          <div className="divide-y divide-gray-200">
            {activities.map((activity) => {
              const action = getActionConfig(activity.action);
              const Icon = action.icon;

              return (
                <div key={activity.id} className="px-6 py-4 hover:bg-gray-50 transition-colors">
                  <div className="flex items-start gap-4">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${action.bgColor}`}>
                      <Icon className={`w-4 h-4 ${action.iconColor}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-gray-900">{activity.agentName || 'System'}</span>
                        <span className="text-gray-400">·</span>
                        <span className={`text-sm font-medium ${action.textColor}`}>{action.label}</span>
                      </div>

                      {/* Resource info */}
                      <div className="mt-1 space-y-0.5">
                        {activity.details?.title && (
                          <p className="text-sm text-gray-700">
                            {activity.resourceType} #{activity.resourceId}: <span className="font-medium">{activity.details.title}</span>
                          </p>
                        )}
                        {!activity.details?.title && activity.resourceType && (
                          <p className="text-sm text-gray-500">
                            {activity.resourceType} #{activity.resourceId}
                          </p>
                        )}

                        {/* Execution details */}
                        {activity.details?.trigger && (
                          <p className="text-xs text-gray-400">
                            Trigger: {activity.details.trigger === 'auto_dispatch' ? 'Automatic dispatch' : 'Manual execution'}
                          </p>
                        )}

                        {/* Deliverable link */}
                        {activity.details?.deliverableId && (
                          <p className="text-sm text-blue-600">
                            Created deliverable #{activity.details.deliverableId}
                          </p>
                        )}

                        {/* Token usage */}
                        {(activity.details?.usage?.inputTokens || activity.details?.usage?.outputTokens) && (
                          <p className="text-xs text-gray-400">
                            Tokens: {activity.details.usage.inputTokens?.toLocaleString()} in / {activity.details.usage.outputTokens?.toLocaleString()} out
                          </p>
                        )}

                        {/* Error message */}
                        {activity.details?.error && (
                          <div className="mt-1 bg-red-50 border border-red-100 rounded px-2 py-1">
                            <p className="text-xs text-red-700">{activity.details.error}</p>
                          </div>
                        )}

                        {/* Status change */}
                        {activity.details?.status && !activity.details?.error && (
                          <p className="text-sm text-gray-500">
                            Status: <span className="font-medium">{activity.details.status}</span>
                          </p>
                        )}
                      </div>

                      <p className="text-xs text-gray-400 mt-1.5">
                        {safeTimeAgo(activity.createdAt)}
                        {activity.ipAddress && <span> from {activity.ipAddress}</span>}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {activities.length === 0 && (
            <div className="text-center py-12">
              <Bot className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-gray-500">No activity found for this period</p>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function getActionConfig(action) {
  const configs = {
    'task.execution_started': {
      label: 'started executing task',
      icon: Play,
      bgColor: 'bg-blue-100',
      iconColor: 'text-blue-600',
      textColor: 'text-blue-600'
    },
    'task.execution_completed': {
      label: 'completed task execution',
      icon: CheckCircle,
      bgColor: 'bg-green-100',
      iconColor: 'text-green-600',
      textColor: 'text-green-600'
    },
    'task.execution_failed': {
      label: 'task execution failed',
      icon: AlertTriangle,
      bgColor: 'bg-red-100',
      iconColor: 'text-red-600',
      textColor: 'text-red-600'
    },
    'task.status_updated': {
      label: 'updated task status',
      icon: RefreshCw,
      bgColor: 'bg-gray-100',
      iconColor: 'text-gray-600',
      textColor: 'text-gray-600'
    },
    'deliverable.submitted': {
      label: 'submitted a deliverable',
      icon: FileText,
      bgColor: 'bg-purple-100',
      iconColor: 'text-purple-600',
      textColor: 'text-purple-600'
    },
    'deliverable.revision_submitted': {
      label: 'submitted a revision',
      icon: FileText,
      bgColor: 'bg-purple-100',
      iconColor: 'text-purple-600',
      textColor: 'text-purple-600'
    },
    'task.created': {
      label: 'created a task',
      icon: Zap,
      bgColor: 'bg-blue-100',
      iconColor: 'text-blue-600',
      textColor: 'text-blue-600'
    },
    'api.called': {
      label: 'made an API call',
      icon: Zap,
      bgColor: 'bg-gray-100',
      iconColor: 'text-gray-500',
      textColor: 'text-gray-500'
    }
  };

  return configs[action] || {
    label: action,
    icon: Clock,
    bgColor: 'bg-gray-100',
    iconColor: 'text-gray-500',
    textColor: 'text-gray-600'
  };
}

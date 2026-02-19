/**
 * HTTP Client for Cavendo Engine API
 *
 * Handles all communication with the Cavendo Engine backend.
 */

// ============================================================================
// Types
// ============================================================================

export interface CavendoConfig {
  baseUrl: string;
  agentKey: string;
  timeout?: number;
  maxRetries?: number;
}

export interface Agent {
  id: string;
  name: string;
  type: string;
  status: string;
  capabilities: string[];
  projectAccess: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'assigned' | 'in_progress' | 'review' | 'completed' | 'cancelled';
  priority: number;
  projectId: string;
  projectName?: string;
  assignedAgentId: string | null;
  parentTaskId: string | null;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  dueDate: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  type?: string;
  description?: string;
  capabilities?: string[];
  specializations?: Record<string, unknown>;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface SprintInfo {
  id: string;
  name: string;
}

export interface TaskContext {
  task: Task;
  agent?: AgentProfile;
  project: {
    id: string;
    name: string;
    description?: string;
    type?: string;
  } | null;
  sprint?: SprintInfo;
  knowledge: KnowledgeDocument[];
  relatedTasks: Task[];
  deliverables: Deliverable[];
  history?: TaskHistoryEntry[];  // May be missing from older servers
}

export interface TaskHistoryEntry {
  id: string;
  taskId: string;
  action: string;
  details: Record<string, unknown>;
  performedBy: string;
  createdAt: string;
}

export interface Deliverable {
  id: string;
  taskId: string;
  projectId?: string;
  agentId?: string;
  contentType: 'markdown' | 'html' | 'json' | 'text' | 'code';
  title: string;
  summary?: string;
  content: string;
  files?: Array<{ filename: string; path: string; mimeType: string; size: number }>;
  actions?: Array<{ actionText: string; estimatedTimeMinutes?: number; notes?: string }>;
  status: 'pending' | 'approved' | 'revision_requested' | 'rejected';
  version: number;
  feedback: string | null;
  metadata: Record<string, unknown>;
  // Token usage tracking
  inputTokens?: number;
  outputTokens?: number;
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliverableFeedback {
  id: string;
  status: 'pending' | 'approved' | 'revision_requested' | 'rejected';
  feedback: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface KnowledgeDocument {
  id: string;
  projectId: string | null;
  type: 'documentation' | 'guideline' | 'reference' | 'template' | 'example';
  title: string;
  content: string;
  tags: string[];
  relevanceScore?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ProgressLog {
  taskId: string;
  message: string;
  percentComplete?: number;
  details?: Record<string, unknown>;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// ============================================================================
// Snake-case to camelCase conversion (server returns snake_case)
// ============================================================================

function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function transformKeys(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(transformKeys);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[snakeToCamel(key)] = transformKeys(value);
  }
  return result;
}

// ============================================================================
// Error Classes
// ============================================================================

export class CavendoApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public response?: unknown
  ) {
    super(message);
    this.name = 'CavendoApiError';
  }
}

export class CavendoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CavendoConfigError';
  }
}

// ============================================================================
// Client Class
// ============================================================================

export class CavendoClient {
  private config: CavendoConfig;
  private timeout: number;
  private maxRetries: number;

  constructor(config?: Partial<CavendoConfig>) {
    const baseUrl = config?.baseUrl || process.env.CAVENDO_URL || 'http://localhost:3001';
    const agentKey = config?.agentKey || process.env.CAVENDO_AGENT_KEY;

    if (!agentKey) {
      throw new CavendoConfigError(
        'CAVENDO_AGENT_KEY environment variable is required. ' +
        'Please set it to your agent API key.'
      );
    }

    this.config = {
      baseUrl: baseUrl.replace(/\/$/, ''), // Remove trailing slash
      agentKey,
    };
    this.timeout = config?.timeout ?? 30000; // 30 second default timeout
    this.maxRetries = config?.maxRetries ?? 3;
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if an error is retryable
   */
  private isRetryable(statusCode: number): boolean {
    // Retry on server errors and rate limiting
    return statusCode >= 500 || statusCode === 429;
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Agent-Key': this.config.agentKey,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const options: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }

      let response: Response;
      try {
        response = await fetch(url, options);
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
          throw new CavendoApiError(
            `Request timed out after ${this.timeout}ms`,
            0
          );
        }
        throw new CavendoApiError(
          `Network error connecting to Cavendo Engine: ${error instanceof Error ? error.message : 'Unknown error'}`,
          0
        );
      } finally {
        clearTimeout(timeoutId);
      }

      let data: unknown;
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        try {
          data = await response.json();
        } catch {
          data = null;
        }
      } else {
        data = await response.text();
      }

      if (!response.ok) {
        const rawError = typeof data === 'object' && data !== null && 'error' in data
          ? (data as Record<string, unknown>).error
          : null;
        const errorMessage = typeof rawError === 'string'
          ? rawError
          : (typeof rawError === 'object' && rawError !== null && 'message' in rawError)
            ? String((rawError as Record<string, unknown>).message)
            : `HTTP ${response.status}: ${response.statusText}`;

        // Check if we should retry
        if (this.isRetryable(response.status) && attempt < this.maxRetries) {
          lastError = new CavendoApiError(errorMessage, response.status, data);
          // Exponential backoff: 1s, 2s, 4s...
          const backoffMs = Math.pow(2, attempt) * 1000;
          await this.sleep(backoffMs);
          continue;
        }

        throw new CavendoApiError(errorMessage, response.status, data);
      }

      // Handle wrapped API responses
      if (typeof data === 'object' && data !== null && 'success' in data) {
        const apiResponse = data as ApiResponse<T>;
        if (!apiResponse.success) {
          throw new CavendoApiError(
            apiResponse.error || 'Unknown API error',
            response.status,
            data
          );
        }
        return transformKeys(apiResponse.data) as T;
      }

      return transformKeys(data) as T;
    }

    // If we exhausted all retries, throw the last error
    throw lastError || new CavendoApiError('Request failed after retries', 0);
  }

  // --------------------------------------------------------------------------
  // Agent Methods
  // --------------------------------------------------------------------------

  /**
   * Get current agent information
   */
  async getMe(): Promise<Agent> {
    return this.request<Agent>('GET', '/api/agents/me');
  }

  /**
   * List all agents (for discovering assignees)
   */
  async listAgents(params?: {
    capability?: string;
    status?: string;
    available?: boolean;
  }): Promise<Agent[]> {
    const searchParams = new URLSearchParams();
    if (params?.capability) searchParams.set('capability', params.capability);
    if (params?.status) searchParams.set('status', params.status);
    if (params?.available) searchParams.set('available', 'true');
    const query = searchParams.toString();
    const path = `/api/agents${query ? `?${query}` : ''}`;
    return this.request<Agent[]>('GET', path);
  }

  // --------------------------------------------------------------------------
  // Task Methods
  // --------------------------------------------------------------------------

  /**
   * List tasks assigned to this agent (or to agents owned by the user if using a user key)
   */
  async listTasks(params?: {
    status?: string;
    projectId?: string;
    limit?: number;
    offset?: number;
  }): Promise<Task[]> {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set('status', params.status);
    if (params?.projectId) searchParams.set('projectId', params.projectId);
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.offset) searchParams.set('offset', params.offset.toString());

    const query = searchParams.toString();
    const path = `/api/agents/me/tasks${query ? `?${query}` : ''}`;
    return this.request<Task[]>('GET', path);
  }

  /**
   * Get the next highest-priority task from the queue
   *
   * For user keys, returns next task for agents owned by the user.
   * For agent keys, returns next task for this specific agent.
   */
  async getNextTask(): Promise<Task | null> {
    try {
      const path = `/api/agents/me/tasks/next`;
      // Server returns { task: Task | null, reason?: string, message?: string }
      const response = await this.request<{ task: Task | null; reason?: string; message?: string }>('GET', path);
      return response.task;
    } catch (error) {
      if (error instanceof CavendoApiError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get full context bundle for a task
   */
  async getTaskContext(taskId: string): Promise<TaskContext> {
    return this.request<TaskContext>('GET', `/api/tasks/${taskId}/context`);
  }

  /**
   * Update task status
   */
  async updateTaskStatus(
    taskId: string,
    status: 'in_progress' | 'review',
    details?: { message?: string; metadata?: Record<string, unknown> }
  ): Promise<Task> {
    return this.request<Task>('PATCH', `/api/tasks/${taskId}/status`, {
      status,
      ...details,
    });
  }

  /**
   * Log progress update for a task
   */
  async logProgress(log: ProgressLog): Promise<void> {
    await this.request<void>('POST', `/api/tasks/${log.taskId}/progress`, {
      message: log.message,
      percentComplete: log.percentComplete,
      details: log.details,
    });
  }

  /**
   * Claim a task for this agent
   * Only works for tasks with status 'pending' or 'assigned' that are not assigned to another agent
   */
  async claimTask(taskId: string): Promise<Task> {
    return this.request<Task>('POST', `/api/tasks/${taskId}/claim`);
  }

  /**
   * Create a new task
   */
  async createTask(params: {
    title: string;
    description?: string;
    projectId: string;
    priority?: number;
    assignedAgentId?: string;
  }): Promise<Task> {
    // projectId must be numeric
    const projectIdNum = parseInt(params.projectId, 10);
    if (isNaN(projectIdNum)) {
      throw new CavendoApiError('projectId must be a numeric ID', 400);
    }

    const body: Record<string, unknown> = {
      title: params.title,
      description: params.description,
      projectId: projectIdNum,
      priority: params.priority ?? 3,
    };

    if (params.assignedAgentId) {
      const agentIdNum = parseInt(params.assignedAgentId, 10);
      if (isNaN(agentIdNum)) {
        throw new CavendoApiError('assignedAgentId must be a numeric ID', 400);
      }
      body.assignedAgentId = agentIdNum;
    }

    return this.request<Task>('POST', '/api/tasks', body);
  }

  // --------------------------------------------------------------------------
  // Deliverable Methods
  // --------------------------------------------------------------------------

  /**
   * Submit a deliverable for a task or standalone
   */
  async submitDeliverable(deliverable: {
    taskId?: number;
    projectId?: string;
    title: string;
    summary?: string;
    content?: string;
    contentType?: 'markdown' | 'html' | 'json' | 'text' | 'code';
    files?: Array<{ filename: string; content: string; mimeType?: string }>;
    actions?: Array<{ action_text: string; estimated_time_minutes?: number; notes?: string }>;
    metadata?: Record<string, unknown>;
    // Token usage tracking
    inputTokens?: number;
    outputTokens?: number;
    provider?: string;
    model?: string;
  }): Promise<Deliverable> {
    return this.request<Deliverable>('POST', '/api/deliverables', deliverable);
  }

  /**
   * Get feedback for a deliverable needing revision
   */
  async getDeliverableFeedback(deliverableId: string): Promise<DeliverableFeedback> {
    return this.request<DeliverableFeedback>(
      'GET',
      `/api/deliverables/${deliverableId}/feedback`
    );
  }

  /**
   * Submit a revised deliverable
   */
  async submitRevision(
    deliverableId: string,
    revision: {
      summary?: string;
      content?: string;
      files?: Array<{ filename: string; content: string; mimeType?: string }>;
      title?: string;
      contentType?: 'markdown' | 'html' | 'json' | 'text' | 'code';
      metadata?: Record<string, unknown>;
    }
  ): Promise<Deliverable> {
    return this.request<Deliverable>(
      'POST',
      `/api/deliverables/${deliverableId}/revision`,
      revision
    );
  }

  // --------------------------------------------------------------------------
  // Knowledge Methods
  // --------------------------------------------------------------------------

  /**
   * Search the knowledge base
   */
  async searchKnowledge(params: {
    query: string;
    projectId?: string;
    type?: string;
    limit?: number;
  }): Promise<KnowledgeDocument[]> {
    const searchParams = new URLSearchParams();
    searchParams.set('q', params.query);
    if (params.projectId) searchParams.set('projectId', params.projectId);
    if (params.type) searchParams.set('type', params.type);
    if (params.limit) searchParams.set('limit', params.limit.toString());

    return this.request<KnowledgeDocument[]>(
      'GET',
      `/api/knowledge/search?${searchParams.toString()}`
    );
  }

  /**
   * Get knowledge documents for a project
   */
  async getProjectKnowledge(projectId: string): Promise<KnowledgeDocument[]> {
    return this.request<KnowledgeDocument[]>(
      'GET',
      `/api/projects/${projectId}/knowledge`
    );
  }

  // --------------------------------------------------------------------------
  // Project Methods
  // --------------------------------------------------------------------------

  /**
   * List projects the agent has access to
   */
  async listProjects(): Promise<Project[]> {
    return this.request<Project[]>('GET', '/api/projects');
  }

  /**
   * Get a specific project by ID
   */
  async getProject(projectId: string): Promise<Project> {
    return this.request<Project>('GET', `/api/projects/${projectId}`);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

let clientInstance: CavendoClient | null = null;
let clientConfig: CavendoConfig | null = null;

/**
 * Get or create a Cavendo client instance
 */
export function getClient(config?: Partial<CavendoConfig>): CavendoClient {
  if (!clientInstance) {
    clientInstance = new CavendoClient(config);
    clientConfig = {
      baseUrl: config?.baseUrl || process.env.CAVENDO_URL || 'http://localhost:3001',
      agentKey: config?.agentKey || process.env.CAVENDO_AGENT_KEY || '',
    };
  } else if (config && clientConfig) {
    // Warn if different config is passed to existing instance
    const newBaseUrl = config.baseUrl || process.env.CAVENDO_URL || 'http://localhost:3001';
    const newAgentKey = config.agentKey || process.env.CAVENDO_AGENT_KEY || '';
    if (newBaseUrl !== clientConfig.baseUrl || newAgentKey !== clientConfig.agentKey) {
      console.warn(
        'CavendoClient: getClient() called with different config than existing instance. ' +
        'Use resetClient() first to create a new instance with different config.'
      );
    }
  }
  return clientInstance;
}

/**
 * Reset the client instance (useful for testing)
 */
export function resetClient(): void {
  clientInstance = null;
  clientConfig = null;
}

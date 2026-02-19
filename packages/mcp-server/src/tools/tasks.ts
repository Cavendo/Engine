/**
 * Task-related MCP tools for Cavendo Engine
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getClient, Task, TaskContext, CavendoApiError } from '../client.js';

// ============================================================================
// Tool Definitions
// ============================================================================

export const listTasksTool: Tool = {
  name: 'cavendo_list_tasks',
  description:
    'List tasks assigned to this agent. Can filter by status to find tasks in specific states. ' +
    'Returns task ID, title, status, priority, project, and due date for each task.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'assigned', 'in_progress', 'review', 'completed', 'cancelled'],
        description: 'Filter tasks by status. Omit to get all tasks.',
      },
      projectId: {
        type: 'string',
        description: 'Filter tasks by project ID.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of tasks to return (default: 50).',
        default: 50,
      },
    },
    additionalProperties: false,
  },
};

export const getNextTaskTool: Tool = {
  name: 'cavendo_get_next_task',
  description:
    'Get the highest-priority unstarted task from the queue. ' +
    'This is the recommended way to get work - it automatically selects the most important task ' +
    'that is ready to be worked on. Returns null if no tasks are available.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

export const getTaskContextTool: Tool = {
  name: 'cavendo_get_task_context',
  description:
    'Get the full context bundle for a task. This includes the task details, project information, ' +
    'relevant knowledge documents, related tasks, existing deliverables, and task history. ' +
    'Use this before starting work on a task to understand the full context.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to get context for.',
      },
    },
    required: ['taskId'],
    additionalProperties: false,
  },
};

export const updateTaskStatusTool: Tool = {
  name: 'cavendo_update_task_status',
  description:
    'Update the status of a task. Use this to indicate progress:\n' +
    '- "in_progress": When starting work on a task\n' +
    '- "review": When work is complete and ready for review\n' +
    'Note: "completed" and "failed" statuses are typically set by the system after review.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to update.',
      },
      status: {
        type: 'string',
        enum: ['in_progress', 'review'],
        description: 'The new status for the task.',
      },
      message: {
        type: 'string',
        description: 'Optional message explaining the status change.',
      },
    },
    required: ['taskId', 'status'],
    additionalProperties: false,
  },
};

export const logProgressTool: Tool = {
  name: 'cavendo_log_progress',
  description:
    'Log a progress update for a task. Use this to provide visibility into ongoing work. ' +
    'Good for long-running tasks to show incremental progress. ' +
    'Note: This feature requires the progress logging endpoint to be enabled on the server.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to log progress for.',
      },
      message: {
        type: 'string',
        description: 'Description of the progress made.',
      },
      percentComplete: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Optional percentage completion (0-100).',
      },
    },
    required: ['taskId', 'message'],
    additionalProperties: false,
  },
};

export const claimTaskTool: Tool = {
  name: 'cavendo_claim_task',
  description:
    'Claim an unassigned task from the pool. Use this to self-assign a task that is not ' +
    'already assigned to another agent. Only works for tasks with status "pending" or "assigned" ' +
    'that are not already claimed by another agent.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to claim.',
      },
    },
    required: ['taskId'],
    additionalProperties: false,
  },
};

export const createTaskTool: Tool = {
  name: 'cavendo_create_task',
  description:
    'Create a new task. Use this to create follow-up tasks or assign work to agents. ' +
    'If assignedAgentId is provided, the task is assigned directly. ' +
    'If omitted, the project\'s routing rules may auto-assign an agent.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Title of the task.',
      },
      projectId: {
        type: 'string',
        description: 'Numeric project ID to create the task in (e.g., "1", "42").',
      },
      description: {
        type: 'string',
        description: 'Optional detailed description of the task.',
      },
      priority: {
        type: 'number',
        minimum: 1,
        maximum: 4,
        description: 'Priority level 1-4 (1 = highest, 4 = lowest). Default: 3',
      },
      assignedAgentId: {
        type: 'string',
        description: 'Numeric agent ID to assign this task to (e.g., "1"). Omit to leave unassigned or let routing rules decide.',
      },
    },
    required: ['title', 'projectId'],
    additionalProperties: false,
  },
};

export const listAgentsTool: Tool = {
  name: 'cavendo_list_agents',
  description:
    'List available agents. Use this to discover agent IDs for task assignment. ' +
    'Can filter by capability, status, or availability (agents with spare capacity).',
  inputSchema: {
    type: 'object',
    properties: {
      capability: {
        type: 'string',
        description: 'Filter by capability (e.g., "research", "content_generation").',
      },
      status: {
        type: 'string',
        enum: ['active', 'paused', 'disabled'],
        description: 'Filter by agent status. Default: all statuses.',
      },
      available: {
        type: 'boolean',
        description: 'If true, only return agents with spare capacity for new tasks.',
      },
    },
    additionalProperties: false,
  },
};

// ============================================================================
// Tool Handlers
// ============================================================================

function formatTask(task: Task): string {
  const parts = [
    `**${task.title}**`,
    `- ID: ${task.id}`,
    `- Status: ${task.status}`,
    `- Priority: ${task.priority}`,
  ];

  if (task.projectName) {
    parts.push(`- Project: ${task.projectName}`);
  }

  if (task.dueDate) {
    parts.push(`- Due: ${task.dueDate}`);
  }

  if (task.tags && task.tags.length > 0) {
    parts.push(`- Tags: ${task.tags.join(', ')}`);
  }

  if (task.description) {
    parts.push(`- Description: ${task.description.substring(0, 200)}${task.description.length > 200 ? '...' : ''}`);
  }

  return parts.join('\n');
}

function formatTaskContext(context: TaskContext): string {
  const sections: string[] = [];

  // Task details
  sections.push('## Task Details');
  sections.push(formatTask(context.task));

  // Agent profile (if assigned)
  if (context.agent) {
    sections.push('\n## Agent Profile');
    sections.push(`**${context.agent.name}**`);
    if (context.agent.type) {
      sections.push(`- Type: ${context.agent.type}`);
    }
    if (context.agent.description) {
      sections.push(`- Description: ${context.agent.description}`);
    }
    if (context.agent.capabilities && context.agent.capabilities.length > 0) {
      sections.push(`- Capabilities: ${context.agent.capabilities.join(', ')}`);
    }
    if (context.agent.systemPrompt) {
      sections.push(`\n**System Instructions:**\n${context.agent.systemPrompt}`);
    }
  }

  // Sprint info (if assigned to sprint)
  if (context.sprint) {
    sections.push('\n## Sprint');
    sections.push(`**${context.sprint.name}** (ID: ${context.sprint.id})`);
  }

  // Project info (may be null for standalone tasks)
  if (context.project) {
    sections.push('\n## Project');
    sections.push(`**${context.project.name}**`);
  }

  // Knowledge documents
  if (context.knowledge && context.knowledge.length > 0) {
    sections.push('\n## Relevant Knowledge');
    for (const doc of context.knowledge) {
      sections.push(`\n### ${doc.title}`);
      if (doc.type) {
        sections.push(`Type: ${doc.type}`);
      }
      if (doc.relevanceScore !== undefined) {
        sections.push(`Relevance: ${Math.round(doc.relevanceScore * 100)}%`);
      }
      if (doc.content) {
        sections.push(`\n${doc.content}`);
      }
    }
  }

  // Related tasks
  if (context.relatedTasks && context.relatedTasks.length > 0) {
    sections.push('\n## Related Tasks');
    for (const task of context.relatedTasks) {
      sections.push(`- [${task.status}] ${task.title} (${task.id})`);
    }
  }

  // Existing deliverables
  if (context.deliverables && context.deliverables.length > 0) {
    sections.push('\n## Existing Deliverables');
    for (const deliverable of context.deliverables) {
      sections.push(`\n### ${deliverable.title}`);
      sections.push(`- Content Type: ${deliverable.contentType || 'unknown'}`);
      sections.push(`- Status: ${deliverable.status}`);
      sections.push(`- Version: ${deliverable.version}`);
      if (deliverable.feedback) {
        sections.push(`- Feedback: ${deliverable.feedback}`);
      }
    }
  }

  // Task history (may be missing from older servers)
  if (context.history && context.history.length > 0) {
    sections.push('\n## History');
    for (const entry of context.history.slice(-10)) {
      sections.push(`- [${entry.createdAt}] ${entry.action} by ${entry.performedBy}`);
    }
  }

  return sections.join('\n');
}

export async function handleListTasks(args: Record<string, unknown>): Promise<string> {
  const client = getClient();

  try {
    const tasks = await client.listTasks({
      status: args.status as string | undefined,
      projectId: args.projectId ? String(args.projectId) : undefined,
      limit: (args.limit as number) || 50,
    });

    if (tasks.length === 0) {
      const statusFilter = args.status ? ` with status "${args.status}"` : '';
      return `No tasks found${statusFilter}.`;
    }

    const taskList = tasks.map(formatTask).join('\n\n---\n\n');
    return `Found ${tasks.length} task(s):\n\n${taskList}`;
  } catch (error) {
    if (error instanceof CavendoApiError) {
      return `Error listing tasks: ${error.message} (HTTP ${error.statusCode})`;
    }
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export async function handleGetNextTask(): Promise<string> {
  const client = getClient();

  try {
    const task = await client.getNextTask();

    if (!task) {
      return 'No tasks available in the queue. All caught up!';
    }

    return `Next task to work on:\n\n${formatTask(task)}\n\nUse cavendo_get_task_context to get full context before starting.`;
  } catch (error) {
    if (error instanceof CavendoApiError) {
      return `Error getting next task: ${error.message} (HTTP ${error.statusCode})`;
    }
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export async function handleGetTaskContext(args: Record<string, unknown>): Promise<string> {
  if (!args.taskId) {
    return 'Error: taskId is required.';
  }

  const taskId = String(args.taskId);
  const client = getClient();

  try {
    const context = await client.getTaskContext(taskId);
    return formatTaskContext(context);
  } catch (error) {
    if (error instanceof CavendoApiError) {
      if (error.statusCode === 404) {
        return `Task not found: ${taskId}`;
      }
      return `Error getting task context: ${error.message}`;
    }
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export async function handleUpdateTaskStatus(args: Record<string, unknown>): Promise<string> {
  if (!args.taskId) {
    return 'Error: taskId is required.';
  }

  if (!args.status) {
    return 'Error: status is required.';
  }

  const taskId = String(args.taskId);
  const status = args.status as 'in_progress' | 'review';
  const message = args.message as string | undefined;

  const client = getClient();

  try {
    const task = await client.updateTaskStatus(taskId, status, { message });
    return `Task status updated successfully:\n\n${formatTask(task)}`;
  } catch (error) {
    if (error instanceof CavendoApiError) {
      if (error.statusCode === 404) {
        return `Task not found: ${taskId}`;
      }
      return `Error updating task status: ${error.message}`;
    }
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export async function handleLogProgress(args: Record<string, unknown>): Promise<string> {
  if (!args.taskId) {
    return 'Error: taskId is required.';
  }

  if (!args.message) {
    return 'Error: message is required.';
  }

  const taskId = String(args.taskId);
  const message = String(args.message);
  const percentComplete = args.percentComplete as number | undefined;

  const client = getClient();

  try {
    await client.logProgress({ taskId, message, percentComplete });

    const progressInfo = percentComplete !== undefined
      ? ` (${percentComplete}% complete)`
      : '';

    return `Progress logged successfully${progressInfo}: ${message}`;
  } catch (error) {
    if (error instanceof CavendoApiError) {
      if (error.statusCode === 404) {
        // Could be task not found OR endpoint not implemented
        return `Unable to log progress for task ${taskId}. The progress logging endpoint may not be enabled on this server. Consider using cavendo_update_task_status with a progress message instead.`;
      }
      return `Error logging progress: ${error.message}`;
    }
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export async function handleClaimTask(args: Record<string, unknown>): Promise<string> {
  if (!args.taskId) {
    return 'Error: taskId is required.';
  }

  const taskId = String(args.taskId);
  const client = getClient();

  try {
    const task = await client.claimTask(taskId);
    return `Task claimed successfully:\n\n${formatTask(task)}\n\nYou can now start working on this task. Use cavendo_get_task_context to get full context.`;
  } catch (error) {
    if (error instanceof CavendoApiError) {
      if (error.statusCode === 404) {
        return `Task not found: ${taskId}`;
      }
      if (error.statusCode === 400 || error.statusCode === 409) {
        return `Cannot claim task ${taskId}: ${error.message}. The task may already be assigned to another agent.`;
      }
      return `Error claiming task: ${error.message}`;
    }
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export async function handleListAgents(args: Record<string, unknown>): Promise<string> {
  const client = getClient();

  try {
    const agents = await client.listAgents({
      capability: args.capability as string | undefined,
      status: args.status as string | undefined,
      available: args.available as boolean | undefined,
    });

    if (agents.length === 0) {
      return 'No agents found matching the given filters.';
    }

    const agentList = agents.map((a) => {
      const parts = [
        `**${a.name}** (ID: ${a.id})`,
        `- Status: ${a.status}`,
        `- Type: ${a.type}`,
      ];
      if (a.capabilities && a.capabilities.length > 0) {
        parts.push(`- Capabilities: ${a.capabilities.join(', ')}`);
      }
      return parts.join('\n');
    }).join('\n\n---\n\n');

    return `Found ${agents.length} agent(s):\n\n${agentList}`;
  } catch (error) {
    if (error instanceof CavendoApiError) {
      return `Error listing agents: ${error.message} (HTTP ${error.statusCode})`;
    }
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export async function handleCreateTask(args: Record<string, unknown>): Promise<string> {
  if (!args.title) {
    return 'Error: title is required.';
  }

  if (!args.projectId) {
    return 'Error: projectId is required.';
  }

  const title = String(args.title);
  const projectId = String(args.projectId);
  const description = args.description ? String(args.description) : undefined;
  const priority = args.priority as number | undefined;
  const assignedAgentId = args.assignedAgentId ? String(args.assignedAgentId) : undefined;

  const client = getClient();

  try {
    const task = await client.createTask({
      title,
      projectId,
      description,
      priority,
      assignedAgentId,
    });

    return `Task created successfully:\n\n${formatTask(task)}`;
  } catch (error) {
    if (error instanceof CavendoApiError) {
      if (error.statusCode === 404) {
        return `Project not found: ${projectId}`;
      }
      if (error.statusCode === 401) {
        return `Not authorized to create tasks. Check your API key permissions.`;
      }
      return `Error creating task: ${error.message}`;
    }
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

// ============================================================================
// Export
// ============================================================================

export const taskTools = [
  listTasksTool,
  getNextTaskTool,
  getTaskContextTool,
  updateTaskStatusTool,
  logProgressTool,
  claimTaskTool,
  createTaskTool,
  listAgentsTool,
];

export const taskHandlers: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  cavendo_list_tasks: handleListTasks,
  cavendo_get_next_task: handleGetNextTask,
  cavendo_get_task_context: handleGetTaskContext,
  cavendo_update_task_status: handleUpdateTaskStatus,
  cavendo_log_progress: handleLogProgress,
  cavendo_claim_task: handleClaimTask,
  cavendo_create_task: handleCreateTask,
  cavendo_list_agents: handleListAgents,
};

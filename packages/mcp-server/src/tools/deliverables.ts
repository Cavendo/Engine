/**
 * Deliverable-related MCP tools for Cavendo Engine
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getClient, Deliverable, CavendoApiError } from '../client.js';

// ============================================================================
// Types
// ============================================================================

interface DeliverableFeedback {
  id: string;
  status: 'pending' | 'approved' | 'revision_requested' | 'rejected';
  feedback: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const submitDeliverableTool: Tool = {
  name: 'cavendo_submit_deliverable',
  description:
    'Submit a deliverable for a task. IMPORTANT: Use the "files" array for ANY file you want delivered with its proper ' +
    'extension — markdown (.md), HTML, CSS, JS, text, etc. The "content" field is only for plain text shown in the ' +
    'Overview tab (rendered as .txt). Use "summary" to describe what was created. After submitting, update the task status to "review".',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task this deliverable is for. Omit for standalone deliverables.',
      },
      projectId: {
        type: 'string',
        description: 'Project ID or name to associate with (if no taskId). Use for standalone deliverables.',
      },
      title: {
        type: 'string',
        description: 'A descriptive title for the deliverable (e.g., "Landing Page Mockup").',
      },
      summary: {
        type: 'string',
        description: 'Text description of the work completed (markdown supported). This is shown in the Overview tab. ' +
          'For code deliverables, describe what was built and any key decisions made.',
      },
      content: {
        type: 'string',
        description: 'Plain text shown in the Overview tab (rendered as a .txt file). For markdown, HTML, code, or any ' +
          'formatted content, use the "files" array with the appropriate extension instead.',
      },
      files: {
        type: 'array',
        description: 'Array of file attachments. Use this for ANY file you want delivered with proper rendering — ' +
          'markdown (.md), HTML, CSS, JS, text, images, etc. Each file needs filename (with extension) and content.',
        items: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'Filename with extension (e.g., "landing-page.html", "styles.css", "App.jsx")',
            },
            content: {
              type: 'string',
              description: 'The complete file content. For binary files, prefix with "base64:".',
            },
            mimeType: {
              type: 'string',
              description: 'Optional MIME type. Auto-detected from extension if not provided.',
            },
          },
          required: ['filename', 'content'],
        },
      },
      actions: {
        type: 'array',
        description: 'Follow-up action items for the reviewer to complete.',
        items: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'The action item (e.g., "Review the landing page copy", "Test on mobile")',
            },
            estimated_time_minutes: {
              type: 'number',
              description: 'Estimated time in minutes (default: 25)',
            },
            notes: {
              type: 'string',
              description: 'Additional context or instructions',
            },
          },
          required: ['text'],
        },
      },
      metadata: {
        type: 'object',
        description: 'Optional metadata (sources, references, etc.).',
        additionalProperties: true,
      },
      inputTokens: {
        type: 'number',
        description: 'Number of input tokens used to generate this deliverable (for cost tracking).',
      },
      outputTokens: {
        type: 'number',
        description: 'Number of output tokens generated (for cost tracking).',
      },
      provider: {
        type: 'string',
        description: 'AI provider used (e.g., "anthropic", "openai").',
      },
      model: {
        type: 'string',
        description: 'Model used (e.g., "claude-opus-4", "gpt-4o").',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

export const getRevisionFeedbackTool: Tool = {
  name: 'cavendo_get_revision_feedback',
  description:
    'Get feedback for a deliverable that needs revision. Use this when a deliverable has status "revision_requested" ' +
    'to understand what changes are needed before submitting a revised version.',
  inputSchema: {
    type: 'object',
    properties: {
      deliverableId: {
        type: 'string',
        description: 'The ID of the deliverable to get feedback for.',
      },
    },
    required: ['deliverableId'],
    additionalProperties: false,
  },
};

export const submitRevisionTool: Tool = {
  name: 'cavendo_submit_revision',
  description:
    'Submit a revised version of a deliverable. Use this after receiving revision feedback ' +
    'to submit an updated version that addresses the requested changes. ' +
    'IMPORTANT: For HTML, JSX, CSS, JS, or code files, use the "files" array instead of "content".',
  inputSchema: {
    type: 'object',
    properties: {
      deliverableId: {
        type: 'string',
        description: 'The ID of the deliverable to revise.',
      },
      summary: {
        type: 'string',
        description: 'Text description of the revision changes (shown in Overview tab). ' +
          'For code deliverables, describe what was changed.',
      },
      content: {
        type: 'string',
        description: 'The revised content (for text/markdown). DO NOT use for HTML/code - use "files" array instead.',
      },
      files: {
        type: 'array',
        description: 'REQUIRED for code revisions. Array of file attachments (HTML, JSX, CSS, JS, etc.).',
        items: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'Filename with extension (e.g., "landing-page.html", "styles.css")',
            },
            content: {
              type: 'string',
              description: 'The complete file content. For binary files, prefix with "base64:".',
            },
            mimeType: {
              type: 'string',
              description: 'Optional MIME type. Auto-detected from extension if not provided.',
            },
          },
          required: ['filename', 'content'],
        },
      },
      title: {
        type: 'string',
        description: 'Optional new title for the revision.',
      },
      contentType: {
        type: 'string',
        enum: ['markdown', 'html', 'json', 'text', 'code'],
        description: 'Optional new content type for the revision.',
      },
      metadata: {
        type: 'object',
        description: 'Optional additional metadata for the revision.',
        additionalProperties: true,
      },
    },
    required: ['deliverableId'],
    additionalProperties: false,
  },
};

// ============================================================================
// Tool Handlers
// ============================================================================

function formatDeliverable(deliverable: Deliverable): string {
  const parts = [
    `**${deliverable.title}**`,
    `- ID: ${deliverable.id}`,
    `- Content Type: ${deliverable.contentType}`,
    `- Status: ${deliverable.status}`,
    `- Version: ${deliverable.version}`,
    `- Task ID: ${deliverable.taskId}`,
  ];

  if (deliverable.feedback) {
    parts.push(`- Feedback: ${deliverable.feedback}`);
  }

  parts.push(`- Created: ${deliverable.createdAt}`);
  parts.push(`- Updated: ${deliverable.updatedAt}`);

  return parts.join('\n');
}

function formatFeedback(feedback: DeliverableFeedback): string {
  const parts = [
    '## Revision Feedback',
    '',
    `**Status**: ${feedback.status}`,
  ];

  if (feedback.reviewedBy) {
    parts.push(`**Reviewed By**: ${feedback.reviewedBy}`);
  }

  if (feedback.reviewedAt) {
    parts.push(`**Reviewed At**: ${feedback.reviewedAt}`);
  }

  if (feedback.feedback) {
    parts.push('');
    parts.push('### Feedback');
    parts.push(feedback.feedback);
  } else {
    parts.push('');
    parts.push('*No feedback provided.*');
  }

  return parts.join('\n');
}

export async function handleSubmitDeliverable(args: Record<string, unknown>): Promise<string> {
  const taskIdStr = args.taskId as string | undefined;
  const projectId = args.projectId as string | undefined;
  const title = args.title as string;
  const summary = args.summary as string | undefined;
  const content = args.content as string | undefined;
  const files = args.files as Array<{ filename: string; content: string; mimeType?: string }> | undefined;
  const actions = args.actions as Array<{ text: string; estimated_time_minutes?: number; notes?: string }> | undefined;
  const metadata = args.metadata as Record<string, unknown> | undefined;
  const inputTokens = args.inputTokens as number | undefined;
  const outputTokens = args.outputTokens as number | undefined;
  const provider = args.provider as string | undefined;
  const model = args.model as string | undefined;

  if (!title) {
    return 'Error: title is required.';
  }

  // Require at least summary, content, or files
  if (!summary && !content && (!files || files.length === 0)) {
    return 'Error: At least one of summary, content, or files is required.';
  }

  // Parse taskId if provided
  let taskId: number | undefined;
  if (taskIdStr) {
    taskId = parseInt(taskIdStr, 10);
    if (isNaN(taskId)) {
      return 'Error: taskId must be a valid number.';
    }
  }

  const client = getClient();

  try {
    // Map actions to expected format
    const mappedActions = actions?.map(a => ({
      action_text: a.text,
      estimated_time_minutes: a.estimated_time_minutes,
      notes: a.notes,
    }));

    const deliverable = await client.submitDeliverable({
      taskId,
      projectId,
      title,
      summary,
      content,
      files,
      actions: mappedActions,
      metadata,
      inputTokens,
      outputTokens,
      provider,
      model,
    });

    let response = `Deliverable submitted successfully:\n\n${formatDeliverable(deliverable)}`;

    if (taskId) {
      response += '\n\nRemember to update the task status to "review" when all deliverables are submitted.';
    } else {
      response += '\n\nNote: This deliverable was submitted without a linked task. A reviewer can link it to a task later.';
    }

    return response;
  } catch (error) {
    if (error instanceof CavendoApiError) {
      if (error.statusCode === 404) {
        return taskId ? `Task not found: ${taskId}` : `Project not found: ${projectId}`;
      }
      return `Error submitting deliverable: ${error.message} (HTTP ${error.statusCode})`;
    }
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export async function handleGetRevisionFeedback(args: Record<string, unknown>): Promise<string> {
  if (!args.deliverableId) {
    return 'Error: deliverableId is required.';
  }

  const deliverableId = String(args.deliverableId);
  const client = getClient();

  try {
    const feedback = await client.getDeliverableFeedback(deliverableId);
    return formatFeedback(feedback as DeliverableFeedback);
  } catch (error) {
    if (error instanceof CavendoApiError) {
      if (error.statusCode === 404) {
        return `Deliverable not found or no feedback available: ${deliverableId}`;
      }
      return `Error getting feedback: ${error.message} (HTTP ${error.statusCode})`;
    }
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

export async function handleSubmitRevision(args: Record<string, unknown>): Promise<string> {
  if (!args.deliverableId) {
    return 'Error: deliverableId is required.';
  }

  const deliverableId = String(args.deliverableId);
  const summary = args.summary as string | undefined;
  const content = args.content as string | undefined;
  const files = args.files as Array<{ filename: string; content: string; mimeType?: string }> | undefined;
  const title = args.title as string | undefined;
  const contentType = args.contentType as 'markdown' | 'html' | 'json' | 'text' | 'code' | undefined;
  const metadata = args.metadata as Record<string, unknown> | undefined;

  // Require at least summary, content, or files
  if (!summary && !content && (!files || files.length === 0)) {
    return 'Error: At least one of summary, content, or files is required.';
  }

  const client = getClient();

  try {
    const deliverable = await client.submitRevision(deliverableId, {
      summary,
      content,
      files,
      title,
      contentType,
      metadata,
    });

    return `Revision submitted successfully:\n\n${formatDeliverable(deliverable)}\n\nThe deliverable is now at version ${deliverable.version}.`;
  } catch (error) {
    if (error instanceof CavendoApiError) {
      if (error.statusCode === 404) {
        return `Deliverable not found: ${deliverableId}`;
      }
      return `Error submitting revision: ${error.message} (HTTP ${error.statusCode})`;
    }
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

// ============================================================================
// Export
// ============================================================================

export const deliverableTools = [
  submitDeliverableTool,
  getRevisionFeedbackTool,
  submitRevisionTool,
];

export const deliverableHandlers: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  cavendo_submit_deliverable: handleSubmitDeliverable,
  cavendo_get_revision_feedback: handleGetRevisionFeedback,
  cavendo_submit_revision: handleSubmitRevision,
};

/**
 * MCP Resource definitions for Cavendo Engine
 */

import { Resource, ResourceTemplate } from '@modelcontextprotocol/sdk/types.js';
import { getClient, Project, Task, KnowledgeDocument, CavendoApiError } from '../client.js';

// ============================================================================
// URI Sanitization
// ============================================================================

/**
 * Sanitize a resource URI to prevent path traversal and other injection attacks
 * @param uri The URI to sanitize
 * @returns The sanitized URI
 */
function sanitizeUri(uri: string): string {
  // Remove any path traversal attempts (..)
  let sanitized = uri.replace(/\.\./g, '');

  // Normalize multiple slashes to single slashes (but preserve protocol://)
  sanitized = sanitized.replace(/([^:])\/\//g, '$1/');

  // Remove any null bytes or control characters
  sanitized = sanitized.replace(/[\x00-\x1f\x7f]/g, '');

  // Trim whitespace
  sanitized = sanitized.trim();

  return sanitized;
}

/**
 * Sanitize a path segment (like project ID) to prevent injection
 * @param segment The path segment to sanitize
 * @returns The sanitized segment
 */
function sanitizePathSegment(segment: string): string {
  // Remove any path traversal attempts
  let sanitized = segment.replace(/\.\./g, '');

  // Remove forward/back slashes
  sanitized = sanitized.replace(/[/\\]/g, '');

  // Remove null bytes and control characters
  sanitized = sanitized.replace(/[\x00-\x1f\x7f]/g, '');

  // Trim whitespace
  sanitized = sanitized.trim();

  return sanitized;
}

// ============================================================================
// Resource Templates
// ============================================================================

/**
 * Static resource for listing all projects
 */
export const projectsResource: Resource = {
  uri: 'cavendo://projects',
  name: 'Cavendo Projects',
  description: 'List all projects the agent has access to in Cavendo Engine',
  mimeType: 'text/markdown',
};

/**
 * Static resource for assigned tasks
 */
export const assignedTasksResource: Resource = {
  uri: 'cavendo://tasks/assigned',
  name: 'Assigned Tasks',
  description: 'All tasks currently assigned to this agent',
  mimeType: 'text/markdown',
};

/**
 * Template for project-specific knowledge
 */
export const projectKnowledgeTemplate: ResourceTemplate = {
  uriTemplate: 'cavendo://projects/{id}/knowledge',
  name: 'Project Knowledge',
  description: 'Knowledge documents for a specific project',
  mimeType: 'text/markdown',
};

// ============================================================================
// Resource Handlers
// ============================================================================

function formatProject(project: Project): string {
  const parts = [
    `### ${project.name}`,
    '',
    `- **ID**: ${project.id}`,
    `- **Status**: ${project.status}`,
  ];

  if (project.description) {
    parts.push(`- **Description**: ${project.description}`);
  }

  parts.push(`- **Created**: ${project.createdAt}`);

  return parts.join('\n');
}

function formatTask(task: Task): string {
  const parts = [
    `### ${task.title}`,
    '',
    `- **ID**: ${task.id}`,
    `- **Status**: ${task.status}`,
    `- **Priority**: ${task.priority}`,
  ];

  if (task.projectName) {
    parts.push(`- **Project**: ${task.projectName}`);
  }

  if (task.dueDate) {
    parts.push(`- **Due Date**: ${task.dueDate}`);
  }

  if (task.tags && task.tags.length > 0) {
    parts.push(`- **Tags**: ${task.tags.join(', ')}`);
  }

  if (task.description) {
    parts.push('');
    parts.push('**Description:**');
    parts.push(task.description);
  }

  return parts.join('\n');
}

function formatKnowledgeDocument(doc: KnowledgeDocument): string {
  const parts = [
    `### ${doc.title}`,
    '',
    `- **ID**: ${doc.id}`,
    `- **Type**: ${doc.type}`,
  ];

  if (doc.tags.length > 0) {
    parts.push(`- **Tags**: ${doc.tags.join(', ')}`);
  }

  parts.push('');
  parts.push('**Content:**');
  parts.push('');
  parts.push(doc.content);

  return parts.join('\n');
}

/**
 * Read the projects resource
 */
export async function readProjectsResource(): Promise<string> {
  const client = getClient();

  try {
    const projects = await client.listProjects();

    if (projects.length === 0) {
      return '# Projects\n\nNo projects available.';
    }

    const sections = [
      '# Projects',
      '',
      `You have access to ${projects.length} project(s):`,
      '',
    ];

    for (const project of projects) {
      sections.push(formatProject(project));
      sections.push('');
      sections.push('---');
      sections.push('');
    }

    return sections.join('\n');
  } catch (error) {
    if (error instanceof CavendoApiError) {
      return `# Projects\n\nError loading projects: ${error.message}`;
    }
    throw error;
  }
}

/**
 * Read the assigned tasks resource
 */
export async function readAssignedTasksResource(): Promise<string> {
  const client = getClient();

  try {
    const tasks = await client.listTasks();

    if (tasks.length === 0) {
      return '# Assigned Tasks\n\nNo tasks currently assigned. Use `cavendo_get_next_task` to get work from the queue.';
    }

    // Group tasks by status
    const tasksByStatus: Record<string, Task[]> = {};
    for (const task of tasks) {
      if (!tasksByStatus[task.status]) {
        tasksByStatus[task.status] = [];
      }
      tasksByStatus[task.status].push(task);
    }

    const sections = [
      '# Assigned Tasks',
      '',
      `Total: ${tasks.length} task(s)`,
      '',
    ];

    // Status order matches actual Engine statuses: pending, assigned, in_progress, review, completed, cancelled
    const statusOrder = ['in_progress', 'assigned', 'pending', 'review', 'completed', 'cancelled'];

    for (const status of statusOrder) {
      const statusTasks = tasksByStatus[status];
      if (statusTasks && statusTasks.length > 0) {
        sections.push(`## ${status.replace('_', ' ').toUpperCase()} (${statusTasks.length})`);
        sections.push('');

        for (const task of statusTasks) {
          sections.push(formatTask(task));
          sections.push('');
          sections.push('---');
          sections.push('');
        }
      }
    }

    return sections.join('\n');
  } catch (error) {
    if (error instanceof CavendoApiError) {
      return `# Assigned Tasks\n\nError loading tasks: ${error.message}`;
    }
    throw error;
  }
}

/**
 * Read project knowledge resource
 */
export async function readProjectKnowledgeResource(projectId: string): Promise<string> {
  const client = getClient();

  try {
    const [project, knowledge] = await Promise.all([
      client.getProject(projectId),
      client.getProjectKnowledge(projectId),
    ]);

    const sections = [
      `# Knowledge: ${project.name}`,
      '',
      `Project: ${project.name}`,
      '',
    ];

    if (knowledge.length === 0) {
      sections.push('No knowledge documents available for this project.');
    } else {
      sections.push(`Found ${knowledge.length} knowledge document(s):`, '');

      // Group by type
      const docsByType: Record<string, KnowledgeDocument[]> = {};
      for (const doc of knowledge) {
        if (!docsByType[doc.type]) {
          docsByType[doc.type] = [];
        }
        docsByType[doc.type].push(doc);
      }

      const typeOrder = ['documentation', 'guideline', 'template', 'example', 'reference'];

      for (const type of typeOrder) {
        const typeDocs = docsByType[type];
        if (typeDocs && typeDocs.length > 0) {
          sections.push(`## ${type.charAt(0).toUpperCase() + type.slice(1)}s`);
          sections.push('');

          for (const doc of typeDocs) {
            sections.push(formatKnowledgeDocument(doc));
            sections.push('');
            sections.push('---');
            sections.push('');
          }
        }
      }
    }

    return sections.join('\n');
  } catch (error) {
    if (error instanceof CavendoApiError) {
      if (error.statusCode === 404) {
        return `# Knowledge\n\nProject not found: ${projectId}`;
      }
      return `# Knowledge\n\nError loading knowledge: ${error.message}`;
    }
    throw error;
  }
}

// ============================================================================
// Resource Registry
// ============================================================================

/**
 * All static resources
 */
export const staticResources: Resource[] = [
  projectsResource,
  assignedTasksResource,
];

/**
 * All resource templates
 */
export const resourceTemplates: ResourceTemplate[] = [
  projectKnowledgeTemplate,
];

/**
 * Parse a resource URI and return the handler result
 */
export async function readResource(uri: string): Promise<string> {
  // Sanitize the URI to prevent path traversal attacks
  const sanitizedUri = sanitizeUri(uri);

  // Validate URI format (must be a cavendo:// URI)
  if (!sanitizedUri.startsWith('cavendo://')) {
    throw new Error(`Invalid resource URI format: ${uri}`);
  }

  // Handle static resources
  if (sanitizedUri === 'cavendo://projects') {
    return readProjectsResource();
  }

  if (sanitizedUri === 'cavendo://tasks/assigned') {
    return readAssignedTasksResource();
  }

  // Handle templated resources
  const projectKnowledgeMatch = sanitizedUri.match(/^cavendo:\/\/projects\/([^/]+)\/knowledge$/);
  if (projectKnowledgeMatch) {
    const projectId = sanitizePathSegment(projectKnowledgeMatch[1]);
    if (!projectId) {
      throw new Error('Invalid project ID in resource URI');
    }
    return readProjectKnowledgeResource(projectId);
  }

  throw new Error(`Unknown resource: ${uri}`);
}

/**
 * List all available resources (static resources only, templates generate dynamic resources)
 */
export async function listResources(): Promise<Resource[]> {
  // Return static resources
  // Note: Dynamic resources from templates would need to be discovered by querying the API
  return staticResources;
}

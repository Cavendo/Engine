/**
 * Knowledge-related MCP tools for Cavendo Engine
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getClient, KnowledgeDocument, CavendoApiError } from '../client.js';

// ============================================================================
// Tool Definitions
// ============================================================================

export const searchKnowledgeTool: Tool = {
  name: 'cavendo_search_knowledge',
  description:
    'Search the Cavendo knowledge base for relevant documentation, guidelines, references, or examples. ' +
    'Use this to find information that can help with completing tasks, understanding project requirements, ' +
    'or following best practices.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to find relevant knowledge documents.',
      },
      projectId: {
        type: 'string',
        description: 'Optional: Limit search to a specific project\'s knowledge base.',
      },
      type: {
        type: 'string',
        enum: ['documentation', 'guideline', 'reference', 'template', 'example'],
        description: 'Optional: Filter by knowledge document type.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10).',
        default: 10,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

// ============================================================================
// Tool Handlers
// ============================================================================

function formatKnowledgeDocument(doc: KnowledgeDocument, includeContent: boolean = true): string {
  const parts = [
    `### ${doc.title}`,
    '',
    `- **ID**: ${doc.id}`,
    `- **Type**: ${doc.type}`,
  ];

  if (doc.projectId) {
    parts.push(`- **Project**: ${doc.projectId}`);
  }

  if (doc.tags.length > 0) {
    parts.push(`- **Tags**: ${doc.tags.join(', ')}`);
  }

  if (doc.relevanceScore !== undefined) {
    parts.push(`- **Relevance**: ${Math.round(doc.relevanceScore * 100)}%`);
  }

  if (includeContent && doc.content) {
    parts.push('');
    parts.push('**Content:**');
    parts.push('');
    // Limit content length for readability
    const maxLength = 2000;
    if (doc.content.length > maxLength) {
      parts.push(doc.content.substring(0, maxLength) + '...');
      parts.push('');
      parts.push(`(Content truncated. Full document is ${doc.content.length} characters.)`);
    } else {
      parts.push(doc.content);
    }
  }

  return parts.join('\n');
}

export async function handleSearchKnowledge(args: Record<string, unknown>): Promise<string> {
  if (!args.query) {
    return 'Error: query is required.';
  }

  const query = String(args.query);
  const projectId = args.projectId ? String(args.projectId) : undefined;
  const type = args.type as string | undefined;
  const limit = (args.limit as number) || 10;

  const client = getClient();

  try {
    const documents = await client.searchKnowledge({
      query,
      projectId,
      type,
      limit,
    });

    if (documents.length === 0) {
      const filters: string[] = [];
      if (projectId) filters.push(`project "${projectId}"`);
      if (type) filters.push(`type "${type}"`);
      const filterStr = filters.length > 0 ? ` (filtered by ${filters.join(', ')})` : '';

      return `No knowledge documents found matching "${query}"${filterStr}.`;
    }

    const sections = [
      `## Knowledge Search Results`,
      '',
      `Found ${documents.length} document(s) matching "${query}":`,
      '',
    ];

    for (const doc of documents) {
      sections.push(formatKnowledgeDocument(doc));
      sections.push('');
      sections.push('---');
      sections.push('');
    }

    return sections.join('\n');
  } catch (error) {
    if (error instanceof CavendoApiError) {
      return `Error searching knowledge: ${error.message} (HTTP ${error.statusCode})`;
    }
    return `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}

// ============================================================================
// Export
// ============================================================================

export const knowledgeTools = [
  searchKnowledgeTool,
];

export const knowledgeHandlers: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  cavendo_search_knowledge: handleSearchKnowledge,
};

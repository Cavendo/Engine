/**
 * Cavendo MCP Server
 *
 * An MCP (Model Context Protocol) server that allows AI agents to interact
 * with the Cavendo Engine API for task management, deliverables, and knowledge.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { allTools, executeTool } from './tools/index.js';
import {
  staticResources,
  resourceTemplates,
  readResource,
} from './resources/index.js';
import { CavendoApiError, CavendoConfigError, getClient } from './client.js';

// ============================================================================
// Server Configuration
// ============================================================================

const SERVER_NAME = 'cavendo-mcp-server';
const SERVER_VERSION = '0.1.0';

// ============================================================================
// Server Setup
// ============================================================================

/**
 * Create and configure the MCP server
 */
export function createServer(): Server {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // --------------------------------------------------------------------------
  // Tool Handlers
  // --------------------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: allTools,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await executeTool(name, args || {});
      return {
        content: [
          {
            type: 'text',
            text: result,
          },
        ],
      };
    } catch (error) {
      if (error instanceof CavendoApiError) {
        return {
          content: [
            {
              type: 'text',
              text: `API Error (${error.statusCode}): ${error.message}`,
            },
          ],
          isError: true,
        };
      }

      if (error instanceof CavendoConfigError) {
        return {
          content: [
            {
              type: 'text',
              text: `Configuration Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }

      if (error instanceof Error && error.message.startsWith('Unknown tool:')) {
        throw new McpError(ErrorCode.MethodNotFound, error.message);
      }

      // Handle any other errors with proper serialization
      const errorMessage = error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : JSON.stringify(error);

      return {
        content: [
          {
            type: 'text',
            text: `Unexpected Error: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  // --------------------------------------------------------------------------
  // Resource Handlers
  // --------------------------------------------------------------------------

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: staticResources,
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: resourceTemplates,
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    try {
      const content = await readResource(uri);
      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: content,
          },
        ],
      };
    } catch (error) {
      if (error instanceof CavendoApiError) {
        throw new McpError(
          ErrorCode.InternalError,
          `API Error: ${error.message}`
        );
      }

      if (error instanceof Error && error.message.startsWith('Unknown resource:')) {
        throw new McpError(ErrorCode.InvalidRequest, error.message);
      }

      throw error;
    }
  });

  return server;
}

// ============================================================================
// Server Startup
// ============================================================================

/**
 * Start the MCP server
 */
export async function startServer(): Promise<void> {
  // Validate configuration before starting
  try {
    getClient();
  } catch (error) {
    if (error instanceof CavendoConfigError) {
      console.error(`Configuration Error: ${error.message}`);
      console.error('');
      console.error('Please set the required environment variables:');
      console.error('  CAVENDO_AGENT_KEY - Your agent API key (required)');
      console.error('  CAVENDO_URL - Cavendo Engine URL (optional, defaults to http://localhost:3001)');
      process.exit(1);
    }
    throw error;
  }

  const server = createServer();
  const transport = new StdioServerTransport();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });

  // Connect and run
  await server.connect(transport);

  // Log to stderr (stdout is used for MCP communication)
  console.error(`${SERVER_NAME} v${SERVER_VERSION} started`);
  console.error(`Connected to Cavendo Engine`);
}

// ============================================================================
// Exports
// ============================================================================

export * from './client.js';
export * from './tools/index.js';
export * from './resources/index.js';

#!/usr/bin/env node

/**
 * Cavendo MCP Server CLI Entry Point
 *
 * This script starts the Cavendo MCP server for AI agent integration.
 *
 * Environment Variables:
 *   CAVENDO_URL - Base URL of Cavendo Engine (default: http://localhost:3001)
 *   CAVENDO_AGENT_KEY - Agent API key (required)
 */

import { startServer } from '../dist/index.js';

startServer().catch((error) => {
  console.error('Failed to start Cavendo MCP server:', error);
  process.exit(1);
});

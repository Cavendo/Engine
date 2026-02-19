/**
 * Export all MCP tools for Cavendo Engine
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { taskTools, taskHandlers } from './tasks.js';
import { deliverableTools, deliverableHandlers } from './deliverables.js';
import { knowledgeTools, knowledgeHandlers } from './knowledge.js';

// ============================================================================
// Input Validation
// ============================================================================

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

interface ValidationError {
  path: string;
  message: string;
}

/**
 * Validate arguments against a JSON schema
 * Returns an array of validation errors (empty if valid)
 */
function validateArgs(args: Record<string, unknown>, schema: JsonSchema, path: string = ''): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check required properties
  if (schema.required) {
    for (const requiredProp of schema.required) {
      if (args[requiredProp] === undefined || args[requiredProp] === null) {
        errors.push({
          path: path ? `${path}.${requiredProp}` : requiredProp,
          message: `Required property "${requiredProp}" is missing`,
        });
      }
    }
  }

  // Validate each provided property
  if (schema.properties) {
    for (const [key, value] of Object.entries(args)) {
      const propSchema = schema.properties[key];
      const propPath = path ? `${path}.${key}` : key;

      if (!propSchema) {
        // Property not in schema - skip (additionalProperties handling)
        continue;
      }

      // Type validation
      if (propSchema.type && value !== undefined && value !== null) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;

        if (propSchema.type === 'number' && actualType === 'string') {
          // Allow string numbers to be coerced
          const parsed = Number(value);
          if (isNaN(parsed)) {
            errors.push({
              path: propPath,
              message: `Expected type "number" but got "${actualType}" that cannot be parsed`,
            });
          }
        } else if (propSchema.type !== actualType) {
          errors.push({
            path: propPath,
            message: `Expected type "${propSchema.type}" but got "${actualType}"`,
          });
        }
      }

      // Enum validation
      if (propSchema.enum && value !== undefined && value !== null) {
        if (!propSchema.enum.includes(value)) {
          errors.push({
            path: propPath,
            message: `Value "${value}" is not one of the allowed values: ${propSchema.enum.join(', ')}`,
          });
        }
      }

      // Number range validation
      if (propSchema.type === 'number' && typeof value === 'number') {
        if (propSchema.minimum !== undefined && value < propSchema.minimum) {
          errors.push({
            path: propPath,
            message: `Value ${value} is less than minimum ${propSchema.minimum}`,
          });
        }
        if (propSchema.maximum !== undefined && value > propSchema.maximum) {
          errors.push({
            path: propPath,
            message: `Value ${value} is greater than maximum ${propSchema.maximum}`,
          });
        }
      }

      // Array validation
      if (propSchema.type === 'array' && Array.isArray(value) && propSchema.items) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (typeof item === 'object' && item !== null && propSchema.items.properties) {
            const itemErrors = validateArgs(
              item as Record<string, unknown>,
              propSchema.items,
              `${propPath}[${i}]`
            );
            errors.push(...itemErrors);
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Format validation errors into a readable string
 */
function formatValidationErrors(errors: ValidationError[]): string {
  const lines = ['**Input Validation Error**', ''];
  for (const error of errors) {
    lines.push(`- \`${error.path}\`: ${error.message}`);
  }
  return lines.join('\n');
}

// ============================================================================
// Combined Exports
// ============================================================================

/**
 * All available tools
 */
export const allTools: Tool[] = [
  ...taskTools,
  ...deliverableTools,
  ...knowledgeTools,
];

/**
 * All tool handlers
 */
export const allHandlers: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  ...taskHandlers,
  ...deliverableHandlers,
  ...knowledgeHandlers,
};

/**
 * Get a tool by name
 */
export function getTool(name: string): Tool | undefined {
  return allTools.find(tool => tool.name === name);
}

/**
 * Get a handler by tool name
 */
export function getHandler(name: string): ((args: Record<string, unknown>) => Promise<string>) | undefined {
  return allHandlers[name];
}

/**
 * Execute a tool by name with the given arguments
 * Validates input arguments against the tool's schema before execution
 */
export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = getTool(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const handler = getHandler(name);
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }

  // Validate input arguments against the tool's schema
  if (tool.inputSchema) {
    const validationErrors = validateArgs(args, tool.inputSchema as JsonSchema);
    if (validationErrors.length > 0) {
      return formatValidationErrors(validationErrors);
    }
  }

  return handler(args);
}

// Re-export individual modules
export * from './tasks.js';
export * from './deliverables.js';
export * from './knowledge.js';

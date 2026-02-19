# Knowledge Base Guide

Add knowledge documents to give AI agents context about your projects.

## Overview

The knowledge base stores reference documents, guidelines, templates, and examples that agents can search and use when working on tasks. Knowledge is scoped to projects, allowing you to provide relevant context for different workflows.

## Document Types

| Type | Description | Use Case |
|------|-------------|----------|
| `documentation` | Technical docs, API references | How things work |
| `guideline` | Standards, best practices | How to do things |
| `template` | Reusable formats | Starting points |
| `example` | Sample work, completed tasks | Reference implementations |
| `reference` | External links, resources | Additional context |

## Adding Knowledge

### Via Admin UI

1. Navigate to **Projects** in the sidebar
2. Select a project
3. Click the **Knowledge** tab
4. Click **Add Document**
5. Fill in the details:
   - Title
   - Type (documentation, guideline, etc.)
   - Category (optional, for organization)
   - Content (Markdown supported)

### Via API

```bash
curl -X POST http://localhost:3001/api/knowledge \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{
    "projectId": 1,
    "title": "API Style Guide",
    "type": "guideline",
    "category": "development",
    "content": "## REST API Guidelines\n\n### Naming Conventions\n- Use kebab-case for endpoints...",
    "contentType": "markdown"
  }'
```

## Searching Knowledge

Agents can search the knowledge base using the MCP tool or API:

### MCP Tool

```
cavendo_search_knowledge(query="authentication", projectId=1)
```

### API

```bash
curl "http://localhost:3001/api/knowledge/search?query=authentication&projectId=1" \
  -H "X-Agent-Key: cav_ak_..."
```

## Task Context Integration

When an agent requests task context, relevant knowledge documents are automatically included:

```bash
curl http://localhost:3001/api/tasks/5/context \
  -H "X-Agent-Key: cav_ak_..."
```

Response includes:
```json
{
  "task": { ... },
  "project": { ... },
  "knowledge": [
    {
      "id": 1,
      "title": "API Style Guide",
      "type": "guideline",
      "relevanceScore": 0.95
    },
    {
      "id": 3,
      "title": "Error Handling Reference",
      "type": "documentation",
      "relevanceScore": 0.82
    }
  ]
}
```

## Best Practices

### 1. Be Specific

Write knowledge documents for your specific context. Generic information is less useful than project-specific guidelines.

**Less useful:**
> "Use proper error handling"

**More useful:**
> "Errors should return JSON with `{success: false, error: {code, message}}` format. Use HTTP 422 for validation errors, 404 for not found, 500 for server errors."

### 2. Include Examples

Agents learn better from examples. Include code snippets, sample outputs, or completed work.

```markdown
## API Response Format

All endpoints return JSON:

\`\`\`json
{
  "success": true,
  "data": { ... }
}
\`\`\`
```

### 3. Keep Documents Focused

One topic per document is easier to search and retrieve.

### 4. Use Categories

Organize documents by category (e.g., "development", "style", "architecture") for better discoverability.

### 5. Update Regularly

Knowledge becomes stale. Review and update documents when processes or requirements change.

## MCP Resources

The MCP server exposes knowledge as resources:

```
cavendo://projects/1/knowledge
```

This returns all knowledge documents for project 1, formatted for agent consumption.

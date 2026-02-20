/**
 * Task Router Service
 * Handles automatic task assignment based on project routing rules.
 */

import db from '../db/connection.js';

// ============================================
// Main Entry Point
// ============================================

/**
 * Evaluate routing rules for a task and determine assignment
 * @param {number} projectId - Project ID to load rules from
 * @param {Object} task - Task object with tags, priority, context
 * @returns {Object} Routing result: { matched, agentId, ruleId, ruleName, decision } or { matched: false, decision }
 */
export function evaluateRoutingRules(projectId, task) {
  // Load project's routing rules
  const project = db.prepare(`
    SELECT task_routing_rules, default_agent_id
    FROM projects
    WHERE id = ?
  `).get(projectId);

  if (!project) {
    return { matched: false, decision: 'Project not found' };
  }

  const rules = safeJsonParse(project.task_routing_rules, []);

  if (!Array.isArray(rules) || rules.length === 0) {
    // No rules configured, try default agent
    return tryDefaultAgent(project.default_agent_id, projectId, task.requiredCapabilities);
  }

  // Sort rules by priority (ascending - lower number = higher priority)
  const sortedRules = [...rules].sort((a, b) =>
    (a.rule_priority || 999) - (b.rule_priority || 999)
  );

  // Check preferred agent first (before routing rules)
  if (task.preferredAgentId) {
    const availability = checkAgentAvailability(task.preferredAgentId);
    if (availability.available && agentHasCapabilities(task.preferredAgentId, task.requiredCapabilities)) {
      return {
        matched: true,
        agentId: parseInt(task.preferredAgentId, 10),
        ruleId: null,
        ruleName: null,
        decision: `Assigned to preferred agent ${task.preferredAgentId}`
      };
    }
  }

  // Iterate through rules and find first match
  for (const rule of sortedRules) {
    // Skip disabled rules
    if (rule.enabled === false) {
      continue;
    }

    // Check if conditions match
    const conditions = rule.conditions || {};
    if (!matchConditions(conditions, task)) {
      continue;
    }

    // Rule matched! Now determine assignment
    let agentId = null;
    let decision = '';

    // Direct assignment
    if (rule.assign_to) {
      const availability = checkAgentAvailability(rule.assign_to);
      if (availability.available && agentHasCapabilities(rule.assign_to, task.requiredCapabilities)) {
        agentId = rule.assign_to;
        decision = `Assigned via rule "${rule.name}" to agent ${agentId}`;
      } else if (rule.fallback_to) {
        // Try fallback agent
        const fallbackAvailability = checkAgentAvailability(rule.fallback_to);
        if (fallbackAvailability.available && agentHasCapabilities(rule.fallback_to, task.requiredCapabilities)) {
          agentId = rule.fallback_to;
          decision = `Assigned via rule "${rule.name}" to fallback agent ${agentId} (primary unavailable: ${availability.reason})`;
        } else {
          decision = `Rule "${rule.name}" matched but no agents available (primary: ${availability.reason}, fallback: ${fallbackAvailability.reason})`;
        }
      } else {
        decision = `Rule "${rule.name}" matched but agent ${rule.assign_to} unavailable: ${availability.reason}`;
      }
    }
    // Capability-based assignment
    else if (rule.assign_to_capability) {
      const strategy = rule.assign_strategy || 'least_busy';
      agentId = findAgentByCapability(rule.assign_to_capability, strategy, task.requiredCapabilities);

      if (agentId) {
        decision = `Assigned via rule "${rule.name}" to agent ${agentId} (capability: ${rule.assign_to_capability}, strategy: ${strategy})`;
      } else {
        decision = `Rule "${rule.name}" matched but no available agents with capability "${rule.assign_to_capability}"`;
      }
    }

    if (agentId) {
      return {
        matched: true,
        agentId: parseInt(agentId, 10),
        ruleId: rule.id,
        ruleName: rule.name,
        decision
      };
    }

    // Rule matched but no agent available - continue to next rule
  }

  // No rules matched, try default agent
  return tryDefaultAgent(project.default_agent_id, projectId, task.requiredCapabilities);
}

/**
 * Try to assign to project's default agent
 * @param {number|null} defaultAgentId - Default agent ID from project
 * @param {number} projectId - Project ID for error messages
 * @param {string[]} requiredCapabilities - Required capabilities the agent must have
 * @returns {Object} Routing result
 */
function tryDefaultAgent(defaultAgentId, projectId, requiredCapabilities) {
  if (!defaultAgentId) {
    return { matched: false, decision: 'No matching rule and no default agent configured' };
  }

  const availability = checkAgentAvailability(defaultAgentId);
  if (availability.available && agentHasCapabilities(defaultAgentId, requiredCapabilities)) {
    return {
      matched: true,
      agentId: parseInt(defaultAgentId, 10),
      ruleId: null,
      ruleName: null,
      decision: `Assigned to project default agent ${defaultAgentId}`
    };
  }

  return {
    matched: false,
    decision: `No matching rule and default agent ${defaultAgentId} unavailable: ${availability.reason}`
  };
}

// ============================================
// Condition Matching
// ============================================

/**
 * Check if a task matches the specified conditions
 * @param {Object} conditions - Condition configuration
 * @param {Object} task - Task object
 * @returns {boolean} True if all conditions match
 */
export function matchConditions(conditions, task) {
  // Empty conditions = catch-all (always matches)
  if (!conditions || Object.keys(conditions).length === 0) {
    return true;
  }

  // Parse task tags if needed
  const taskTags = safeJsonParse(task.tags, []);
  const taskContext = safeJsonParse(task.context, {});

  // Check tag conditions
  if (conditions.tags) {
    // includes_any - task must have at least one of the specified tags
    if (conditions.tags.includes_any) {
      const hasAny = conditions.tags.includes_any.some(tag => taskTags.includes(tag));
      if (!hasAny) return false;
    }

    // includes_all - task must have all of the specified tags
    if (conditions.tags.includes_all) {
      const hasAll = conditions.tags.includes_all.every(tag => taskTags.includes(tag));
      if (!hasAll) return false;
    }
  }

  // Check priority conditions (1=critical, 2=high, 3=medium, 4=low)
  if (conditions.priority) {
    const taskPriority = task.priority || 2; // Default to high

    if (conditions.priority.gte !== undefined) {
      if (taskPriority < conditions.priority.gte) return false;
    }

    if (conditions.priority.lte !== undefined) {
      if (taskPriority > conditions.priority.lte) return false;
    }

    if (conditions.priority.eq !== undefined) {
      if (taskPriority !== conditions.priority.eq) return false;
    }
  }

  // Check metadata conditions (task.context must contain all specified key-value pairs)
  if (conditions.metadata) {
    for (const [key, value] of Object.entries(conditions.metadata)) {
      if (taskContext[key] !== value) return false;
    }
  }

  return true;
}

// ============================================
// Agent Availability
// ============================================

/**
 * Check if an agent is available to receive tasks
 * @param {number|string} agentId - Agent ID to check
 * @returns {Object} { available: boolean, reason?: string }
 */
export function checkAgentAvailability(agentId) {
  const agent = db.prepare(`
    SELECT status, max_concurrent_tasks, active_task_count
    FROM agents
    WHERE id = ?
  `).get(agentId);

  if (!agent) {
    return { available: false, reason: 'Agent not found' };
  }

  if (agent.status !== 'active') {
    return { available: false, reason: `Agent status is ${agent.status}` };
  }

  // Check capacity if max_concurrent_tasks is set
  if (agent.max_concurrent_tasks !== null && agent.max_concurrent_tasks > 0) {
    const activeCount = agent.active_task_count ?? 0;
    if (activeCount >= agent.max_concurrent_tasks) {
      return {
        available: false,
        reason: `At capacity (${activeCount}/${agent.max_concurrent_tasks} tasks)`
      };
    }
  }

  return { available: true };
}

// ============================================
// Capability-Based Routing
// ============================================

/**
 * Find an available agent with a specific capability
 * @param {string} capability - Required capability
 * @param {string} strategy - Selection strategy: 'least_busy', 'round_robin', 'first_available', 'random'
 * @param {string[]} requiredCapabilities - Additional required capabilities the agent must have
 * @returns {number|null} Agent ID or null if none available
 */
export function findAgentByCapability(capability, strategy = 'least_busy', requiredCapabilities) {
  // Find all active agents with the capability
  // capabilities is stored as JSON array, so we search for the capability string
  const agents = db.prepare(`
    SELECT id, active_task_count, max_concurrent_tasks
    FROM agents
    WHERE status = 'active'
      AND capabilities LIKE ?
  `).all(`%"${capability}"%`);

  if (agents.length === 0) {
    return null;
  }

  // Filter by availability and required capabilities
  const availableAgents = agents.filter(agent => {
    const availability = checkAgentAvailability(agent.id);
    return availability.available && agentHasCapabilities(agent.id, requiredCapabilities);
  });

  if (availableAgents.length === 0) {
    return null;
  }

  // Apply selection strategy
  switch (strategy) {
    case 'least_busy':
      // Sort by active_task_count (ascending) and pick first
      availableAgents.sort((a, b) => (a.active_task_count || 0) - (b.active_task_count || 0));
      return availableAgents[0].id;

    case 'round_robin':
      // For true round-robin, we'd need to track last assignment
      // Simplified: use least_busy as a fair distribution proxy
      availableAgents.sort((a, b) => (a.active_task_count || 0) - (b.active_task_count || 0));
      return availableAgents[0].id;

    case 'first_available':
      // Return first agent (sorted by ID for consistency)
      availableAgents.sort((a, b) => a.id - b.id);
      return availableAgents[0].id;

    case 'random':
      // Pick random available agent
      const randomIndex = Math.floor(Math.random() * availableAgents.length);
      return availableAgents[randomIndex].id;

    default:
      // Default to least_busy
      availableAgents.sort((a, b) => (a.active_task_count || 0) - (b.active_task_count || 0));
      return availableAgents[0].id;
  }
}

// ============================================
// Task Count Management
// ============================================

/**
 * Increment the active task count for an agent (atomic update)
 * @param {number|string} agentId - Agent ID
 * @returns {boolean} True if successful
 */
export function incrementActiveTaskCount(agentId) {
  const result = db.prepare(`
    UPDATE agents
    SET active_task_count = COALESCE(active_task_count, 0) + 1,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(agentId);

  return result.changes > 0;
}

/**
 * Decrement the active task count for an agent (atomic update)
 * @param {number|string} agentId - Agent ID
 * @returns {boolean} True if successful
 */
export function decrementActiveTaskCount(agentId) {
  const result = db.prepare(`
    UPDATE agents
    SET active_task_count = MAX(0, COALESCE(active_task_count, 0) - 1),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(agentId);

  return result.changes > 0;
}

// ============================================
// Project Default Agent
// ============================================

/**
 * Get the project's default agent if available
 * @param {number} projectId - Project ID
 * @returns {number|null} Agent ID or null if not set/unavailable
 */
export function getProjectDefaultAgent(projectId) {
  const project = db.prepare(`
    SELECT default_agent_id
    FROM projects
    WHERE id = ?
  `).get(projectId);

  if (!project || !project.default_agent_id) {
    return null;
  }

  const availability = checkAgentAvailability(project.default_agent_id);
  if (!availability.available) {
    return null;
  }

  return project.default_agent_id;
}

// ============================================
// Capability Checking
// ============================================

/**
 * Check if an agent has all the required capabilities
 * @param {number|string} agentId - Agent ID to check
 * @param {string[]} requiredCapabilities - List of required capabilities
 * @returns {boolean} True if agent has all required capabilities (or none required)
 */
function agentHasCapabilities(agentId, requiredCapabilities) {
  if (!requiredCapabilities || requiredCapabilities.length === 0) return true;
  const agent = db.prepare('SELECT capabilities FROM agents WHERE id = ?').get(agentId);
  const agentCaps = safeJsonParse(agent?.capabilities, []);
  return requiredCapabilities.every(cap => agentCaps.includes(cap));
}

// ============================================
// Utility Functions
// ============================================

/**
 * Safely parse JSON with a fallback value
 * @param {string|null} str - JSON string to parse
 * @param {*} defaultValue - Value to return if parsing fails
 * @returns {*} Parsed value or default
 */
function safeJsonParse(str, defaultValue = null) {
  if (!str) return defaultValue;
  if (typeof str === 'object') return str; // Already parsed
  try {
    return JSON.parse(str);
  } catch {
    return defaultValue;
  }
}

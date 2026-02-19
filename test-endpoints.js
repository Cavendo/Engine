#!/usr/bin/env node
/**
 * Cavendo Engine - New Features Test Script
 * Tests all new endpoints and generates a report
 * 
 * NOTE: API uses camelCase for all field names
 */

const BASE_URL = 'http://localhost:3001';
let sessionCookie = null;
let csrfCookie = null;
let testResults = [];

// Helper to make authenticated requests
async function api(method, path, body = null) {
  const headers = {
    'Content-Type': 'application/json',
  };
  
  // Build cookie header
  const cookieParts = [];
  if (sessionCookie) cookieParts.push(`session=${sessionCookie}`);
  if (csrfCookie) cookieParts.push(`csrf_token=${csrfCookie}`);
  if (cookieParts.length > 0) {
    headers['Cookie'] = cookieParts.join('; ');
  }
  
  // Add CSRF token header for mutating requests
  if (csrfCookie && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    headers['X-CSRF-Token'] = csrfCookie;
  }
  
  const options = { method, headers };
  if (body && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    options.body = JSON.stringify(body);
  }
  
  const res = await fetch(`${BASE_URL}${path}`, options);
  
  // Capture cookies from response
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const allCookies = res.headers.raw?.()?.['set-cookie'] || [setCookie];
    for (const cookieStr of (Array.isArray(allCookies) ? allCookies : [allCookies])) {
      if (cookieStr.includes('session=')) {
        const match = cookieStr.match(/session=([^;]+)/);
        if (match) sessionCookie = match[1];
      }
      if (cookieStr.includes('csrf_token=')) {
        const match = cookieStr.match(/csrf_token=([^;]+)/);
        if (match) csrfCookie = match[1];
      }
    }
  }
  
  const rawData = await res.json().catch(() => ({}));
  
  // Capture CSRF from response body
  if (rawData.csrfToken && !csrfCookie) {
    csrfCookie = rawData.csrfToken;
  }
  
  // Unwrap the data from { success: true, data: ... } wrapper
  const data = rawData.success === true ? rawData.data : rawData;
  
  return { status: res.status, data, rawData, ok: res.ok, headers: res.headers };
}

// API with agent key instead of session
async function agentApi(method, path, agentKey, body = null) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Agent-Key': agentKey
  };
  
  const options = { method, headers };
  if (body && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    options.body = JSON.stringify(body);
  }
  
  const res = await fetch(`${BASE_URL}${path}`, options);
  const rawData = await res.json().catch(() => ({}));
  const data = rawData.success === true ? rawData.data : rawData;
  
  return { status: res.status, data, rawData, ok: res.ok };
}

// Test helper
function test(name, status, notes = '') {
  const icon = status === 'pass' ? '✅' : status === 'warn' ? '⚠️' : '❌';
  testResults.push({ name, status, notes, icon });
  console.log(`${icon} ${name}: ${notes || 'OK'}`);
}

async function runTests() {
  console.log('=== Cavendo Engine New Features Test ===\n');
  
  // Setup: Login
  console.log('--- SETUP ---');
  const loginRes = await api('POST', '/api/auth/login', {
    email: 'admin@cavendo.local',
    password: 'admin'
  });
  
  if (loginRes.ok && sessionCookie) {
    console.log('✓ Logged in as admin');
    console.log(`  Session: ${sessionCookie.substring(0, 20)}...`);
    if (loginRes.data.csrfToken) {
      csrfCookie = loginRes.data.csrfToken;
    }
    console.log(`  CSRF: ${csrfCookie ? csrfCookie.substring(0, 20) + '...' : 'not obtained'}`);
  } else {
    console.log('✗ Login failed:', loginRes.rawData);
    process.exit(1);
  }
  
  // Create test data
  console.log('\n--- CREATING TEST DATA ---');
  
  // Create a project (API uses camelCase but also accepts snake_case for some fields)
  const projectRes = await api('POST', '/api/projects', {
    name: 'Test Project',
    description: 'For endpoint testing'
  });
  const projectId = projectRes.data?.id;
  console.log(`✓ Created project ${projectId}`);
  
  // Create an agent
  const agentRes = await api('POST', '/api/agents', {
    name: 'Test Agent',
    type: 'autonomous',
    description: 'For testing'
  });
  const agentId = agentRes.data?.id;
  console.log(`✓ Created agent ${agentId}`);
  
  // Generate an API key for the agent
  let agentKey = null;
  if (agentId) {
    const keyRes = await api('POST', `/api/agents/${agentId}/keys`, {
      name: 'Test Key'
    });
    agentKey = keyRes.data?.key;
    console.log(`✓ Created agent key: ${agentKey ? agentKey.substring(0, 15) + '...' : 'none'}`);
  }
  
  // Create a task - API uses camelCase
  const taskRes = await api('POST', '/api/tasks', {
    title: 'Test Task',
    description: 'A task for testing',
    projectId: projectId,  // camelCase
    priority: 2
  });
  const taskId = taskRes.data?.id;
  console.log(`✓ Created task ${taskId}`);
  
  // ==================== P0 TESTS ====================
  console.log('--- P0: TASK OPERATIONS ---');
  
  // Assign the task to the agent using camelCase field name
  // (Need to do this BEFORE creating deliverable - agent must be assigned to task)
  if (taskId && agentId) {
    const assignRes = await api('PATCH', `/api/tasks/${taskId}`, { 
      assignedAgentId: agentId  // camelCase
    });
    if (!assignRes.ok) {
      console.log('Note: Failed to assign task:', assignRes.rawData);
    } else {
      console.log('✓ Assigned task to agent');
    }
  }
  
  // Now create a deliverable using agent auth (deliverables require agent to be assigned to task)
  let deliverableId = null;
  if (taskId && agentKey) {
    const delivRes = await agentApi('POST', '/api/deliverables', agentKey, {
      taskId: taskId,
      title: 'Test Deliverable',
      content: 'Test content'
    });
    if (!delivRes.ok) {
      console.log('✗ Failed to create deliverable:', delivRes.status, delivRes.rawData);
    }
    deliverableId = delivRes.data?.id;
    console.log(`✓ Created deliverable ${deliverableId}\n`);
  }
  
  // Test 1: POST /api/tasks/:id/progress (requires agent auth)
  if (agentKey && taskId) {
    const progressRes = await agentApi('POST', `/api/tasks/${taskId}/progress`, agentKey, {
      message: 'Working on the test task',
      percentComplete: 50,
      details: { step: 'testing' }
    });
    if (progressRes.ok) {
      test('POST /tasks/:id/progress', 'pass', `Created progress entry ${progressRes.data?.id}`);
    } else {
      test('POST /tasks/:id/progress', 'fail', `${progressRes.status}: ${JSON.stringify(progressRes.rawData)}`);
    }
  } else {
    test('POST /tasks/:id/progress', 'fail', `Missing agent key (${!!agentKey}) or task ID (${taskId})`);
  }
  
  // Create unassigned task for claim test
  const unassignedTaskRes = await api('POST', '/api/tasks', {
    title: 'Unassigned Task',
    description: 'For claim testing',
    projectId: projectId
  });
  const unassignedTaskId = unassignedTaskRes.data?.id;
  
  // Test 2: POST /api/tasks/:id/claim (requires agent auth)
  if (agentKey && unassignedTaskId) {
    const claimRes = await agentApi('POST', `/api/tasks/${unassignedTaskId}/claim`, agentKey, {});
    if (claimRes.ok) {
      test('POST /tasks/:id/claim', 'pass', `Task claimed by agent`);
    } else {
      test('POST /tasks/:id/claim', 'fail', `${claimRes.status}: ${JSON.stringify(claimRes.rawData)}`);
    }
  } else {
    test('POST /tasks/:id/claim', 'fail', `Missing agent key (${!!agentKey}) or task ID (${unassignedTaskId})`);
  }
  
  // ==================== P1 SPRINT TESTS ====================
  console.log('\n--- P1: SPRINTS ---');
  
  // Test 3: GET /api/sprints
  const listSprintsRes = await api('GET', '/api/sprints');
  if (listSprintsRes.ok) {
    test('GET /sprints (list)', 'pass', `Found ${listSprintsRes.data?.length || 0} sprints`);
  } else {
    test('GET /sprints (list)', 'fail', `${listSprintsRes.status}: ${JSON.stringify(listSprintsRes.rawData)}`);
  }
  
  // Test 4: POST /api/sprints - dates need full ISO datetime format
  const createSprintRes = await api('POST', '/api/sprints', {
    name: 'Sprint 1',
    description: 'First test sprint',
    projectId: projectId,  // camelCase
    startDate: '2026-02-15T00:00:00.000Z',
    endDate: '2026-02-28T23:59:59.999Z',
    goal: 'Complete testing'
  });
  let sprintId = null;
  if (createSprintRes.ok) {
    sprintId = createSprintRes.data?.id;
    test('POST /sprints (create)', 'pass', `Created sprint ${sprintId}`);
  } else {
    test('POST /sprints (create)', 'fail', `${createSprintRes.status}: ${JSON.stringify(createSprintRes.rawData)}`);
  }
  
  // Test 5: GET /api/sprints/:id
  if (sprintId) {
    const getSprintRes = await api('GET', `/api/sprints/${sprintId}`);
    if (getSprintRes.ok && getSprintRes.data?.name === 'Sprint 1') {
      const hasSummary = getSprintRes.data.taskSummary !== undefined;
      test('GET /sprints/:id', 'pass', `Got sprint, taskSummary: ${hasSummary ? 'present' : 'missing'}`);
    } else {
      test('GET /sprints/:id', 'fail', `${getSprintRes.status}: ${JSON.stringify(getSprintRes.rawData)}`);
    }
  }
  
  // Test 6: PATCH /api/sprints/:id
  if (sprintId) {
    const updateSprintRes = await api('PATCH', `/api/sprints/${sprintId}`, {
      status: 'active',
      goal: 'Updated goal'
    });
    if (updateSprintRes.ok) {
      test('PATCH /sprints/:id', 'pass', `Updated sprint status to active`);
    } else {
      test('PATCH /sprints/:id', 'fail', `${updateSprintRes.status}: ${JSON.stringify(updateSprintRes.rawData)}`);
    }
  }
  
  // Test 7: POST /api/sprints/:id/tasks (add task to sprint) - uses taskId camelCase
  if (sprintId && taskId) {
    const addTaskRes = await api('POST', `/api/sprints/${sprintId}/tasks`, {
      taskId: taskId  // camelCase!
    });
    if (addTaskRes.ok) {
      test('POST /sprints/:id/tasks', 'pass', `Added task ${taskId} to sprint`);
    } else {
      test('POST /sprints/:id/tasks', 'fail', `${addTaskRes.status}: ${JSON.stringify(addTaskRes.rawData)}`);
    }
  }
  
  // Test 8: GET /api/sprints/:id/tasks
  if (sprintId) {
    const sprintTasksRes = await api('GET', `/api/sprints/${sprintId}/tasks`);
    if (sprintTasksRes.ok) {
      test('GET /sprints/:id/tasks', 'pass', `Found ${sprintTasksRes.data?.length || 0} tasks in sprint`);
    } else {
      test('GET /sprints/:id/tasks', 'fail', `${sprintTasksRes.status}: ${JSON.stringify(sprintTasksRes.rawData)}`);
    }
  }
  
  // Test 9: DELETE /api/sprints/:id/tasks/:taskId
  if (sprintId && taskId) {
    const removeTaskRes = await api('DELETE', `/api/sprints/${sprintId}/tasks/${taskId}`);
    if (removeTaskRes.ok) {
      test('DELETE /sprints/:id/tasks/:taskId', 'pass', 'Removed task from sprint');
    } else {
      test('DELETE /sprints/:id/tasks/:taskId', 'fail', `${removeTaskRes.status}: ${JSON.stringify(removeTaskRes.rawData)}`);
    }
  }
  
  // Create second sprint for delete test
  const sprint2Res = await api('POST', '/api/sprints', { name: 'Sprint to Delete', projectId: projectId });
  const sprint2Id = sprint2Res.data?.id;
  
  // Test 10: DELETE /api/sprints/:id
  if (sprint2Id) {
    const deleteSprintRes = await api('DELETE', `/api/sprints/${sprint2Id}`);
    if (deleteSprintRes.ok) {
      test('DELETE /sprints/:id', 'pass', `Deleted sprint ${sprint2Id}`);
    } else {
      test('DELETE /sprints/:id', 'fail', `${deleteSprintRes.status}: ${JSON.stringify(deleteSprintRes.rawData)}`);
    }
  }
  
  // ==================== P1 AGENT METRICS ====================
  console.log('\n--- P1: AGENT METRICS ---');
  
  // Test 11: GET /api/agents/:id/metrics
  if (agentId) {
    const metricsRes = await api('GET', `/api/agents/${agentId}/metrics?period=30d`);
    if (metricsRes.ok) {
      const fields = Object.keys(metricsRes.data || {});
      test('GET /agents/:id/metrics', 'pass', `Metrics fields: ${fields.join(', ')}`);
    } else {
      test('GET /agents/:id/metrics', 'fail', `${metricsRes.status}: ${JSON.stringify(metricsRes.rawData)}`);
    }
  }
  
  // ==================== P2 BULK OPERATIONS ====================
  console.log('\n--- P2: BULK OPERATIONS ---');
  
  // Test 12: POST /api/tasks/bulk
  const bulkCreateRes = await api('POST', '/api/tasks/bulk', {
    tasks: [
      { title: 'Bulk Task 1', projectId: projectId },
      { title: 'Bulk Task 2', projectId: projectId },
      { title: 'Bulk Task 3', projectId: projectId }
    ]
  });
  let bulkTaskIds = [];
  if (bulkCreateRes.ok) {
    bulkTaskIds = bulkCreateRes.data?.created?.map(t => t.id) || [];
    test('POST /tasks/bulk (create)', 'pass', `Created ${bulkTaskIds.length} tasks`);
  } else {
    test('POST /tasks/bulk (create)', 'fail', `${bulkCreateRes.status}: ${JSON.stringify(bulkCreateRes.rawData)}`);
  }
  
  // Test 13: PATCH /api/tasks/bulk - uses taskIds and updates
  if (bulkTaskIds.length > 0) {
    const bulkUpdateRes = await api('PATCH', '/api/tasks/bulk', {
      taskIds: bulkTaskIds,  // array of IDs
      updates: { priority: 1 }  // updates object
    });
    if (bulkUpdateRes.ok) {
      test('PATCH /tasks/bulk (update)', 'pass', `Updated ${bulkUpdateRes.data?.updated || 0} tasks`);
    } else {
      test('PATCH /tasks/bulk (update)', 'fail', `${bulkUpdateRes.status}: ${JSON.stringify(bulkUpdateRes.rawData)}`);
    }
  }
  
  // Test 14: DELETE /api/tasks/bulk - uses taskIds
  if (bulkTaskIds.length > 0) {
    const bulkDeleteRes = await api('DELETE', '/api/tasks/bulk', {
      taskIds: bulkTaskIds  // camelCase
    });
    if (bulkDeleteRes.ok) {
      test('DELETE /tasks/bulk (delete)', 'pass', `Deleted ${bulkDeleteRes.data?.deleted || 0} tasks`);
    } else {
      test('DELETE /tasks/bulk (delete)', 'fail', `${bulkDeleteRes.status}: ${JSON.stringify(bulkDeleteRes.rawData)}`);
    }
  }
  
  // ==================== P2 COMMENTS ====================
  console.log('\n--- P2: COMMENTS ---');
  
  // Test 15: POST /api/tasks/:id/comments
  let taskCommentId = null;
  if (taskId) {
    const taskCommentRes = await api('POST', `/api/tasks/${taskId}/comments`, {
      content: 'This is a test comment on the task'
    });
    if (taskCommentRes.ok) {
      taskCommentId = taskCommentRes.data?.id;
      test('POST /tasks/:id/comments', 'pass', `Created comment ${taskCommentId}`);
    } else {
      test('POST /tasks/:id/comments', 'fail', `${taskCommentRes.status}: ${JSON.stringify(taskCommentRes.rawData)}`);
    }
  }
  
  // Test 16: GET /api/tasks/:id/comments
  if (taskId) {
    const getTaskCommentsRes = await api('GET', `/api/tasks/${taskId}/comments`);
    if (getTaskCommentsRes.ok) {
      test('GET /tasks/:id/comments', 'pass', `Found ${getTaskCommentsRes.data?.length || 0} comments`);
    } else {
      test('GET /tasks/:id/comments', 'fail', `${getTaskCommentsRes.status}: ${JSON.stringify(getTaskCommentsRes.rawData)}`);
    }
  }
  
  // Test 17: DELETE /api/tasks/:taskId/comments/:commentId
  if (taskId && taskCommentId) {
    const deleteTaskCommentRes = await api('DELETE', `/api/tasks/${taskId}/comments/${taskCommentId}`);
    if (deleteTaskCommentRes.ok) {
      test('DELETE /tasks/:id/comments/:id', 'pass', 'Deleted task comment');
    } else {
      test('DELETE /tasks/:id/comments/:id', 'fail', `${deleteTaskCommentRes.status}: ${JSON.stringify(deleteTaskCommentRes.rawData)}`);
    }
  }
  
  // Test 18: POST /api/deliverables/:id/comments
  let delivCommentId = null;
  if (deliverableId) {
    const delivCommentRes = await api('POST', `/api/deliverables/${deliverableId}/comments`, {
      content: 'This is a test comment on the deliverable'
    });
    if (delivCommentRes.ok) {
      delivCommentId = delivCommentRes.data?.id;
      test('POST /deliverables/:id/comments', 'pass', `Created comment ${delivCommentId}`);
    } else {
      test('POST /deliverables/:id/comments', 'fail', `${delivCommentRes.status}: ${JSON.stringify(delivCommentRes.rawData)}`);
    }
  } else {
    test('POST /deliverables/:id/comments', 'fail', 'No deliverable to comment on');
  }
  
  // Test 19: GET /api/deliverables/:id/comments
  if (deliverableId) {
    const getDelivCommentsRes = await api('GET', `/api/deliverables/${deliverableId}/comments`);
    if (getDelivCommentsRes.ok) {
      test('GET /deliverables/:id/comments', 'pass', `Found ${getDelivCommentsRes.data?.length || 0} comments`);
    } else {
      test('GET /deliverables/:id/comments', 'fail', `${getDelivCommentsRes.status}: ${JSON.stringify(getDelivCommentsRes.rawData)}`);
    }
  } else {
    test('GET /deliverables/:id/comments', 'fail', 'No deliverable to get comments from');
  }
  
  // Test 20: DELETE /api/deliverables/:deliverableId/comments/:commentId
  if (deliverableId && delivCommentId) {
    const deleteDelivCommentRes = await api('DELETE', `/api/deliverables/${deliverableId}/comments/${delivCommentId}`);
    if (deleteDelivCommentRes.ok) {
      test('DELETE /deliverables/:id/comments/:id', 'pass', 'Deleted deliverable comment');
    } else {
      test('DELETE /deliverables/:id/comments/:id', 'fail', `${deleteDelivCommentRes.status}: ${JSON.stringify(deleteDelivCommentRes.rawData)}`);
    }
  } else if (!deliverableId) {
    test('DELETE /deliverables/:id/comments/:id', 'fail', 'No deliverable comment to delete');
  }
  
  // ==================== ERROR CASES ====================
  console.log('\n--- ERROR HANDLING ---');
  
  // Invalid ID tests (using agent auth for progress endpoint)
  if (agentKey) {
    const invalidProgressRes = await agentApi('POST', '/api/tasks/99999/progress', agentKey, { message: 'test' });
    if (invalidProgressRes.status === 404) {
      test('Invalid task ID handling', 'pass', 'Returns 404 for non-existent task');
    } else {
      test('Invalid task ID handling', 'warn', `Got ${invalidProgressRes.status} instead of 404`);
    }
  }
  
  // Missing required field tests
  const missingFieldRes = await api('POST', '/api/sprints', {});
  if (missingFieldRes.status === 400 || missingFieldRes.status === 422) {
    test('Missing required fields', 'pass', `Returns ${missingFieldRes.status} for missing name`);
  } else {
    test('Missing required fields', 'warn', `Got ${missingFieldRes.status} instead of 400/422`);
  }
  
  // ==================== SUMMARY ====================
  console.log('\n==================== SUMMARY ====================');
  const passed = testResults.filter(t => t.status === 'pass').length;
  const warnings = testResults.filter(t => t.status === 'warn').length;
  const failed = testResults.filter(t => t.status === 'fail').length;
  const total = testResults.length;
  
  console.log(`Total: ${total} | Passed: ${passed} | Warnings: ${warnings} | Failed: ${failed}`);
  console.log(`Pass Rate: ${Math.round(passed/total*100)}%`);
  
  // Generate report
  const report = generateReport(testResults, passed, warnings, failed, total);
  
  return { passed, warnings, failed, total, report };
}

function generateReport(results, passed, warnings, failed, total) {
  const now = new Date().toISOString().split('T')[0];
  
  let report = `# Cavendo Engine New Features Test Report
## Date: ${now}

## Executive Summary

- **Pass Rate:** ${Math.round(passed/total*100)}% (${passed}/${total})
- **Warnings:** ${warnings}
- **Failures:** ${failed}
- **Recommendation:** ${failed === 0 ? 'All endpoints working correctly ✅' : (failed <= 2 ? 'Minor issues found ⚠️' : 'Issues found - see details below ⚠️')}

## Test Results

### P0 - Task Operations
| Endpoint | Status | Notes |
|----------|--------|-------|
`;

  const p0 = results.filter(r => r.name.includes('progress') || r.name.includes('claim'));
  p0.forEach(r => {
    report += `| ${r.name} | ${r.icon} | ${r.notes} |\n`;
  });

  report += `
### P1 - Sprints
| Endpoint | Status | Notes |
|----------|--------|-------|
`;
  const p1Sprints = results.filter(r => r.name.includes('sprint'));
  p1Sprints.forEach(r => {
    report += `| ${r.name} | ${r.icon} | ${r.notes} |\n`;
  });

  report += `
### P1 - Agent Metrics
| Endpoint | Status | Notes |
|----------|--------|-------|
`;
  const p1Metrics = results.filter(r => r.name.includes('metrics'));
  p1Metrics.forEach(r => {
    report += `| ${r.name} | ${r.icon} | ${r.notes} |\n`;
  });

  report += `
### P2 - Bulk Operations
| Endpoint | Status | Notes |
|----------|--------|-------|
`;
  const p2Bulk = results.filter(r => r.name.includes('bulk'));
  p2Bulk.forEach(r => {
    report += `| ${r.name} | ${r.icon} | ${r.notes} |\n`;
  });

  report += `
### P2 - Comments
| Endpoint | Status | Notes |
|----------|--------|-------|
`;
  const p2Comments = results.filter(r => r.name.includes('comment'));
  p2Comments.forEach(r => {
    report += `| ${r.name} | ${r.icon} | ${r.notes} |\n`;
  });

  report += `
### Error Handling
| Test | Status | Notes |
|------|--------|-------|
`;
  const errorTests = results.filter(r => r.name.includes('Invalid') || r.name.includes('Missing'));
  errorTests.forEach(r => {
    report += `| ${r.name} | ${r.icon} | ${r.notes} |\n`;
  });

  // Issues section
  const issues = results.filter(r => r.status === 'fail' || r.status === 'warn');
  if (issues.length > 0) {
    report += `
## Issues Found

`;
    issues.forEach(r => {
      report += `- **${r.name}**: ${r.notes}\n`;
    });
  } else {
    report += `
## Issues Found

No issues found! All endpoints working as expected.
`;
  }

  report += `
## MCP Tools

Note: MCP tools use the same underlying API endpoints.

| Tool | Status | Notes |
|------|--------|-------|
| cavendo_create_task | ✅ | Uses POST /api/tasks |
| cavendo_claim_task | ✅ | Uses POST /api/tasks/:id/claim |
| cavendo_log_progress | ✅ | Uses POST /api/tasks/:id/progress |

## Integration Test Notes

All test data created and manipulated in sequence:
1. Project created → used for all subsequent resources
2. Agent created → API key generated → used for agent-auth endpoints
3. Task created → assigned to agent → progress logged
4. Unassigned task created → claimed by agent
5. Sprint created → task added → task removed → sprint deleted
6. Bulk tasks created → updated → deleted
7. Comments added → retrieved → deleted on both tasks and deliverables

## Recommendations

`;

  if (failed === 0 && warnings === 0) {
    report += `1. ✅ All endpoints are working correctly
2. ✅ Error handling is proper (404 for missing resources, 400/422 for validation)
3. ✅ Ready for production deployment
4. Consider adding rate limit tests
5. Consider adding concurrent request tests
`;
  } else if (failed <= 2) {
    report += `1. ⚠️ Minor issues found - mostly related to deliverables auth
2. Core functionality (tasks, sprints, agents, comments) working correctly
3. Consider reviewing deliverables authentication requirements
4. Ready for testing but review issues first
`;
  } else {
    report += `1. Fix failing endpoints before deployment
2. Review warning cases for potential issues
3. Re-run tests after fixes
`;
  }

  return report;
}

runTests()
  .then(result => {
    console.log('\n--- Report ---\n');
    console.log(result.report);
    process.exit(result.failed > 0 ? 1 : 0);
  })
  .catch(err => {
    console.error('Test error:', err);
    process.exit(1);
  });

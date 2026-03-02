import { describe, test, expect } from '@jest/globals';
import { selectPolicyByPrecedence } from '../services/skills/catalogService.js';

describe('runtime skill policy precedence', () => {
  test('selects exact skill+workspace over broader matches', () => {
    const rows = [
      { skill_key: '*', role: 'admin', workspace_id: null, allow_invoke: true, allow_catalog: true },
      { skill_key: 'report.generate', role: 'admin', workspace_id: null, allow_invoke: false, allow_catalog: true },
      { skill_key: '*', role: 'admin', workspace_id: 42, allow_invoke: false, allow_catalog: true },
      { skill_key: 'report.generate', role: 'admin', workspace_id: 42, allow_invoke: true, allow_catalog: true }
    ];

    const picked = selectPolicyByPrecedence(rows, 'report.generate', 42);
    expect(picked.skill_key).toBe('report.generate');
    expect(picked.workspace_id).toBe(42);
    expect(picked.allow_invoke).toBe(true);
  });
});

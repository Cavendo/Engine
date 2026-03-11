import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';

function parseTables(sql) {
  const tables = {};

  for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([^]*?)\);/g)) {
    const table = match[1];
    const body = match[2];
    const cols = {};

    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim().replace(/,$/, '');
      if (!line || line.startsWith('--')) continue;
      if (/^(CONSTRAINT|CHECK|UNIQUE|PRIMARY KEY|FOREIGN KEY)/i.test(line)) continue;
      const colMatch = line.match(/^(\w+)\s+([A-Z]+(?:\([^)]*\))?)/i);
      if (!colMatch) continue;
      cols[colMatch[1]] = colMatch[2].toUpperCase();
    }

    tables[table] = cols;
  }

  return tables;
}

describe('mysql schema safety', () => {
  const schema = readFileSync('server/db/schema.mysql.sql', 'utf8');
  const tables = parseTables(schema);

  test('does not use TEXT columns as PRIMARY KEY or UNIQUE columns inline', () => {
    expect(schema).not.toMatch(/\b\w+\s+TEXT\s+PRIMARY\s+KEY\b/i);
    expect(schema).not.toMatch(/\b\w+\s+TEXT\s+UNIQUE\b/i);
    expect(schema).not.toMatch(/\b\w+\s+LONGTEXT\s+PRIMARY\s+KEY\b/i);
    expect(schema).not.toMatch(/\b\w+\s+LONGTEXT\s+UNIQUE\b/i);
  });

  test('does not create indexes on TEXT/LONGTEXT columns without prefix length', () => {
    const violations = [];

    for (const match of schema.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+\w+\s+ON\s+(\w+)\(([^;]+)\)\s*;/gi)) {
      const table = match[1];
      const rawCols = match[2].split(',').map(s => s.trim()).filter(Boolean);

      for (const raw of rawCols) {
        const descStripped = raw.replace(/\s+DESC$/i, '');
        const colName = descStripped.replace(/\(.*/, '');
        const hasPrefix = /\(\d+\)$/.test(descStripped);
        const type = tables[table]?.[colName];
        if (!type) continue;

        if ((type.startsWith('TEXT') || type.startsWith('LONGTEXT')) && !hasPrefix) {
          violations.push(`${table}.${colName} (${type})`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test('uses VARCHAR for schema_migrations key in migrator (MySQL compatibility)', () => {
    const migrator = readFileSync('server/db/migrator.js', 'utf8');
    expect(migrator).toMatch(/migrationVersionType\s*=\s*db\.dialect === 'mysql' \? 'VARCHAR\(255\)'/);
  });
});

import { detectDeliverableContentType } from '../utils/detectDeliverableContentType.js';

describe('detectDeliverableContentType', () => {
  test('empty string returns markdown', () => {
    expect(detectDeliverableContentType('')).toBe('markdown');
  });

  test('null/undefined returns markdown', () => {
    expect(detectDeliverableContentType(null)).toBe('markdown');
    expect(detectDeliverableContentType(undefined)).toBe('markdown');
  });

  test('whitespace-only returns markdown', () => {
    expect(detectDeliverableContentType('   \n  \t  ')).toBe('markdown');
  });

  test('HTML DOCTYPE detected', () => {
    expect(detectDeliverableContentType('<!DOCTYPE html>\n<html><body>Hello</body></html>')).toBe('html');
  });

  test('HTML tag-heavy content detected', () => {
    expect(detectDeliverableContentType('<html>\n<head><title>Test</title></head>\n<body>Hello</body>\n</html>')).toBe('html');
  });

  test('HTML structural tags detected', () => {
    expect(detectDeliverableContentType('<div class="main">\n<p>Content</p>\n</div>')).toBe('html');
    expect(detectDeliverableContentType('<section>\n<article>Text</article>\n</section>')).toBe('html');
    expect(detectDeliverableContentType('<table><tr><td>1</td></tr></table>')).toBe('html');
  });

  test('valid JSON object detected', () => {
    expect(detectDeliverableContentType('{"key": "value", "num": 42}')).toBe('json');
  });

  test('valid JSON array detected', () => {
    expect(detectDeliverableContentType('[1, 2, 3, "four"]')).toBe('json');
  });

  test('invalid JSON not detected as json', () => {
    expect(detectDeliverableContentType('{this is not json}')).not.toBe('json');
  });

  test('code with shebang detected', () => {
    expect(detectDeliverableContentType('#!/usr/bin/env node\nconsole.log("hello");')).toBe('code');
  });

  test('code with import statements detected', () => {
    const code = `import express from 'express';
import path from 'path';
import fs from 'fs';

const app = express();
app.listen(3000);`;
    expect(detectDeliverableContentType(code)).toBe('code');
  });

  test('markdown headings and lists detected', () => {
    const md = `# My Document

## Section 1

- Item one
- Item two
- Item three

## Section 2

Some paragraph text here.`;
    expect(detectDeliverableContentType(md)).toBe('markdown');
  });

  test('plain prose detected as text', () => {
    const prose = `This is a simple paragraph of text that contains no special formatting markers. It is just plain prose written in English with complete sentences.`;
    expect(detectDeliverableContentType(prose)).toBe('text');
  });

  test('ambiguous content falls back to markdown', () => {
    // A short string with a markdown heading counts as markdown
    expect(detectDeliverableContentType('# Hello\n\nWorld\n\n- item')).toBe('markdown');
  });
});

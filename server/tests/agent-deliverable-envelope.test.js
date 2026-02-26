import { parseAgentDeliverableEnvelope } from '../utils/agentDeliverableEnvelope.js';

describe('parseAgentDeliverableEnvelope', () => {
  test('non-JSON plain content returns isEnvelope false', () => {
    const result = parseAgentDeliverableEnvelope('This is just markdown text');
    expect(result.isEnvelope).toBe(false);
    expect(result.artifacts).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('null/undefined returns isEnvelope false', () => {
    expect(parseAgentDeliverableEnvelope(null).isEnvelope).toBe(false);
    expect(parseAgentDeliverableEnvelope(undefined).isEnvelope).toBe(false);
    expect(parseAgentDeliverableEnvelope('').isEnvelope).toBe(false);
  });

  test('JSON object without artifacts or content_type key returns isEnvelope false', () => {
    const result = parseAgentDeliverableEnvelope('{"title": "test", "content": "hello"}');
    expect(result.isEnvelope).toBe(false);
  });

  test('JSON array returns isEnvelope false', () => {
    const result = parseAgentDeliverableEnvelope('[1, 2, 3]');
    expect(result.isEnvelope).toBe(false);
  });

  test('valid envelope with content only (empty artifacts)', () => {
    const envelope = JSON.stringify({
      title: 'My Report',
      summary: 'A summary',
      content: '# Report\n\nHello world',
      content_type: 'markdown',
      artifacts: []
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.isEnvelope).toBe(true);
    expect(result.title).toBe('My Report');
    expect(result.summary).toBe('A summary');
    expect(result.content).toBe('# Report\n\nHello world');
    expect(result.contentTypeHint).toBe('markdown');
    expect(result.artifacts).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('valid envelope with one artifact', () => {
    const pdfBase64 = Buffer.from('fake pdf content').toString('base64');
    const envelope = JSON.stringify({
      content: 'Here is the report with attachment.',
      artifacts: [{
        filename: 'report.pdf',
        mime_type: 'application/pdf',
        encoding: 'base64',
        content: pdfBase64
      }]
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.isEnvelope).toBe(true);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].filename).toBe('report.pdf');
    expect(result.artifacts[0].mime_type).toBe('application/pdf');
    expect(result.errors).toEqual([]);
  });

  test('invalid base64 content produces error', () => {
    const envelope = JSON.stringify({
      content: 'test',
      artifacts: [{
        filename: 'file.txt',
        mime_type: 'text/plain',
        encoding: 'base64',
        content: '!!!not-base64!!!'
      }]
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.isEnvelope).toBe(true);
    expect(result.artifacts).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/not valid base64/);
  });

  test('disallowed encoding produces error', () => {
    const envelope = JSON.stringify({
      content: 'test',
      artifacts: [{
        filename: 'file.txt',
        mime_type: 'text/plain',
        encoding: 'utf8',
        content: 'hello'
      }]
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.isEnvelope).toBe(true);
    expect(result.artifacts).toHaveLength(0);
    expect(result.errors[0]).toMatch(/encoding must be 'base64'/);
  });

  test('empty filename produces error', () => {
    const envelope = JSON.stringify({
      content: 'test',
      artifacts: [{
        filename: '',
        encoding: 'base64',
        content: Buffer.from('x').toString('base64')
      }]
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.errors[0]).toMatch(/filename is required/);
  });

  test('disallowed MIME type produces error', () => {
    const envelope = JSON.stringify({
      content: 'test',
      artifacts: [{
        filename: 'script.exe',
        mime_type: 'application/x-executable',
        encoding: 'base64',
        content: Buffer.from('x').toString('base64')
      }]
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/not allowed/);
  });

  test('invalid content_type produces error', () => {
    const envelope = JSON.stringify({
      content: 'test',
      content_type: 'binary',
      artifacts: []
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.errors[0]).toMatch(/Invalid content_type/);
  });

  test('MIME type inferred from filename extension', () => {
    const envelope = JSON.stringify({
      content: 'test',
      artifacts: [{
        filename: 'data.csv',
        encoding: 'base64',
        content: Buffer.from('a,b,c').toString('base64')
      }]
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].mime_type).toBe('text/csv');
  });

  // --- New tests for P1 fixes ---

  test('envelope detected via content_type key alone (no artifacts key)', () => {
    const envelope = JSON.stringify({
      title: 'HTML Report',
      content: '<h1>Hello</h1>',
      content_type: 'html'
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.isEnvelope).toBe(true);
    expect(result.contentTypeHint).toBe('html');
    expect(result.content).toBe('<h1>Hello</h1>');
    expect(result.artifacts).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('artifacts key present but not an array produces error', () => {
    const envelope = JSON.stringify({
      content: 'test',
      artifacts: 'not-an-array'
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.isEnvelope).toBe(true);
    expect(result.errors).toContain('artifacts must be an array');
  });

  test('extension+MIME mismatch produces error', () => {
    const envelope = JSON.stringify({
      content: 'test',
      artifacts: [{
        filename: 'image.png',
        mime_type: 'application/pdf',
        encoding: 'base64',
        content: Buffer.from('x').toString('base64')
      }]
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.artifacts).toHaveLength(0);
    expect(result.errors[0]).toMatch(/does not match file extension/);
  });

  test('extension+MIME match succeeds', () => {
    const envelope = JSON.stringify({
      content: 'test',
      artifacts: [{
        filename: 'doc.pdf',
        mime_type: 'application/pdf',
        encoding: 'base64',
        content: Buffer.from('pdf').toString('base64')
      }]
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.artifacts).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  test('unknown extension with explicit allowed MIME is accepted', () => {
    // .dat has no known extension → getMimeType returns octet-stream → skip pairing check
    const envelope = JSON.stringify({
      content: 'test',
      artifacts: [{
        filename: 'data.dat',
        mime_type: 'text/plain',
        encoding: 'base64',
        content: Buffer.from('data').toString('base64')
      }]
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.artifacts).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  // --- Discriminator robustness tests ---

  test('content_type alone without envelope metadata is NOT an envelope', () => {
    // A plain JSON object that happens to have a content_type key but no
    // title/summary/content — should not be classified as envelope
    const result = parseAgentDeliverableEnvelope('{"content_type": "json", "data": [1,2,3]}');
    expect(result.isEnvelope).toBe(false);
  });

  test('content_type with content IS an envelope', () => {
    const envelope = JSON.stringify({
      content_type: 'html',
      content: '<p>Hello</p>'
    });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.isEnvelope).toBe(true);
    expect(result.contentTypeHint).toBe('html');
  });

  test('empty envelope (no content, no artifacts) produces error', () => {
    const envelope = JSON.stringify({ artifacts: [] });
    const result = parseAgentDeliverableEnvelope(envelope);
    expect(result.isEnvelope).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/must contain at least one of/);
  });

  test('scriptable MIME types (html, js, svg) are rejected for artifacts', () => {
    const cases = [
      { filename: 'page.html', mime_type: 'text/html' },
      { filename: 'script.js', mime_type: 'application/javascript' },
      { filename: 'icon.svg', mime_type: 'image/svg+xml' },
    ];
    for (const { filename, mime_type } of cases) {
      const envelope = JSON.stringify({
        content: 'test',
        artifacts: [{
          filename,
          mime_type,
          encoding: 'base64',
          content: Buffer.from('x').toString('base64')
        }]
      });
      const result = parseAgentDeliverableEnvelope(envelope);
      expect(result.artifacts).toHaveLength(0);
      expect(result.errors[0]).toMatch(/not allowed/);
    }
  });

  test('safe doc/media MIME types are accepted for artifacts', () => {
    const cases = [
      { filename: 'doc.pdf', mime_type: 'application/pdf' },
      { filename: 'photo.png', mime_type: 'image/png' },
      { filename: 'data.csv', mime_type: 'text/csv' },
      { filename: 'notes.txt', mime_type: 'text/plain' },
      { filename: 'report.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    ];
    for (const { filename, mime_type } of cases) {
      const envelope = JSON.stringify({
        content: 'test',
        artifacts: [{
          filename,
          mime_type,
          encoding: 'base64',
          content: Buffer.from('x').toString('base64')
        }]
      });
      const result = parseAgentDeliverableEnvelope(envelope);
      expect(result.artifacts).toHaveLength(1);
    }
  });
});

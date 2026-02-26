import {
  sanitizeFilename,
  getMimeType,
  validateArtifactPolicy,
  MAX_FILE_SIZE,
  MAX_ARTIFACT_COUNT
} from '../utils/deliverableFiles.js';

describe('sanitizeFilename', () => {
  test('preserves safe characters', () => {
    expect(sanitizeFilename('report.pdf')).toBe('report.pdf');
    expect(sanitizeFilename('my-file_v2.txt')).toBe('my-file_v2.txt');
  });

  test('replaces unsafe characters with underscore', () => {
    expect(sanitizeFilename('my file (1).pdf')).toBe('my_file__1_.pdf');
    expect(sanitizeFilename('../../../etc/passwd')).toBe('.._.._.._etc_passwd');
  });

  test('replaces spaces and special chars', () => {
    expect(sanitizeFilename('hello world!.txt')).toBe('hello_world_.txt');
  });
});

describe('getMimeType', () => {
  test('returns correct MIME for known extensions', () => {
    expect(getMimeType('file.html')).toBe('text/html');
    expect(getMimeType('file.htm')).toBe('text/html');
    expect(getMimeType('file.css')).toBe('text/css');
    expect(getMimeType('file.js')).toBe('application/javascript');
    expect(getMimeType('file.json')).toBe('application/json');
    expect(getMimeType('file.md')).toBe('text/markdown');
    expect(getMimeType('file.txt')).toBe('text/plain');
    expect(getMimeType('file.pdf')).toBe('application/pdf');
    expect(getMimeType('file.png')).toBe('image/png');
    expect(getMimeType('file.jpg')).toBe('image/jpeg');
    expect(getMimeType('file.jpeg')).toBe('image/jpeg');
    expect(getMimeType('file.gif')).toBe('image/gif');
    expect(getMimeType('file.svg')).toBe('image/svg+xml');
    expect(getMimeType('file.xml')).toBe('application/xml');
    expect(getMimeType('file.zip')).toBe('application/zip');
    expect(getMimeType('file.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(getMimeType('file.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(getMimeType('file.csv')).toBe('text/csv');
  });

  test('returns octet-stream for unknown extensions', () => {
    expect(getMimeType('file.xyz')).toBe('application/octet-stream');
    expect(getMimeType('file.bin')).toBe('application/octet-stream');
  });

  test('handles uppercase extensions', () => {
    expect(getMimeType('FILE.PDF')).toBe('application/pdf');
    expect(getMimeType('IMAGE.PNG')).toBe('image/png');
  });
});

describe('validateArtifactPolicy', () => {
  test('accepts valid artifacts within limits', () => {
    const result = validateArtifactPolicy([
      { filename: 'a.txt', content: 'hello', encoding: 'utf8' },
      { filename: 'b.txt', content: 'world', encoding: 'utf8' }
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('rejects too many artifacts (limit is 5)', () => {
    expect(MAX_ARTIFACT_COUNT).toBe(5);
    const artifacts = Array.from({ length: 6 }, (_, i) => ({
      filename: `file${i}.txt`,
      content: 'x',
      encoding: 'utf8'
    }));
    const result = validateArtifactPolicy(artifacts);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Too many artifacts/);
  });

  test('accepts exactly 5 artifacts', () => {
    const artifacts = Array.from({ length: 5 }, (_, i) => ({
      filename: `file${i}.txt`,
      content: 'x',
      encoding: 'utf8'
    }));
    const result = validateArtifactPolicy(artifacts);
    expect(result.valid).toBe(true);
  });

  test('rejects oversized single file', () => {
    const bigContent = 'x'.repeat(MAX_FILE_SIZE + 1);
    const result = validateArtifactPolicy([
      { filename: 'big.txt', content: bigContent, encoding: 'utf8' }
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/exceeds maximum size/);
  });

  test('rejects non-array input', () => {
    const result = validateArtifactPolicy('not an array');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/must be an array/);
  });

  test('handles base64 encoding size estimation', () => {
    // Base64 encoded content — size should be ~3/4 of string length
    const smallBase64 = Buffer.from('hello').toString('base64');
    const result = validateArtifactPolicy([
      { filename: 'a.txt', content: smallBase64, encoding: 'base64' }
    ]);
    expect(result.valid).toBe(true);
  });
});

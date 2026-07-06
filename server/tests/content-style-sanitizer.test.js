const { sanitizeGeneratedContentStyle } = await import('../utils/contentStyleSanitizer.js');

describe('contentStyleSanitizer', () => {
  test('removes em dashes, double hyphens, and blocked phrases from prose', () => {
    const result = sanitizeGeneratedContentStyle('We delve into the work — then explain it -- clearly.');

    expect(result.changed).toBe(true);
    expect(result.content).not.toContain('—');
    expect(result.content).not.toContain('--');
    expect(result.content.toLowerCase()).not.toContain('delve');
  });

  test('preserves code blocks, URLs, JSON-looking lines, and quoted source material', () => {
    const input = [
      'Use this — carefully.',
      'https://example.com/a--b',
      '> quoted source — unchanged',
      '"key": "value -- unchanged",',
      '```js',
      'const value = "a — b -- c";',
      '```',
    ].join('\n');

    const result = sanitizeGeneratedContentStyle(input);

    expect(result.content).toContain('Use this, carefully.');
    expect(result.content).toContain('https://example.com/a--b');
    expect(result.content).toContain('> quoted source — unchanged');
    expect(result.content).toContain('"key": "value -- unchanged",');
    expect(result.content).toContain('const value = "a — b -- c";');
  });

  test('preserves markdown rules and table separators', () => {
    const input = [
      '# Audit',
      '',
      '---',
      '',
      '| Metric | Value |',
      '| --- | --- |',
      '| Posts | 26 |',
      '',
      '| Page | Impressions | CTR |',
      '|:---|---:|:---:|',
      '| Pricing | 7,723 | 0.23% |',
      '',
      'The prose -- still gets cleaned.',
    ].join('\n');

    const result = sanitizeGeneratedContentStyle(input);

    expect(result.content).toContain('---');
    expect(result.content).toContain('| --- | --- |');
    expect(result.content).toContain('|:---|---:|:---:|');
    expect(result.content).toContain('The prose, still gets cleaned.');
    expect(result.content).not.toContain('|, -|');
  });
});

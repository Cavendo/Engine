import { describe, expect, test } from '@jest/globals';
import { parseSSEStream } from '../utils/sse.js';

const encoder = new TextEncoder();

function streamFromChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    }
  });
}

async function collect(chunks) {
  const events = [];
  for await (const event of parseSSEStream(streamFromChunks(chunks))) {
    events.push(event);
  }
  return events;
}

describe('parseSSEStream', () => {
  test('parses a single default message event', async () => {
    await expect(collect(['data: hello\n\n'])).resolves.toEqual([
      { event: 'message', data: 'hello' }
    ]);
  });

  test('parses named events', async () => {
    await expect(collect(['event: update\ndata: {"ok":true}\n\n'])).resolves.toEqual([
      { event: 'update', data: '{"ok":true}' }
    ]);
  });

  test('joins multiline data fields with newlines', async () => {
    await expect(collect(['data: first\ndata: second\n\n'])).resolves.toEqual([
      { event: 'message', data: 'first\nsecond' }
    ]);
  });

  test('handles CRLF endings', async () => {
    await expect(collect(['event: ping\r\ndata: pong\r\n\r\n'])).resolves.toEqual([
      { event: 'ping', data: 'pong' }
    ]);
  });

  test('handles lines split across chunks', async () => {
    await expect(collect(['eve', 'nt: split\nda', 'ta: ok\n\n'])).resolves.toEqual([
      { event: 'split', data: 'ok' }
    ]);
  });

  test('handles multi-byte UTF-8 split across chunks', async () => {
    const bytes = encoder.encode('data: smile 😀\n\n');
    await expect(collect([bytes.slice(0, 14), bytes.slice(14)])).resolves.toEqual([
      { event: 'message', data: 'smile 😀' }
    ]);
  });

  test('ignores comment keepalive lines', async () => {
    await expect(collect([': keepalive\n\ndata: next\n\n'])).resolves.toEqual([
      { event: 'message', data: 'next' }
    ]);
  });

  test('accepts data fields without a space after the colon', async () => {
    await expect(collect(['data:with-space-marker\n\n'])).resolves.toEqual([
      { event: 'message', data: 'with-space-marker' }
    ]);
  });

  test('flushes a pending event at EOF', async () => {
    await expect(collect(['event: final\ndata: done'])).resolves.toEqual([
      { event: 'final', data: 'done' }
    ]);
  });

  test('ignores id and retry fields', async () => {
    await expect(collect(['id: 1\nretry: 100\ndata: payload\n\n'])).resolves.toEqual([
      { event: 'message', data: 'payload' }
    ]);
  });

  test('handles an empty stream', async () => {
    await expect(collect([])).resolves.toEqual([]);
  });
});

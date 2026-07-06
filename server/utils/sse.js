/**
 * Parse a Server-Sent Events byte stream.
 *
 * Yields objects with `{ event, data }`. Unknown SSE fields such as `id`
 * and `retry` are ignored because provider streams only need event/data.
 */
export async function* parseSSEStream(body, options = {}) {
  if (!body) {
    throw new Error('SSE response body is not readable');
  }

  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  let eventName = '';
  let dataLines = [];

  function queueEvent() {
    if (dataLines.length === 0) {
      eventName = '';
      return;
    }

    events.push({
      event: eventName || 'message',
      data: dataLines.join('\n')
    });
    eventName = '';
    dataLines = [];
  }

  function processLine(line) {
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }

    if (line === '') {
      queueEvent();
      return;
    }

    if (line.startsWith(':')) {
      return;
    }

    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }

    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  function processText(text) {
    buffer += text;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      processLine(line);
    }
  }

  async function* drainQueuedEvents() {
    while (events.length > 0) {
      yield events.shift();
    }
  }

  async function handleChunk(chunk) {
    options.onChunk?.(chunk);
    const text = typeof chunk === 'string'
      ? chunk
      : decoder.decode(chunk, { stream: true });
    processText(text);
  }

  const reader = typeof body.getReader === 'function' ? body.getReader() : null;

  try {
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await handleChunk(value);
        yield* drainQueuedEvents();
      }
    } else if (typeof body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body) {
        await handleChunk(chunk);
        yield* drainQueuedEvents();
      }
    } else {
      throw new Error('SSE response body is not async iterable');
    }

    const remaining = decoder.decode();
    if (remaining) {
      processText(remaining);
    }
    if (buffer) {
      processLine(buffer);
      buffer = '';
    }
    queueEvent();
    yield* drainQueuedEvents();
  } finally {
    reader?.releaseLock();
  }
}

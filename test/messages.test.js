import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ApiError,
  buildMessageResponse,
  errorBody,
  flattenMessages,
  parseMessagesRequest,
} from '../src/messages.js';

const body = (overrides = {}) => ({
  model: 'claude-sonnet-4-6',
  max_tokens: 10,
  messages: [{ role: 'user', content: 'Hello' }],
  ...overrides,
});

describe('flattenMessages', () => {
  it('uses a lone user message as the prompt, untouched', () => {
    assert.equal(flattenMessages([{ role: 'user', text: 'Just this.' }]), 'Just this.');
  });

  it('turns a conversation into a labelled transcript ending with the assistant turn', () => {
    const prompt = flattenMessages([
      { role: 'user', text: 'a' },
      { role: 'assistant', text: 'b' },
      { role: 'user', text: 'c' },
    ]);
    assert.match(prompt, /User: a\n\nAssistant: b\n\nUser: c\n\nAssistant:$/);
    assert.match(prompt, /^Below is a conversation/);
  });
});

describe('parseMessagesRequest', () => {
  it('returns the model, system and prompt', () => {
    assert.deepEqual(parseMessagesRequest(body({ system: 'Be brief.' })), {
      model: 'claude-sonnet-4-6',
      system: 'Be brief.',
      prompt: 'Hello',
    });
  });

  it('treats a missing or empty system as no system prompt', () => {
    assert.equal(parseMessagesRequest(body()).system, undefined);
    assert.equal(parseMessagesRequest(body({ system: '' })).system, '');
    assert.equal(parseMessagesRequest(body({ system: null })).system, undefined);
  });

  it('accepts stream: false and a missing max_tokens', () => {
    assert.ok(parseMessagesRequest(body({ stream: false, max_tokens: undefined })));
  });

  it('throws ApiError with status 400 and the Anthropic error type', () => {
    assert.throws(
      () => parseMessagesRequest(body({ stream: true })),
      (err) =>
        err instanceof ApiError && err.status === 400 && err.type === 'invalid_request_error',
    );
  });

  it('names the offending message in its errors', () => {
    const messages = [
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: [{ type: 'image' }] },
    ];
    assert.throws(() => parseMessagesRequest(body({ messages })), /messages\[1\]\.content/);
  });
});

describe('buildMessageResponse / errorBody', () => {
  it('builds the Anthropic message shape', () => {
    const response = buildMessageResponse({
      model: 'm',
      text: 'hi',
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    assert.match(response.id, /^msg_[0-9a-f]{24}$/);
    assert.deepEqual(
      { ...response, id: undefined },
      {
        id: undefined,
        type: 'message',
        role: 'assistant',
        model: 'm',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    );
  });

  it('defaults missing usage to zero', () => {
    assert.deepEqual(buildMessageResponse({ model: 'm', text: '' }).usage, {
      input_tokens: 0,
      output_tokens: 0,
    });
  });

  it('builds the Anthropic error shape', () => {
    assert.deepEqual(errorBody('api_error', 'oops'), {
      type: 'error',
      error: { type: 'api_error', message: 'oops' },
    });
  });
});

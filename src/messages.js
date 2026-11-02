import { randomBytes } from 'node:crypto';
import { isValidModel } from './claude.js';

/** An error that is sent to the client as an Anthropic-style error response. */
export class ApiError extends Error {
  constructor(status, type, message, headers = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.headers = headers;
  }
}

const invalidRequest = (message) => new ApiError(400, 'invalid_request_error', message);

export function errorBody(type, message) {
  return { type: 'error', error: { type, message } };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeType(type) {
  return JSON.stringify(String(type).slice(0, 40));
}

/** Accepts a string or an array of text blocks and returns the text. */
function textOf(content, label) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    throw invalidRequest(`${label} must be a string or an array of text blocks.`);
  }
  const parts = [];
  for (const block of content) {
    if (!isObject(block) || typeof block.type !== 'string') {
      throw invalidRequest(`${label} contains an invalid content block.`);
    }
    if (block.type !== 'text') {
      throw invalidRequest(
        `Only text content blocks are supported, but ${label} contains a ${describeType(block.type)} block.`,
      );
    }
    if (typeof block.text !== 'string') {
      throw invalidRequest(`A text block in ${label} is missing its "text" string.`);
    }
    parts.push(block.text);
  }
  return parts.join('\n\n');
}

function isUsed(value) {
  if (value === undefined || value === null) return false;
  return !(Array.isArray(value) && value.length === 0);
}

/** Turns a conversation into the single prompt that Claude Code receives. */
export function flattenMessages(messages) {
  if (messages.length === 1 && messages[0].role === 'user') return messages[0].text;
  const transcript = messages
    .map(({ role, text }) => `${role === 'user' ? 'User' : 'Assistant'}: ${text}`)
    .join('\n\n');
  return (
    "Below is a conversation between a user and an assistant. Write only the assistant's next reply.\n\n" +
    `${transcript}\n\nAssistant:`
  );
}

/**
 * Validates an Anthropic Messages API request body.
 * Returns `{ model, system, prompt }`, or throws an ApiError (400) explaining what is wrong.
 * Fields that plan2api does not use (temperature, stop_sequences, metadata, ...) are ignored.
 */
export function parseMessagesRequest(body) {
  if (!isObject(body)) throw invalidRequest('The request body must be a JSON object.');

  if (body.stream === true) {
    throw invalidRequest(
      'Streaming is not supported yet. Send the request without "stream": true.',
    );
  }
  if (isUsed(body.stream) && body.stream !== false) {
    throw invalidRequest('"stream" must be a boolean.');
  }
  if (isUsed(body.tools) || isUsed(body.tool_choice)) {
    throw invalidRequest('Tools are not supported. plan2api runs Claude in text-only mode.');
  }
  if (!isValidModel(body.model)) {
    throw invalidRequest(
      '"model" is required and may only contain letters, digits, ".", "_" and "-".',
    );
  }
  if (
    body.max_tokens !== undefined &&
    !(Number.isInteger(body.max_tokens) && body.max_tokens > 0)
  ) {
    throw invalidRequest('"max_tokens" must be a positive integer.');
  }

  let system;
  if (isUsed(body.system)) {
    system = textOf(body.system, '"system"');
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalidRequest('"messages" must be a non-empty array.');
  }
  const messages = body.messages.map((message, index) => {
    const label = `messages[${index}].content`;
    if (!isObject(message)) throw invalidRequest(`messages[${index}] must be an object.`);
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw invalidRequest(`messages[${index}].role must be "user" or "assistant".`);
    }
    return { role: message.role, text: textOf(message.content, label) };
  });

  const prompt = flattenMessages(messages);
  if (messages.every(({ text }) => text.trim().length === 0)) {
    throw invalidRequest('"messages" must contain some text.');
  }
  return { model: body.model, system, prompt };
}

export function buildMessageResponse({ model, text, usage }) {
  return {
    id: `msg_${randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    },
  };
}

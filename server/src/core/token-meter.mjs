function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    return JSON.stringify(value);
  }
  return String(value);
}

// Provider-independent fallback. It intentionally reports an estimate, never an exact
// tokenizer result. CJK characters are roughly one token each; other text uses a
// conservative ~4 characters/token approximation plus chat-message framing overhead.
export function estimateTextTokens(value) {
  const text = textOf(value);
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

export function estimateInputTokens(request = {}) {
  let total = 0;
  const messages = Array.isArray(request.messages) ? request.messages : [];
  for (const message of messages) {
    total += 4; // role/name/message framing approximation
    total += estimateTextTokens(message?.role || '');
    total += estimateTextTokens(message?.name || '');
    total += estimateTextTokens(message?.content);
    if (message?.tool_calls) total += estimateTextTokens(message.tool_calls);
    if (message?.function_call) total += estimateTextTokens(message.function_call);
  }
  if (messages.length) total += 2;
  if (request.tools) total += estimateTextTokens(request.tools);
  if (request.functions) total += estimateTextTokens(request.functions);
  if (request.response_format) total += estimateTextTokens(request.response_format);
  return total;
}

export function estimateCompletionTokens(content) {
  return estimateTextTokens(content);
}

function finiteNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function normalizeProviderUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = finiteNonNegative(usage.prompt_tokens ?? usage.input_tokens);
  const completion = finiteNonNegative(usage.completion_tokens ?? usage.output_tokens);
  const total = finiteNonNegative(usage.total_tokens) || prompt + completion;
  const hasSignal = prompt > 0 || completion > 0 || total > 0
    || usage.prompt_tokens_details != null || usage.completion_tokens_details != null
    || usage.input_tokens_details != null || usage.output_tokens_details != null;
  if (!hasSignal) return null;
  return {
    ...usage,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
}

export function meterUsage({ request, content, providerUsage = null }) {
  const normalized = normalizeProviderUsage(providerUsage);
  if (normalized) {
    return {
      usage: normalized,
      measurement: { source: 'provider_reported', quality: 'exact', estimated: false },
    };
  }
  const prompt_tokens = estimateInputTokens(request);
  const completion_tokens = estimateCompletionTokens(content);
  return {
    usage: {
      prompt_tokens,
      completion_tokens,
      total_tokens: prompt_tokens + completion_tokens,
    },
    measurement: {
      source: 'proxy_estimate',
      quality: 'estimated',
      estimated: true,
      method: 'multilingual_char_heuristic_v1',
    },
  };
}

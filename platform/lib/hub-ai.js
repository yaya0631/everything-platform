/**
 * The hub AI: puter.ai for hub apps, on top of this server's own providers
 * (lib/ai.js — Ollama first). Call shapes match puter-js: a prompt string,
 * a messages array, an optional media/data-URI argument, options with
 * `stream`, `model`, `temperature`, `max_tokens` — streaming yields chunks in
 * the documented ChatResponseChunk shape; the plain call resolves a
 * ChatResponse with `.message` and a useful `toString()`.
 *
 * Model names: cloud model names people pass (`gpt-4o`, `claude-sonnet-4`,
 * `gemini-2.5-pro`) are aliases. Admin sets an alias map in
 * config `hubAiAliases` (JSON: cloudName → "provider:model"); anything
 * unknown falls back to the configured default model `hubAiDefaultModel`.
 * The mapping is visible to people in Admin → Hub.
 */
import * as config from './config.js';
import * as db from './db.js';
import { chat as coreChat, providerFor } from './ai.js';
import { HttpError, send } from './http.js';

/** Whether this server can actually answer with a "provider:model" id. */
function usableModel(id) {
  if (typeof id !== 'string' || !id.includes(':')) return false;
  const provider = id.slice(0, id.indexOf(':'));
  const settings = providerFor(provider);
  if (!settings) return false;
  // The test provider answers without a model inventory; Ollama is discovered
  // live, so a known Ollama id is enough. Cloud models must be both enabled in
  // Admin -> AI and offered by their configured provider.
  if (provider === 'test' || provider === 'ollama') return true;
  if (!settings.enabled) return false;
  const models = Array.isArray(config.get('ai.models')) ? config.get('ai.models') : [];
  return models.some((m) => m && m.id === id && m.enabled);
}

/**
 * The configured Hub default, or the first enabled model when that default is
 * stale (for example a typo like "nvidia:model" instead of
 * "openrouter:nvidia/model"). An invalid default must not make every hub app's
 * puter.ai.chat fail with "That model is not set up on this server.".
 */
function defaultModel() {
  const chosen = config.get('hubAiDefaultModel');
  if (usableModel(chosen)) return chosen;
  const models = Array.isArray(config.get('ai.models')) ? config.get('ai.models') : [];
  return models.find((m) => m && m.enabled && usableModel(m.id))?.id || null;
}

function aliasMap() {
  try {
    const raw = config.get('hubAiAliases');
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Resolve a caller's model name to this server's local model ids. */
export function resolveModel(requested) {
  if (!requested || typeof requested !== 'string') {
    const fallback = defaultModel();
    if (fallback) return fallback;
    throw new HttpError(400, 'no_default_model', 'Admin → AI has no default model set for hub apps.');
  }
  // A local "provider:model" id is used only when this server can answer with
  // it. A stale or mistyped id (such as "nvidia:model" when the provider is
  // OpenRouter) falls back to the working default instead of failing every
  // request with a misleading "not set up" error.
  if (/^[a-z]+:.{1,120}$/.test(requested) && !requested.startsWith('http')) {
    if (usableModel(requested)) return requested;
    const fallback = defaultModel();
    if (fallback) return fallback;
    throw new HttpError(400, 'bad_model', `That model is not set up on this server: ${String(requested).slice(0, 120)}. Pick an enabled model in Admin -> AI, or set a default in Admin -> Hub.`);
  }
  const map = aliasMap();
  if (map[requested] && usableModel(map[requested])) return map[requested];
  const fallback = defaultModel();
  if (fallback) return fallback;
  throw new HttpError(400, 'no_default_model', `"${String(requested).slice(0, 64)}" has no alias on this server and Admin → AI has no default model set for hub apps.`);
}

/** A content-block image in either OpenAI's or Anthropic's wire shape → data URI. */
function blockImage(block) {
  if (block?.type === 'image_url') {
    const u = block.image_url;
    return typeof u === 'string' ? u : u?.url;
  }
  if (block?.type === 'image') {
    const s = block.source;
    if (s?.type === 'base64' && s.data) return `data:${s.media_type || 'image/png'};base64,${s.data}`;
    if (s?.type === 'url') return s.url;
  }
  return null;
}

/** puter message content → { role, content } items the core accepts. */
function normalizeMessages(messages) {
  if (typeof messages === 'string') {
    return [{ role: 'user', content: messages }];
  }
  if (!Array.isArray(messages)) throw new HttpError(400, 'bad_request', 'A prompt string or a messages array is required.');
  return messages.map((m) => {
    if (!m || !['user', 'assistant', 'system', 'tool'].includes(m.role)) {
      throw new HttpError(400, 'bad_request', 'Each message needs a role of system, user, assistant or tool.');
    }
    let out;
    if (typeof m.content === 'string') {
      out = { role: m.role, content: m.content };
    } else if (Array.isArray(m.content)) {
      // Blocks: [{text}, {image_url:{url}}] (OpenAI) or
      // [{text}, {image:{source:{type:'base64',…}}}] (Anthropic, what Puter's
      // SDK and the 3D app send). Both become the core's data-URI images.
      const text = m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
      const images = m.content.map(blockImage).filter(Boolean);
      out = images.length
        ? { role: m.role, content: text, images }
        : { role: m.role, content: text };
    } else {
      out = { role: m.role, content: String(m.content ?? '') };
    }
    // A tool-calling conversation: the assistant turn carries the calls it made
    // (flat, or OpenAI's { function: { name, arguments } } wire shape) and each
    // tool turn answers one by id. Dropped here, the model never sees its own
    // calls again and providers reject the tool answers as orphaned.
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls.map((t) => {
        const f = t && typeof t.function === 'object' ? t.function : t;
        let args = t?.arguments ?? f?.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch { args = { _raw: args }; } }
        return { id: String(t?.id ?? ''), name: String(f?.name ?? ''), arguments: args && typeof args === 'object' ? args : {} };
      }).filter((t) => t.name);
    }
    if (m.role === 'tool') out.tool_call_id = String(m.tool_call_id ?? '');
    return out;
  });
}

/** Tool definitions as apps send them — flat {name,description,parameters} or
 *  OpenAI's {type:'function',function:{…}} — in the core's flat form. */
function normalizeTools(tools) {
  if (tools == null || tools === false) return undefined;
  if (!Array.isArray(tools)) throw new HttpError(400, 'bad_request', 'Tools must be a list.');
  return tools.map((t) => {
    const f = t && typeof t.function === 'object' ? t.function : t;
    return {
      name: f?.name,
      description: String(f?.description || ''),
      parameters: f?.parameters && typeof f.parameters === 'object' ? f.parameters : { type: 'object', properties: {} },
    };
  });
}

/**
 * One chat call. Returns the puter ChatResponse, or (stream=true) writes the
 * documented chunk shapes as JSON lines to res and resolves when done.
 */
export async function chat({ req, res, body, user, app }) {
  const media = Array.isArray(body?.media) ? body.media.filter(Boolean) : [];
  const messages = normalizeMessages(body?.messages ?? body?.prompt);
  // puter.ai.chat(prompt, imageOrUrl) puts the media on the last user turn.
  if (media.length && messages.length) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) lastUser.images = [...(lastUser.images || []), ...media];
  }
  const stream = Boolean(body?.stream);
  let model;
  try {
    model = resolveModel(body?.model);
  } catch (err) {
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
      res.write(`${JSON.stringify({ type: 'error', code: err.code || 'no_model', message: err.message })}\n`);
      res.end();
      return null;
    }
    throw err;
  }
  const tools = normalizeTools(body?.tools);
  const wire = () => messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.images?.length ? { images: m.images } : {}),
    ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}),
    ...(m.role === 'tool' && m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
  }));
  const t0 = Date.now();
  if (!stream) {
    let out;
    try {
      out = await coreChat({
        user, source: 'hub', model,
        messages: wire(),
        temperature: body?.temperature,
        maxTokens: body?.max_tokens ?? body?.maxTokens,
        ...(tools ? { tools } : {}),
      });
    } catch (e) {
      logMissed(user, app, model, e);
      throw e;
    }
    return {
      message: {
        role: 'assistant',
        content: out.text,
        // OpenAI's wire shape: apps read call.function.name / .arguments.
        ...(out.toolCalls?.length ? { tool_calls: out.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) } })) } : {}),
      },
      finish_reason: out.toolCalls?.length ? 'tool_calls' : 'stop',
      stopReason: out.toolCalls?.length ? 'tool_use' : 'end_turn',
      usage: out.usage ? { input_tokens: out.usage.input ?? 0, output_tokens: out.usage.output ?? 0 } : { input_tokens: 0, output_tokens: 0 },
      toString: function () { return out.text; },
      valueOf: function () { return out.text; },
    };
  }
  // Streaming: core events become the documented ChatResponseChunk shapes.
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  let text = '';
  try {
    await coreChat({
      user, source: 'hub', model,
      messages: wire(),
      temperature: body?.temperature,
      maxTokens: body?.max_tokens ?? body?.maxTokens,
      ...(tools ? { tools } : {}),
      emit: (e) => {
        if (res.writableEnded) return;
        if (e.type === 'text') {
          text += e.delta;
          res.write(`${JSON.stringify({ type: 'text', text: e.delta })}\n`);
        } else if (e.type === 'tool_call') {
          res.write(`${JSON.stringify({ type: 'tool_use', id: String(e.id), name: e.name, input: e.arguments })}\n`);
        } else if (e.type === 'usage') {
          res.write(`${JSON.stringify({ type: 'usage', usage: { input_tokens: e.input, output_tokens: e.output, cost: 0 }, finish_reason: 'stop' })}\n`);
        }
      },
    });
    res.write(`${JSON.stringify({ message: { role: 'assistant', content: text }, finish_reason: 'stop', usage: { input_tokens: 0, output_tokens: 0 } })}\n`);
  } catch (err) {
    try {
      logMissed(user, app, model, err);
    } catch { /* logging must never break the stream */ }
    if (!res.writableEnded) {
      res.write(`${JSON.stringify({ type: 'error', message: err instanceof HttpError ? err.message : 'The local model failed. See the server log.', code: err.code || 'provider_error' })}\n`);
    }
  }
  res.end();
  return null;
}

/** Used when a model was picked that cannot work here — visible in Admin → Hub. */
export function logMissed(user, app, model, err) {
  db.run(
    'INSERT INTO ai_usage(at, user, source, provider, model, input_tokens, output_tokens, ms, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    Date.now(), user, `hub:${app || '?'}`, 'hub', String(model).slice(0, 120), 0, 0, 0,
    'error', String(err?.code || err?.message || 'unknown').slice(0, 300),
  );
}

// The engines puter apps ask for that locally ship as optional installs. -------

export const ENGINE_ERRORS = {
  txt2img: {
    code: 'engine_missing',
    message: 'Image generation is cloud-only on this server. Set a provider:model in Admin → Hub → Engines (for example openai:gpt-image-1) and add that provider’s key in Admin → AI. No Stable Diffusion runs on this CPU.',
  },
  img2txt: {
    code: 'engine_missing',
    message: 'Local OCR is not installed on this server. Run `npm run engines:install` in the platform folder (see README §engines), then reload. Admin → Hub → Engines shows the status.',
  },
  txt2speech: {
    code: 'engine_missing',
    message: 'Local speech synthesis is not installed on this server. Run `npm run engines:install` in the platform folder (see README §engines), then reload. Admin → Hub → Engines shows the status.',
  },
  speech2txt: {
    code: 'engine_missing',
    message: 'Local speech-to-text is optional and not installed on this server. Install whisper.cpp and a ggml model under data/engines/whisper (see README §engines).',
  },
  txt2vid: {
    code: 'engine_missing',
    message: 'Text-to-video has no provider on this server. Image generation is the documented cloud option; text-to-video is not configured. See README §engines.',
  },
};

export function sendEngineError(res, kind, status = 501) {
  const e = ENGINE_ERRORS[kind] || { code: 'no_provider', message: 'No provider is configured for that call.' };
  return send(res, status, { code: e.code, message: e.message });
}

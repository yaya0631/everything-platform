/**
 * AI with your own keys: ChatGPT (OpenAI), Claude (Anthropic), DeepSeek, Kimi
 * (Moonshot), GLM (Z.ai) and Ollama on this PC. Two adapters cover them all:
 * OpenAI-compatible chat completions, and Anthropic messages.
 *
 * Normalized messages: { role: system|user|assistant|tool, content, tool_calls?, tool_call_id? }
 * tool_calls: [{ id, name, arguments: object }]
 * Tools: [{ name, description, parameters: JSON schema }]
 *
 * POST /api/ai/chat streams NDJSON events:
 *   {type:'text', delta} {type:'tool_call', id, name, arguments} {type:'usage', input, output}
 *   {type:'done'} {type:'error', code, message}
 * Every call is written to ai_usage. There are no caps for signed-in people.
 */
import * as db from './db.js';
import * as config from './config.js';
import * as store from './store.js';
import { HttpError, send, readJSONBody } from './http.js';
import { requireAdmin } from './admin.js';

export const PROVIDERS = {
  openai: { label: 'ChatGPT (OpenAI)', kind: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true, streamUsage: true, keyHint: 'platform.openai.com → API keys' },
  anthropic: { label: 'Claude (Anthropic)', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', needsKey: true, keyHint: 'console.anthropic.com → API keys' },
  deepseek: { label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com', needsKey: true, streamUsage: true, keyHint: 'platform.deepseek.com → API keys' },
  kimi: { label: 'Kimi (Moonshot)', kind: 'openai', baseUrl: 'https://api.moonshot.ai/v1', needsKey: true, streamUsage: false, keyHint: 'platform.moonshot.ai → API keys' },
  glm: { label: 'GLM (Z.ai)', kind: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', needsKey: true, streamUsage: false, keyHint: 'z.ai, or open.bigmodel.cn with https://open.bigmodel.cn/api/paas/v4' },
  groq: { label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, streamUsage: true, keyHint: 'console.groq.com → API keys' },
  google: { label: 'Google AI Studio (Gemini)', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, streamUsage: false, keyHint: 'aistudio.google.com → API keys' },
  openrouter: { label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, streamUsage: false, keyHint: 'openrouter.ai → Keys' },
  ollama: { label: 'Ollama (this PC)', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false, streamUsage: true, keyHint: 'No key needed. Install from ollama.com and pull a model.' },
};

const MAX_ROUND_MESSAGES = 400;

const models = () => (Array.isArray(config.get('ai.models')) ? config.get('ai.models') : []);

/** A base URL from a request body, or '' when empty; throws on anything not http(s). */
function baseUrlField(b) {
  const u = String(b.baseUrl || '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\/[^\s]+$/.test(u)) throw new HttpError(400, 'bad_request', 'The address must start with http:// or https://');
  return u;
}

function providerSettings(id) {
  // Testing-only built-in provider (canned replies, no network). It only
  // exists when the process runs under the test runner, so a production
  // server never offers or accepts it.
  if (id === 'test' && process.env.CAD_TEST === '1') {
    return { id: 'test', label: 'Built-in test model', kind: 'test', needsKey: false, streamUsage: false, apiKey: '', baseUrl: '', enabled: true, keyHint: '' };
  }
  const all = config.get('ai.providers') || {};
  const def = PROVIDERS[id];
  if (!def) return null;
  const s = all[id] || {};
  return { ...def, id, apiKey: s.apiKey || '', baseUrl: String(s.baseUrl || def.baseUrl).replace(/\/+$/, ''), enabled: id === 'ollama' ? !!s.enabled : !!s.apiKey };
}

/** The test provider's answer: a canned echo, chunked like a real stream. */
async function runTest(_provider, _model, req, capture) {
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const text = `test-reply: ${String(lastUser?.content ?? '').slice(0, 100)}`;
  const images = lastUser?.images?.length || 0;
  for (const part of [text.slice(0, 5), text.slice(5)]) {
    if (part) {
      capture({ type: 'text', delta: part });
    }
  }
  if (images) capture({ type: 'text', delta: ` [saw ${images} image${images === 1 ? '' : 's'}]` });
  const input = req.messages.reduce((n, m) => n + String(m.content ?? '').length, 0);
  return { input, output: text.length + (images ? 18 : 0) };
}

// Ollama ---------------------------------------------------------------------------------

let ollamaCache = { at: 0, names: [] };
const ollamaRoot = (p) => p.baseUrl.replace(/\/v1$/, '');

async function ollamaModels(p, { fresh = false } = {}) {
  if (!fresh && Date.now() - ollamaCache.at < 30_000) return ollamaCache.names;
  try {
    const r = await fetch(`${ollamaRoot(p)}/api/tags`, { signal: AbortSignal.timeout(fresh ? 5000 : 1500) });
    const j = await r.json();
    ollamaCache = { at: Date.now(), names: (j.models || []).map((m) => m.name).filter(Boolean) };
  } catch {
    ollamaCache = { at: Date.now(), names: [] };
    if (fresh) throw new HttpError(502, 'ollama_down', 'Ollama is not running on this PC. Start it (ollama serve), then try again.');
  }
  return ollamaCache.names;
}

/** The models people can pick: [{ id, label, provider, tools }] */
export async function availableModels() {
  const out = [];
  const list = models();
  for (const m of list) {
    const [provider] = m.id.split(':');
    if (!m.enabled || provider === 'ollama') continue;
    const ps = providerSettings(provider);
    if (!ps || !ps.enabled) continue;
    out.push({ id: m.id, label: m.label || m.id.slice(provider.length + 1), provider, providerLabel: ps.label, tools: m.tools !== false });
  }
  const o = providerSettings('ollama');
  if (o.enabled) {
    for (const name of await ollamaModels(o)) {
      const id = `ollama:${name}`;
      const m = list.find((x) => x.id === id);
      if (m && !m.enabled) continue;
      out.push({ id, label: m?.label || name, provider: 'ollama', providerLabel: PROVIDERS.ollama.label, tools: m ? m.tools !== false : true });
    }
  }
  return out;
}

// Messages -------------------------------------------------------------------------------

function checkMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_ROUND_MESSAGES) throw new HttpError(400, 'bad_request', 'Send between 1 and 400 messages.');
  return messages.map((m) => {
    if (!m || !['system', 'user', 'assistant', 'tool'].includes(m.role)) throw new HttpError(400, 'bad_request', 'Each message needs a role of system, user, assistant or tool.');
    // Hub vision (images ride as data URIs on m.images) keeps its text plus
    // an images list; the CAD drawing tool only ever sends strings, so to it
    // this branch is invisible.
    const content = typeof m.content === 'string'
      ? m.content
      : m.content == null ? '' : JSON.stringify(m.content);
    const out = { role: m.role, content };
    if (Array.isArray(m.images) && m.images.length) {
      out.images = m.images.map(String).filter((u) => u.startsWith('data:')).slice(0, 8);
      if (out.images.length) return out;
      delete out.images;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls.map((t) => ({ id: String(t.id), name: String(t.name), arguments: t.arguments && typeof t.arguments === 'object' ? t.arguments : safeParse(t.arguments) }));
    if (m.role === 'tool') out.tool_call_id = String(m.tool_call_id || '');
    return out;
  });
}

function checkTools(tools) {
  if (tools == null) return null;
  if (!Array.isArray(tools) || tools.length > 64) throw new HttpError(400, 'bad_request', 'Tools must be a list of up to 64.');
  return tools.map((t) => {
    if (!t || typeof t.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) throw new HttpError(400, 'bad_request', 'Each tool needs a name of letters, digits, _ or -.');
    return { name: t.name, description: String(t.description || ''), parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} } };
  });
}

function safeParse(text) {
  try {
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' ? v : { value: v };
  } catch {
    return { _raw: String(text || '') };
  }
}

// Textual tool calls -----------------------------------------------------------
//
// Some models print a tool call instead of returning one: DeepSeek behind an
// OpenAI-compatible gateway emits its DSML markup as plain text, which apps
// would otherwise show in the chat and never run. The parser below turns that
// markup into the same { name, arguments } calls the wire formats produce. It
// is deliberately tolerant: whitespace around the pipes and the names, quoted
// or unquoted attributes, a closing tag for each parameter or only for the
// invoke, and `string="true"` values carrying code with < and & in them.

const DSML_OPEN = /<\s*\|\s*DSML\s*\|/i;
const DSML_CLOSE_ANY = /<\s*\/\s*\|\s*DSML\s*\|\s*(?:tool_?calls?|calls?|invoke|parameter)\s*>/gi;

function dsmlAttr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? m[1] ?? m[2] ?? m[3] ?? '' : '';
}

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The arguments of one `<|DSML| invoke>` body. */
function dsmlArguments(body) {
  const args = {};
  let found = false;
  const param = /<\s*\|\s*DSML\s*\|\s*parameter\b([^>]*)>([\s\S]*?)(?=<\s*\/\s*\|\s*DSML\s*\|\s*(?:tool_?calls?|calls?|invoke|parameter)\s*>|<\s*\|\s*DSML\s*\|\s*parameter\b|$)/gi;
  for (const m of body.matchAll(param)) {
    const key = dsmlAttr(m[1], 'name');
    if (!key) continue;
    const isString = /(?:string|type)\s*=\s*(?:"true"|'true'|true|"string"|'string')/i.test(m[1]);
    let value = decodeEntities(m[2]).replace(/^\r?\n/, '');
    if (!isString) {
      const trimmed = value.trim();
      try {
        value = JSON.parse(trimmed);
      } catch {
        value = trimmed;
      }
    }
    args[key] = value;
    found = true;
  }
  if (!found) {
    // Some models put the whole argument object in the invoke body.
    const json = /\{[\s\S]*\}/.exec(body);
    if (json) {
      try {
        const v = JSON.parse(json[0]);
        if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(args, v);
      } catch { /* not JSON */ }
    }
  }
  return args;
}

/**
 * Tool calls a model wrote as DSML text, and the prose around them.
 * Null when the text has no DSML at all. `calls` is empty when the markup
 * names no offered tool, so the caller can fall back to showing the text.
 */
function parseDsmlToolCalls(text, toolNames = null) {
  const src = String(text || '');
  const start = src.search(DSML_OPEN);
  if (start < 0) return null;
  const allowed = toolNames ? new Set(toolNames) : null;
  const calls = [];
  const invoke = /<\s*\|\s*DSML\s*\|\s*invoke\b([^>]*)>/gi;
  const matches = [...src.matchAll(invoke)];
  for (let i = 0; i < matches.length; i++) {
    const name = dsmlAttr(matches[i][1], 'name');
    if (!name || (allowed && !allowed.has(name))) continue;
    const from = matches[i].index + matches[i][0].length;
    const to = i + 1 < matches.length ? matches[i + 1].index : src.length;
    calls.push({ id: `call_text_${i}`, name, arguments: dsmlArguments(src.slice(from, to)) });
  }
  let end = start;
  for (const m of src.matchAll(DSML_CLOSE_ANY)) {
    const at = m.index + m[0].length;
    if (at > end) end = at;
  }
  return { calls, before: src.slice(0, start), after: src.slice(end) };
}

// A second textual form models use is a conventional call:
//   Call propose_plan(steps=[...], summary="...", title="...")
// The arguments are keyword arguments whose values are JSON (or close to it).
// Parse this at the platform boundary too, so every app receives a real
// tool_call instead of showing the call in the chat.
const CALL_OPEN = /\bCall\s+([A-Za-z0-9_-]{1,64})\s*\(/i;

function canonicalToolName(name, allowed) {
  if (!allowed) return name;
  if (allowed.has(name)) return name;
  const lower = String(name || '').toLowerCase();
  for (const n of allowed) if (n.toLowerCase() === lower) return n;
  return '';
}

/** The matching close bracket of the call opened just before `from`. */
function findCallClose(text, from) {
  const stack = [')'];
  let quote = '';
  let escape = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') stack.push(')');
    else if (ch === '[') stack.push(']');
    else if (ch === '{') stack.push('}');
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.at(-1) === ch) {
        stack.pop();
        if (!stack.length) return i;
      }
    }
  }
  return -1;
}

/** Split keyword arguments on commas that are not nested in a value. */
function splitCallArgs(text) {
  const out = [];
  let start = 0;
  let quote = '';
  let escape = false;
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') stack.push(')');
    else if (ch === '[') stack.push(']');
    else if (ch === '{') stack.push('}');
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.at(-1) === ch) stack.pop();
    } else if (ch === ',' && !stack.length) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** The first keyword `=` in an argument, ignoring comparisons and arrows. */
function callArgEquals(text) {
  let quote = '';
  let escape = false;
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') stack.push(')');
    else if (ch === '[') stack.push(']');
    else if (ch === '{') stack.push('}');
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.at(-1) === ch) stack.pop();
    } else if (ch === '=' && !stack.length) {
      const prev = text[i - 1];
      const next = text[i + 1];
      if (prev !== '=' && prev !== '<' && prev !== '>' && prev !== '!' && next !== '=' && next !== '>') return i;
    }
  }
  return -1;
}

/** Turn Python-ish values (single quotes, True/False/None) into JSON. */
function toJSONish(text) {
  let out = '';
  let quote = '';
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escape) {
        escape = false;
        out += ch === "'" ? "'" : `\\${ch}`;
        continue;
      }
      if (ch === '\\') { escape = true; continue; }
      if (ch === quote) { out += '"'; quote = ''; continue; }
      if (quote !== '"' && ch === '"') { out += '\\"'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += '"'; continue; }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^(True|False|None)\b/.exec(text.slice(i));
      if (m) {
        out += m[1] === 'True' ? 'true' : m[1] === 'False' ? 'false' : 'null';
        i += m[0].length - 1;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function stripTrailingCommas(text) {
  let out = '';
  let quote = '';
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escape) { escape = false; out += ch; continue; }
      if (ch === '\\') { escape = true; out += ch; continue; }
      if (ch === quote) quote = '';
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === ']' || text[j] === '}') continue;
    }
    out += ch;
  }
  return out;
}

function parseLooseJSON(text) {
  const src = String(text ?? '').trim();
  if (!src) return undefined;
  try {
    return JSON.parse(src);
  } catch { /* try the Python-ish form below */ }
  try {
    return JSON.parse(stripTrailingCommas(toJSONish(src)));
  } catch {
    return undefined;
  }
}

function parseCallArguments(text) {
  const src = String(text || '').trim();
  if (!src) return {};
  if (src.startsWith('{')) {
    const whole = parseLooseJSON(src);
    if (whole && typeof whole === 'object' && !Array.isArray(whole)) return whole;
  }
  const args = {};
  const positional = [];
  for (const part of splitCallArgs(src)) {
    const at = callArgEquals(part);
    if (at < 0) {
      if (part.trim()) positional.push(part.trim());
      continue;
    }
    const key = part.slice(0, at).trim().replace(/^(["'])(.*)\1$/, '$2');
    if (!/^[A-Za-z_$][\w$.-]*$/.test(key)) continue;
    const valueText = part.slice(at + 1).trim();
    const value = parseLooseJSON(valueText);
    args[key] = value === undefined ? valueText : value;
  }
  if (!Object.keys(args).length && positional.length === 1) {
    const one = parseLooseJSON(positional[0]);
    if (one && typeof one === 'object' && !Array.isArray(one)) return one;
    return { value: one === undefined ? positional[0] : one };
  }
  return args;
}

function parseCallSyntaxToolCalls(text, allowed) {
  const src = String(text || '');
  const re = new RegExp(CALL_OPEN.source, 'gi');
  const calls = [];
  let first = -1;
  let last = -1;
  for (let m; (m = re.exec(src)); ) {
    const name = canonicalToolName(m[1], allowed);
    if (!name) continue;
    const from = m.index + m[0].length;
    const to = findCallClose(src, from);
    if (to < 0) continue;
    calls.push({ id: `call_text_${calls.length}`, name, arguments: parseCallArguments(src.slice(from, to)) });
    if (first < 0) first = m.index;
    last = to + 1;
    re.lastIndex = to + 1;
  }
  if (!calls.length) return null;
  return { calls, before: src.slice(0, first), after: src.slice(last) };
}

/** Textual calls in either supported form, and the prose around them. */
export function parseTextToolCalls(text, toolNames = null) {
  const allowed = toolNames ? new Set(toolNames) : null;
  const dsml = parseDsmlToolCalls(text, allowed);
  if (dsml?.calls.length) return dsml;
  return parseCallSyntaxToolCalls(text, allowed);
}

/** A possible or complete `Call name(` opener, for the streaming filter. */
function callSyntaxStart(text, names) {
  const allowed = new Set(names);
  for (const m of text.matchAll(/\bCall\s*/gi)) {
    const at = m.index;
    const after = text.slice(at + m[0].length);
    const token = (/^[A-Za-z0-9_-]*/.exec(after) || [''])[0];
    const rest = after.slice(token.length);
    const canonical = canonicalToolName(token, allowed);
    if (canonical) {
      if (/^\s*\(/.test(rest)) return { at, complete: true };
      if (/^\s*$/.test(rest)) return { at, complete: false };
      continue;
    }
    if (!token) return { at, complete: false };
    const lower = token.toLowerCase();
    if ([...allowed].some((n) => n.toLowerCase().startsWith(lower)) && /^\s*$/.test(rest)) {
      return { at, complete: false };
    }
  }
  return null;
}

/** Hold a possible `Call` opener split across stream chunks ("C", "Ca"...). */
function callPrefixHold(text) {
  const m = /(?:^|[^A-Za-z])(c(?:a(?:l(?:l)?)?)?)$/i.exec(text);
  if (!m) return -1;
  return m.index + m[0].length - m[1].length;
}

/**
 * A streaming text filter for the repair above. Prose flows through as it
 * arrives; once a textual call opener is seen everything is held until the
 * stream ends, so the markup never reaches the app as chat text. Calls are
 * emitted at the end, like the wire formats' assembled tool calls.
 */
function textToolCallRepair(emit, tools) {
  const names = tools.map((t) => t.name);
  let pending = '';
  let block = '';
  let inBlock = false;
  let done = false;
  const say = (delta) => { if (delta) emit({ type: 'text', delta }); };
  const scan = () => {
    if (inBlock) return;
    const dsmlAt = pending.search(DSML_OPEN);
    const call = callSyntaxStart(pending, names);
    if (dsmlAt >= 0 && (!call || dsmlAt <= call.at)) {
      const before = pending.slice(0, dsmlAt);
      block = pending.slice(dsmlAt);
      pending = '';
      inBlock = true;
      say(before);
      return;
    }
    if (call) {
      const before = pending.slice(0, call.at);
      if (call.complete) {
        block = pending.slice(call.at);
        pending = '';
        inBlock = true;
      } else {
        pending = pending.slice(call.at);
      }
      say(before);
      return;
    }
    // Hold a possible opener split across deltas: DSML starts with "<",
    // and "Call" can arrive as "C", "Ca" or "Cal" at the end of a chunk.
    let hold = pending.length;
    const lt = pending.lastIndexOf('<');
    if (lt >= 0 && pending.length - lt <= 24) hold = Math.min(hold, lt);
    const ct = callPrefixHold(pending);
    if (ct >= 0) hold = Math.min(hold, ct);
    if (hold > 0) {
      say(pending.slice(0, hold));
      pending = pending.slice(hold);
    }
  };
  return {
    text(delta) {
      if (done) return say(delta);
      pending += String(delta || '');
      scan();
    },
    finish() {
      if (done) return;
      done = true;
      if (!inBlock) { say(pending); pending = ''; return; }
      const raw = block + pending;
      const parsed = parseTextToolCalls(raw, names);
      block = pending = '';
      if (!parsed || !parsed.calls.length) { say(raw); return; }
      // A partial opener can sit before the actual call in the held block.
      if (parsed.before) say(parsed.before);
      // A newline after the closing call is formatting, not a message.
      const after = parsed.after.replace(/^\s*\n/, '');
      if (after.trim()) say(after);
      for (const call of parsed.calls) emit({ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments });
    },
    abort() {
      if (done) return;
      done = true;
      say(block + pending);
      block = pending = '';
    },
  };
}

/** One data URI → { media_type, data }; null when not a base64 data URI. */
const imageParts = (uri) => {
  const m = /^data:([\w./+-]+);base64,(.+)$/.exec(String(uri));
  return m ? { media_type: m[1], data: m[2] } : null;
};

const toOpenAI = (messages) =>
  messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls) return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments ?? {}) } })) };
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    if (m.images?.length) {
      return {
        role: m.role,
        content: [
          { type: 'text', text: m.content || ' ' },
          ...m.images.map((u) => ({ type: 'image_url', image_url: { url: u } })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });

function toAnthropic(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const out = [];
  const push = (role, blocks) => {
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      const blocks = [{ type: 'text', text: m.content || ' ' }];
      for (const uri of m.images || []) {
        const img = imageParts(uri);
        if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
      }
      push('user', blocks);
    } else if (m.role === 'tool') push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content || '' }]);
    else {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const t of m.tool_calls || []) blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.arguments ?? {} });
      if (!blocks.length) blocks.push({ type: 'text', text: ' ' });
      push('assistant', blocks);
    }
  }
  return { system, messages: out };
}

// Streaming ------------------------------------------------------------------------------

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trim();
}

async function upstreamError(p, res, hasTools) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* none */
  }
  let message = text;
  try {
    const j = JSON.parse(text);
    message = j.error?.message || j.message || j.error || text;
  } catch {
    /* plain text */
  }
  message = String(message || '').slice(0, 400);
  if (res.status === 401 || res.status === 403) return new HttpError(502, 'bad_key', `${p.label} refused the API key (${res.status}). Check it in Admin → AI.`);
  if (hasTools && /tool|function/i.test(message) && res.status < 500) return new HttpError(400, 'tools_unsupported', "This model can't edit the drawing, chat only.");
  if (res.status === 404) return new HttpError(502, 'no_model', `${p.label} does not offer that model: ${message}`);
  if (res.status === 429) return new HttpError(502, 'rate_limited', `${p.label} is rate limiting or out of credit: ${message}`);
  return new HttpError(502, 'provider_error', `${p.label} answered ${res.status}: ${message}`);
}

function networkError(p, err) {
  if (err.name === 'AbortError') return err;
  if (p.id === 'ollama') return new HttpError(502, 'ollama_down', 'Ollama is not running on this PC. Start it (ollama serve), then try again.');
  return new HttpError(502, 'provider_unreachable', `Could not reach ${p.label}: ${err.cause?.code || err.message}`);
}

/** An app that does not choose an output cap gets this, never the model's full context. */
const DEFAULT_MAX_TOKENS = 4096;

async function runOpenAI(p, model, { messages, tools, temperature, maxTokens }, emit, signal) {
  const body = { model, messages: toOpenAI(messages), stream: true };
  if (p.streamUsage) body.stream_options = { include_usage: true };
  if (tools?.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (temperature != null) body.temperature = temperature;
  body.max_tokens = maxTokens || DEFAULT_MAX_TOKENS;
  const headers = { 'Content-Type': 'application/json' };
  if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
  let res;
  try {
    res = await fetch(`${p.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    throw networkError(p, err);
  }
  if (!res.ok) throw await upstreamError(p, res, !!tools?.length);
  const calls = new Map();
  const usage = { input: 0, output: 0 };
  for await (const data of sseEvents(res.body)) {
    if (data === '[DONE]') break;
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.error) throw new HttpError(502, 'provider_error', `${p.label}: ${j.error.message || JSON.stringify(j.error)}`);
    const u = j.usage || j.choices?.[0]?.usage;
    if (u) {
      usage.input = u.prompt_tokens ?? usage.input;
      usage.output = u.completion_tokens ?? usage.output;
    }
    const delta = j.choices?.[0]?.delta;
    if (!delta) continue;
    if (delta.content) emit({ type: 'text', delta: delta.content });
    for (const tc of delta.tool_calls || []) {
      const k = tc.index ?? 0;
      const cur = calls.get(k) || { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(k, cur);
    }
  }
  for (const [k, c] of [...calls].sort((a, b) => a[0] - b[0])) emit({ type: 'tool_call', id: c.id || `call_${k}`, name: c.name, arguments: safeParse(c.args) });
  return usage;
}

async function runAnthropic(p, model, { messages, tools, temperature, maxTokens }, emit, signal) {
  const { system, messages: msgs } = toAnthropic(messages);
  const body = { model, max_tokens: maxTokens || 4096, messages: msgs, stream: true };
  if (system) body.system = system;
  if (tools?.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (temperature != null) body.temperature = temperature;
  let res;
  try {
    res = await fetch(`${p.baseUrl}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal });
  } catch (err) {
    throw networkError(p, err);
  }
  if (!res.ok) throw await upstreamError(p, res, !!tools?.length);
  const usage = { input: 0, output: 0 };
  const blocks = new Map();
  for await (const data of sseEvents(res.body)) {
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    switch (j.type) {
      case 'message_start':
        usage.input = j.message?.usage?.input_tokens ?? 0;
        usage.output = j.message?.usage?.output_tokens ?? 0;
        break;
      case 'content_block_start':
        if (j.content_block?.type === 'tool_use') blocks.set(j.index, { id: j.content_block.id, name: j.content_block.name, json: '' });
        else if (j.content_block?.type === 'text' && j.content_block.text) emit({ type: 'text', delta: j.content_block.text });
        break;
      case 'content_block_delta':
        if (j.delta?.type === 'text_delta') emit({ type: 'text', delta: j.delta.text });
        else if (j.delta?.type === 'input_json_delta' && blocks.has(j.index)) blocks.get(j.index).json += j.delta.partial_json;
        break;
      case 'content_block_stop': {
        const b = blocks.get(j.index);
        if (b) {
          emit({ type: 'tool_call', id: b.id, name: b.name, arguments: safeParse(b.json) });
          blocks.delete(j.index);
        }
        break;
      }
      case 'message_delta':
        if (j.usage?.output_tokens != null) usage.output = j.usage.output_tokens;
        if (j.usage?.input_tokens != null) usage.input = j.usage.input_tokens;
        break;
      case 'error':
        throw new HttpError(502, 'provider_error', `${p.label}: ${j.error?.message || 'error'}`);
    }
  }
  return usage;
}

function logUsage(row) {
  db.run(
    'INSERT INTO ai_usage(at, user, source, provider, model, input_tokens, output_tokens, ms, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    Date.now(),
    row.user ?? null,
    row.source,
    row.provider,
    row.model,
    row.input || 0,
    row.output || 0,
    row.ms,
    row.status,
    row.error ? String(row.error).slice(0, 300) : null,
  );
}

/**
 * One chat call. emit(event) receives text and tool_call events as they
 * arrive. Resolves with { text, toolCalls, usage }.
 */
export async function chat({ user = null, source, model: modelId, messages, tools, temperature, maxTokens, emit = () => {}, signal }) {
  if (typeof modelId !== 'string' || !modelId.includes(':')) throw new HttpError(400, 'bad_model', 'Pick a model.');
  const i = modelId.indexOf(':');
  const provider = modelId.slice(0, i);
  const model = modelId.slice(i + 1);
  const p = providerSettings(provider);
  if (!p) throw new HttpError(400, 'bad_model', 'That model is not set up on this server.');
  if (p.needsKey && !p.apiKey) throw new HttpError(400, 'no_key', `Add an API key for ${p.label} in Admin → AI.`);
  if (p.kind !== 'test' && (provider === 'ollama' ? !p.enabled : !models().some((m) => m.id === modelId && m.enabled))) throw new HttpError(400, 'bad_model', 'That model is not turned on in Admin → AI.');
  const req = { messages: checkMessages(messages), tools: checkTools(tools), temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : null, maxTokens: Number.isInteger(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, 64000) : null };
  const t0 = Date.now();
  let text = '';
  const toolCalls = [];
  const out = (e) => {
    if (e.type === 'text') text += e.delta;
    if (e.type === 'tool_call') toolCalls.push({ id: e.id, name: e.name, arguments: e.arguments });
    emit(e);
  };
  // Models that print their tool calls (DSML) instead of returning them: hold
  // the markup back, then emit real tool calls so the app runs them.
  const repair = req.tools?.length ? textToolCallRepair(out, req.tools) : null;
  const capture = repair
    ? (e) => { if (e.type === 'text') repair.text(e.delta); else out(e); }
    : out;
  try {
    const usage = await (p.kind === 'test' ? runTest : p.kind === 'anthropic' ? runAnthropic : runOpenAI)(p, model, req, capture, signal);
    repair?.finish();
    logUsage({ user, source, provider, model, ...usage, ms: Date.now() - t0, status: 'ok' });
    emit({ type: 'usage', input: usage.input, output: usage.output });
    return { text, toolCalls, usage };
  } catch (err) {
    repair?.abort();
    const aborted = err.name === 'AbortError' || signal?.aborted;
    logUsage({ user, source, provider, model, ms: Date.now() - t0, status: aborted ? 'aborted' : 'error', error: aborted ? null : err.message });
    throw err;
  }
}

/** Stream a chat call to an HTTP response as NDJSON. */
export async function streamChat(req, res, body, { user, source }) {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  const write = (e) => {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(e)}\n`);
  };
  try {
    await chat({ user, source, model: body?.model, messages: body?.messages, tools: body?.tools, temperature: body?.temperature, maxTokens: body?.max_tokens ?? body?.maxTokens, emit: write, signal: ac.signal });
    write({ type: 'done' });
  } catch (err) {
    if (!ac.signal.aborted) write({ type: 'error', code: err.code || 'server_error', message: err instanceof HttpError ? err.message : 'Something went wrong on the server.' });
    if (!(err instanceof HttpError) && err.name !== 'AbortError') console.error('AI:', err);
  }
  res.end();
}

// Admin --------------------------------------------------------------------------------------

async function fetchModelList(p) {
  if (p.id === 'ollama') return (await ollamaModels(p, { fresh: true })).map((id) => ({ id, label: id }));
  if (p.needsKey && !p.apiKey) throw new HttpError(400, 'no_key', 'Save an API key first.');
  const headers = p.kind === 'anthropic' ? { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${p.apiKey}` };
  let res;
  try {
    res = await fetch(`${p.baseUrl}/models${p.kind === 'anthropic' ? '?limit=1000' : ''}`, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw networkError(p, err);
  }
  if (!res.ok) {
    if (res.status === 404) throw new HttpError(502, 'no_list', `${p.label} does not list its models. Add model names by hand.`);
    throw await upstreamError(p, res, false);
  }
  const j = await res.json();
  return (j.data || j.models || []).map((m) => ({ id: m.id || m.name, label: m.display_name || m.id || m.name })).filter((m) => m.id);
}

function usageReport(days) {
  const since = Date.now() - days * 86400_000;
  const prices = config.get('ai.prices') || {};
  const cost = (key, inp, out) => {
    const pr = prices[key];
    if (!pr) return null;
    return ((Number(pr.input) || 0) * inp + (Number(pr.output) || 0) * out) / 1e6;
  };
  const rows = db.all('SELECT user, source, provider, model, input_tokens AS i, output_tokens AS o, status, at FROM ai_usage WHERE at >= ?', since);
  const group = (keyFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      const g = m.get(k) || { key: k, calls: 0, errors: 0, input: 0, output: 0, cost: 0, priced: true };
      g.calls++;
      if (r.status === 'error') g.errors++;
      g.input += r.i;
      g.output += r.o;
      const c = cost(`${r.provider}:${r.model}`, r.i, r.o);
      if (c == null) g.priced = false;
      else g.cost += c;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.input + b.output - (a.input + a.output));
  };
  const day = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  return {
    days,
    totals: group(() => 'all')[0] || { calls: 0, errors: 0, input: 0, output: 0, cost: 0, priced: true },
    byPerson: group((r) => r.user || r.source),
    byModel: group((r) => `${r.provider}:${r.model}`),
    byDay: group((r) => day(r.at)).sort((a, b) => (a.key < b.key ? -1 : 1)),
  };
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function register(s) {
  const { api } = s;

  api.add('GET', 'ai/models', async ({ res }) => send(res, 200, await availableModels()));
  api.add('POST', 'ai/chat', async ({ req, res, user }) => {
    const body = await readJSONBody(req, 8 * 1024 * 1024);
    return streamChat(req, res, body, { user, source: 'cad' });
  });

  const admin = (method, route, fn) =>
    api.add(method, `admin/ai${route}`, async (ctx) => {
      requireAdmin(ctx.account);
      return fn(ctx);
    });

  // One-time: the previous "add any provider" experiment stored keys under
  // ai.customProviders. Carry those keys over to the matching built-in provider.
  const legacyCustom = config.get('ai.customProviders');
  if (legacyCustom && typeof legacyCustom === 'object') {
    const all = config.get('ai.providers') || {};
    let moved = false;
    for (const [id, c] of Object.entries(legacyCustom)) {
      if (!PROVIDERS[id] || id === 'ollama' || !c?.apiKey || typeof c.apiKey !== 'string') continue;
      if (!all[id]) {
        all[id] = { apiKey: c.apiKey, ...(c.baseUrl && c.baseUrl !== PROVIDERS[id].baseUrl ? { baseUrl: String(c.baseUrl).replace(/\/+$/, '') } : {}) };
        moved = true;
      }
    }
    if (moved) config.set('ai.providers', all);
    config.set('ai.customProviders', {});
  }

  admin('GET', '', async ({ res }) => {
    const all = config.get('ai.providers') || {};
    send(res, 200, {
      providers: Object.entries(PROVIDERS).map(([id, d]) => ({ id, label: d.label, kind: d.kind, defaultBaseUrl: d.baseUrl, baseUrl: all[id]?.baseUrl || d.baseUrl, apiKey: config.mask(all[id]?.apiKey), needsKey: d.needsKey, enabled: providerSettings(id).enabled, keyHint: d.keyHint })),
      models: models(),
      prices: config.get('ai.prices') || {},
    });
  });

  admin('PUT', '/providers/:id', async ({ req, res, user, params }) => {
    if (!PROVIDERS[params.id]) throw new HttpError(404, 'not_found', 'Unknown provider.');
    const b = (await readJSONBody(req)) || {};
    const all = config.get('ai.providers') || {};
    const cur = all[params.id] || {};
    const next = { ...cur };
    if ('apiKey' in b && !config.isMasked(b.apiKey)) next.apiKey = String(b.apiKey || '').trim();
    if ('baseUrl' in b) {
      const u = baseUrlField(b);
      next.baseUrl = u && u !== PROVIDERS[params.id].baseUrl ? u : undefined;
    }
    if ('enabled' in b) next.enabled = !!b.enabled;
    all[params.id] = next;
    config.set('ai.providers', all);
    ollamaCache.at = 0;
    store.audit(user, 'ai.provider_updated', { provider: params.id, key: 'apiKey' in b && !config.isMasked(b.apiKey) ? 'changed' : 'unchanged' });
    send(res, 200, { ok: true, apiKey: config.mask(next.apiKey), enabled: providerSettings(params.id).enabled });
  });

  admin('POST', '/providers/:id/models', async ({ res, params }) => {
    const p = providerSettings(params.id);
    if (!p) throw new HttpError(404, 'not_found', 'Unknown provider.');
    const found = await fetchModelList(p);
    send(res, 200, { models: found.map((m) => ({ ...m, id: `${params.id}:${m.id}` })) });
  });

  admin('POST', '/providers/:id/test', async ({ res, user, params }) => {
    const p = providerSettings(params.id);
    if (!p) throw new HttpError(404, 'not_found', 'Unknown provider.');
    const t0 = Date.now();
    const found = await fetchModelList(p).catch((err) => {
      if (err.code === 'no_list') return null;
      throw err;
    });
    store.audit(user, 'ai.provider_tested', { provider: params.id });
    send(res, 200, { ok: true, ms: Date.now() - t0, models: found ? found.length : null, message: found ? `Connected. ${found.length} models available.` : 'Connected.' });
  });

  admin('PUT', '/models', async ({ req, res, user }) => {
    const b = (await readJSONBody(req, 1024 * 1024)) || {};
    if (!Array.isArray(b.models)) throw new HttpError(400, 'bad_request', 'Send a list of models.');
    const seen = new Set();
    const list = [];
    for (const m of b.models) {
      const id = String(m?.id || '').trim();
      const [provider, ...rest] = id.split(':');
      if (!rest.join(':') || seen.has(id)) continue;
      const ps = providerSettings(provider);
      if (!ps) continue;
      seen.add(id);
      list.push({ id, label: String(m.label || '').slice(0, 80), enabled: !!m.enabled, tools: m.tools !== false });
    }
    config.set('ai.models', list);
    store.audit(user, 'ai.models_updated', { count: list.length, enabled: list.filter((m) => m.enabled).length });
    send(res, 200, { models: list });
  });

  admin('PUT', '/prices', async ({ req, res, user }) => {
    const b = (await readJSONBody(req, 256 * 1024)) || {};
    const out = {};
    for (const [k, v] of Object.entries(b.prices || {})) {
      const input = Number(v?.input);
      const output = Number(v?.output);
      if (Number.isFinite(input) || Number.isFinite(output)) out[k] = { input: Number.isFinite(input) ? input : 0, output: Number.isFinite(output) ? output : 0 };
    }
    config.set('ai.prices', out);
    store.audit(user, 'ai.prices_updated', {});
    send(res, 200, { prices: out });
  });

  admin('GET', '/usage', async ({ res, url }) => send(res, 200, usageReport(Math.min(366, Math.max(1, Number(url.searchParams.get('days')) || 30)))));

  admin('GET', '/usage.csv', async ({ res, url }) => {
    const days = Math.min(3660, Math.max(1, Number(url.searchParams.get('days')) || 30));
    const rows = db.all('SELECT * FROM ai_usage WHERE at >= ? ORDER BY at', Date.now() - days * 86400_000);
    const lines = ['time,user,source,provider,model,input_tokens,output_tokens,ms,status,error', ...rows.map((r) => [new Date(r.at).toISOString(), r.user, r.source, r.provider, r.model, r.input_tokens, r.output_tokens, r.ms, r.status, r.error].map(csvCell).join(','))];
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="ai-usage-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.end(`${lines.join('\n')}\n`);
  });
}

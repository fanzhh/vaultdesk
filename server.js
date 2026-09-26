import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(APP, '.env');
const DATA_DIR = path.join(APP, 'data');
const DAILY_TEMPLATE_FILE = path.join(DATA_DIR, 'daily-template.md');
const DEFAULT_DAILY_TEMPLATE = '# {{date}}\n\n## Notes\n';

function loadDotEnv() {
  // 不覆盖已有环境变量（与 dotenv 默认行为一致）：shell 显式 export 的值优先于 .env
  for (const [key, value] of Object.entries(readDotEnvValues())) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const ROOT = path.resolve(process.env.OBSIDIAN_VAULT_ROOT || path.join(os.homedir(), 'markdown-vault'));
const PORT = Number(process.env.PORT || 4177);
const HOST = process.env.HOST || '127.0.0.1';
// 可选的关键词检索脚本（如自备的 kb-search.py）。留空时使用内置关键词检索；
// 配置后用自备脚本替换内置实现，脚本缺失或执行失败时自动回退内置检索。
const KB_SEARCH = String(process.env.KB_SEARCH_SCRIPT || '').trim();
// 默认对话模型（用户在设置页选择）。与其它配置不同：每次调用都现读 .env，改动即时生效。
const DEFAULT_LLM_MODEL = String(process.env.DEFAULT_LLM_MODEL || '').trim();
const SKIP = new Set(['.git', '.obsidian', '.crush', '.memory', '.agents', '.claude', '.codex', '.omx', '.wrangler', 'node_modules', 'venv', '.venv']);
let notes = [];

const TEXT_EXTS = new Set(['.md', '.txt', '.json', '.csv', '.py', '.js', '.ts', '.html', '.css', '.yaml', '.yml']);

function cleanRelPath(value, fallback) {
  const normalized = String(value || fallback).replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) return '';
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || SKIP.has(part))) {
    throw new Error(`Invalid vault-relative path: ${normalized}`);
  }
  return normalized;
}

const INBOX_REL = cleanRelPath(process.env.VAULT_INBOX_PATH, 'Inbox.md');
const DAILY_PATH_PATTERN = cleanRelPath(process.env.VAULT_DAILY_PATH_PATTERN, 'Daily/{YYYY}-{MM}-{DD}.md');
const RSS_INBOX_REL = cleanRelPath(process.env.VAULT_RSS_READ_LATER_PATH, 'read-later.md');
const CHAT_SAVE_PATH_PATTERN = cleanRelPath(process.env.VAULT_CHAT_SAVE_PATH_PATTERN, 'answers/{YYYY}-{MM}-{DD}-answer-{slug}.md');
const CONFIG_KEYS = [
  'OBSIDIAN_VAULT_ROOT',
  'VAULT_INBOX_PATH',
  'VAULT_DAILY_PATH_PATTERN',
  'VAULT_DAILY_TEMPLATE_FILE',
  'VAULT_RSS_READ_LATER_PATH',
  'VAULT_CHAT_SAVE_PATH_PATTERN',
  'KB_SEARCH_SCRIPT',
  'QDRANT_URL',
  'LMSTUDIO_BASE_URL',
  'DEFAULT_LLM_MODEL',
  'LLM_WIKI_BASE_URL',
  'LLM_WIKI_API_TOKEN',
  'LLM_WIKI_PROJECT',
  'HOST',
  'PORT'
];
const CONFIG_DEFAULTS = {
  OBSIDIAN_VAULT_ROOT: path.join(os.homedir(), 'markdown-vault'),
  VAULT_INBOX_PATH: 'Inbox.md',
  VAULT_DAILY_PATH_PATTERN: 'Daily/{YYYY}-{MM}-{DD}.md',
  VAULT_DAILY_TEMPLATE_FILE: '',
  VAULT_RSS_READ_LATER_PATH: 'read-later.md',
  VAULT_CHAT_SAVE_PATH_PATTERN: 'answers/{YYYY}-{MM}-{DD}-answer-{slug}.md',
  KB_SEARCH_SCRIPT: '',
  QDRANT_URL: '',
  LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/v1',
  DEFAULT_LLM_MODEL: '',
  LLM_WIKI_BASE_URL: '',
  LLM_WIKI_API_TOKEN: '',
  LLM_WIKI_PROJECT: 'current',
  HOST: '127.0.0.1',
  PORT: '4177'
};

function readDotEnvValues() {
  const values = {};
  if (!fs.existsSync(ENV_PATH)) return values;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function quoteEnvValue(value) {
  const text = String(value || '');
  if (!text) return '';
  return JSON.stringify(text);
}

function writeDotEnvValues(values) {
  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/) : [];
  const seen = new Set();
  const lines = existing.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*=)(.*)$/);
    if (!match || !CONFIG_KEYS.includes(match[2])) return line;
    seen.add(match[2]);
    return `${match[2]}=${quoteEnvValue(values[match[2]])}`;
  }).filter((line) => line.trim() !== '');
  const missing = CONFIG_KEYS.filter(key => !seen.has(key) && values[key]);
  if (missing.length && lines.length) lines.push('');
  for (const key of missing) lines.push(`${key}=${quoteEnvValue(values[key])}`);
  fs.writeFileSync(ENV_PATH, `${lines.join('\n')}\n`, 'utf8');
}

function currentSettings() {
  const saved = readDotEnvValues();
  const values = Object.fromEntries(CONFIG_KEYS.map(key => [key, saved[key] ?? process.env[key] ?? CONFIG_DEFAULTS[key] ?? '']));
  const effective = {
    OBSIDIAN_VAULT_ROOT: ROOT,
    VAULT_INBOX_PATH: INBOX_REL,
    VAULT_DAILY_PATH_PATTERN: DAILY_PATH_PATTERN,
    VAULT_DAILY_TEMPLATE_FILE: vaultDailyTemplateFile(),
    VAULT_RSS_READ_LATER_PATH: RSS_INBOX_REL,
    VAULT_CHAT_SAVE_PATH_PATTERN: CHAT_SAVE_PATH_PATTERN,
    KB_SEARCH_SCRIPT: KB_SEARCH,
    QDRANT_URL: qdrantUrl(),
    LMSTUDIO_BASE_URL,
    DEFAULT_LLM_MODEL,
    HOST,
    PORT: String(PORT)
  };
  // DEFAULT_LLM_MODEL 等每次请求都从 .env 现读，改完即生效，不需要重启
  const liveKeys = ['DEFAULT_LLM_MODEL', 'VAULT_DAILY_TEMPLATE_FILE', 'LLM_WIKI_BASE_URL', 'LLM_WIKI_API_TOKEN', 'LLM_WIKI_PROJECT', 'QDRANT_URL'];
  const requiresRestart = CONFIG_KEYS.filter((key) => !liveKeys.includes(key)).some(key => values[key] && values[key] !== effective[key]);
  // 访问令牌不回传前端，只给 hasWikiToken 状态（保存时留空 = 保持已存令牌）
  const hasWikiToken = !!String(values.LLM_WIKI_API_TOKEN || '').trim();
  values.LLM_WIKI_API_TOKEN = '';
  return {
    envPath: ENV_PATH,
    requiresRestart,
    hasWikiToken,
    values,
    effective,
    defaults: CONFIG_DEFAULTS,
    dailyTemplate: dailyTemplateSettings(),
    rssFeeds: { custom: fs.existsSync(USER_FEEDS_FILE), text: feedsToText(loadFeedsConfig()) }
  };
}

// 日记模板文件（vault 内路径）：现读 .env，保存即生效，不需要重启
function vaultDailyTemplateFile() {
  return String(readDotEnvValues().VAULT_DAILY_TEMPLATE_FILE || '').trim();
}

function dailyTemplateSettings() {
  let content = DEFAULT_DAILY_TEMPLATE;
  let custom = false;
  if (fs.existsSync(DAILY_TEMPLATE_FILE)) {
    content = fs.readFileSync(DAILY_TEMPLATE_FILE, 'utf8');
    custom = true;
  }
  // vault 内模板文件优先于应用内置模板；配置了但读不到时回退内置，并把状态暴露给前端提示
  const vaultFile = vaultDailyTemplateFile();
  let vaultFileExists = false;
  if (vaultFile) {
    try {
      const abs = safeNotePath(vaultFile);
      vaultFileExists = !!abs && fs.existsSync(abs) && fs.statSync(abs).isFile();
      if (vaultFileExists) content = fs.readFileSync(abs, 'utf8');
    } catch { vaultFileExists = false; }
  }
  return {
    path: DAILY_TEMPLATE_FILE,
    content,
    defaultContent: DEFAULT_DAILY_TEMPLATE,
    custom,
    vaultFile,
    vaultFileExists,
    source: vaultFile && vaultFileExists ? 'vault' : 'app'
  };
}

function writeDailyTemplate(content) {
  const text = String(content || '').trimEnd();
  if (!text.trim()) throw new Error('每日模板不能为空。');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${DAILY_TEMPLATE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${text}\n`, 'utf8');
  fs.renameSync(temp, DAILY_TEMPLATE_FILE);
}

function validateSettings(values) {
  const errors = [];
  const next = {};
  for (const key of CONFIG_KEYS) next[key] = String(values[key] || '').trim();
  if (next.OBSIDIAN_VAULT_ROOT && !path.isAbsolute(next.OBSIDIAN_VAULT_ROOT)) errors.push('Vault 根目录必须是绝对路径。');
  if (next.KB_SEARCH_SCRIPT && !path.isAbsolute(next.KB_SEARCH_SCRIPT)) errors.push('检索脚本路径必须是绝对路径。');
  if (next.KB_SEARCH_SCRIPT) {
    // 检索脚本会被 python3 执行——禁止指向 vault 内部，防止「写入笔记 + 改配置」被串成任意代码执行
    const scriptAbs = path.resolve(next.KB_SEARCH_SCRIPT);
    const vaultAbs = path.resolve(next.OBSIDIAN_VAULT_ROOT || ROOT);
    if (scriptAbs === vaultAbs || scriptAbs.startsWith(vaultAbs + path.sep)) {
      errors.push('检索脚本不能位于 vault 目录内（防止笔记内容被当作脚本执行）。');
    }
  }
  if (next.QDRANT_URL && !/^https?:\/\//i.test(next.QDRANT_URL)) errors.push('Qdrant 地址必须以 http(s):// 开头，留空则不启用。');
  for (const key of ['VAULT_INBOX_PATH', 'VAULT_DAILY_PATH_PATTERN', 'VAULT_DAILY_TEMPLATE_FILE', 'VAULT_RSS_READ_LATER_PATH', 'VAULT_CHAT_SAVE_PATH_PATTERN']) {
    if (next[key]) {
      try { cleanRelPath(next[key], ''); }
      catch { errors.push(`${key} 必须是安全的 vault 内相对路径。`); }
    }
  }
  if (next.VAULT_INBOX_PATH && !next.VAULT_INBOX_PATH.endsWith('.md')) errors.push('待办文件路径必须以 .md 结尾。');
  if (next.VAULT_DAILY_TEMPLATE_FILE && !next.VAULT_DAILY_TEMPLATE_FILE.endsWith('.md')) errors.push('日记模板文件路径必须以 .md 结尾。');
  if (next.VAULT_RSS_READ_LATER_PATH && !next.VAULT_RSS_READ_LATER_PATH.endsWith('.md')) errors.push('RSS 稍后读路径必须以 .md 结尾。');
  if (!next.VAULT_DAILY_PATH_PATTERN.includes('{YYYY}') || !next.VAULT_DAILY_PATH_PATTERN.includes('{MM}') || !next.VAULT_DAILY_PATH_PATTERN.includes('{DD}') || !next.VAULT_DAILY_PATH_PATTERN.endsWith('.md')) {
    errors.push('每日笔记路径模板必须包含 {YYYY}、{MM}、{DD} 并以 .md 结尾。');
  }
  if (!next.VAULT_CHAT_SAVE_PATH_PATTERN.includes('{slug}') || !next.VAULT_CHAT_SAVE_PATH_PATTERN.endsWith('.md')) {
    errors.push('问答保存路径模板必须包含 {slug} 并以 .md 结尾。');
  }
  if (next.PORT && (!/^\d+$/.test(next.PORT) || Number(next.PORT) < 1 || Number(next.PORT) > 65535)) errors.push('端口必须是 1-65535 的数字。');
  return { values: next, errors };
}

// ============ 关键词检索 ============
// 默认使用内置 Node 检索（零配置可用）；配置 KB_SEARCH_SCRIPT 时改为调用自备脚本
// （如基于 ripgrep 的 kb-search.py，不随本仓库分发）。脚本缺失、执行失败或输出非法时
// 自动回退内置检索，保证问答始终有关键词来源。
let kbSearchScriptWarned = false;
function warnKbSearchScriptOnce(message) {
  if (!kbSearchScriptWarned) {
    kbSearchScriptWarned = true;
    console.warn(message);
  }
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count += 1; idx += needle.length; }
  return count;
}

// 从匹配结果构建素材：读取命中行附近原文作为摘录
function buildKeywordSources(rawMatches) {
  return rawMatches.map((m) => {
    const abs = path.join(ROOT, m.path);
    let excerpt = m.preview || '';
    const ext = path.extname(m.path).toLowerCase();
    if (TEXT_EXTS.has(ext) && fs.existsSync(abs)) {
      try {
        const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
        const lineNo = Number(m.line) || 1;
        const start = Math.max(0, lineNo - 5);
        const end = Math.min(lines.length, lineNo + 30);
        const snippet = lines.slice(start, end).join('\n');
        excerpt = snippet.length > 2500 ? snippet.slice(0, 2500) + '\n...[截断]' : snippet;
      } catch {}
    } else if (!TEXT_EXTS.has(ext)) {
      excerpt = `[非文本归档文件: ${path.basename(m.path)}]`;
    }
    return {
      title: m.title || path.basename(m.path, ext),
      path: m.path,
      line: m.line || 1,
      score: m.score || 0,
      scope: m.scope || 'vault',
      tags: m.tags || [],
      excerpt: excerpt.trim()
    };
  });
}

// 内置关键词检索：扫描内存笔记索引与文件正文，标题/路径/标签命中加权
function builtinKeywordSearch(query, { limit = 5, path_prefix = '', tag = '' } = {}) {
  return new Promise((resolve) => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return resolve([]);
    const terms = [...new Set(q.split(/\s+/).filter(Boolean))];
    if (terms.length > 1) terms.push(q); // 多词查询时整句短语额外计分
    const candidates = notes.filter((n) =>
      (!path_prefix || n.path === path_prefix || n.path.startsWith(path_prefix + '/'))
      && (!tag || n.tags.includes(tag)));
    const scored = [];
    for (const note of candidates) {
      let body = '';
      try { body = fs.readFileSync(path.join(ROOT, note.path), 'utf8').slice(0, 512 * 1024).toLowerCase(); } catch {}
      const titleHit = terms.reduce((s, t) => s + countOccurrences(String(note.title).toLowerCase(), t), 0);
      const tagPathHit = terms.reduce((s, t) => s + countOccurrences(`${note.path} ${note.tags.join(' ')}`.toLowerCase(), t), 0);
      const bodyHit = terms.reduce((s, t) => s + countOccurrences(body, t), 0);
      const score = titleHit * 8 + tagPathHit * 4 + Math.min(bodyHit, 50);
      if (score <= 0) continue;
      let line = 1;
      for (const t of terms) {
        const idx = body.indexOf(t);
        if (idx !== -1) { line = body.slice(0, idx).split('\n').length; break; }
      }
      scored.push({ path: note.path, title: note.title, line, score, scope: 'keyword', tags: note.tags });
    }
    scored.sort((a, b) => b.score - a.score);
    resolve(buildKeywordSources(scored.slice(0, limit)));
  });
}

function runKbSearchScript(query, { limit = 5, path_prefix = '', tag = '' } = {}) {
  return new Promise((resolve) => {
    const fallback = () => builtinKeywordSearch(query, { limit, path_prefix, tag }).then(resolve);
    if (!KB_SEARCH || !fs.existsSync(KB_SEARCH)) {
      if (KB_SEARCH) warnKbSearchScriptOnce(`[RAG Search] KB_SEARCH_SCRIPT 指向的脚本不存在：${KB_SEARCH}，已回退到内置关键词检索。`);
      return fallback();
    }
    const args = [KB_SEARCH, query, '--limit', String(limit), '--json'];
    if (path_prefix) args.push('--prefix', path_prefix);
    if (tag) args.push('--tag', tag);
    execFile('python3', args, { cwd: ROOT, timeout: 40000 }, (err, stdout) => {
      if (err) {
        warnKbSearchScriptOnce(`[RAG Search] 自备脚本执行失败（${String(err.message).split('\n')[0]}），已回退到内置关键词检索。`);
        return fallback();
      }
      try {
        const rawMatches = JSON.parse(stdout || '[]');
        resolve(Array.isArray(rawMatches) ? rawMatches : []);
      } catch {
        warnKbSearchScriptOnce('[RAG Search] 自备脚本输出不是合法 JSON，已回退到内置关键词检索。');
        fallback();
      }
    });
  });
}

function searchVaultRAG(query, { limit = 5, path_prefix = '', tag = '' } = {}) {
  return runKbSearchScript(query, { limit, path_prefix, tag }).then(buildKeywordSources);
}

const LMSTUDIO_BASE_URL = process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1';

// Available LLM Models List
// ===================== 🤖 自定义模型服务（OpenAI 兼容） =====================
// 与内置 Ollama / LM Studio 并列：用户可添加任意 OpenAI 兼容服务（地址、API Key、模型名），
// 存 data/llm-providers.json（gitignored）。调用时模型引用编码为 custom:<服务id>:<模型id>。
const CUSTOM_PROVIDERS_FILE = path.join(DATA_DIR, 'llm-providers.json');

function loadCustomProviders() {
  try {
    const list = JSON.parse(fs.readFileSync(CUSTOM_PROVIDERS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function saveCustomProviders(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CUSTOM_PROVIDERS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, CUSTOM_PROVIDERS_FILE);
}

function normalizeBaseUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }

// 校验并合并用户提交的服务列表；apiKey 留空且原服务已配置时保持原 key（前端不回显明文）
function sanitizeCustomProviders(input) {
  const list = Array.isArray(input) ? input : [];
  if (list.length > 20) throw new Error('自定义模型服务最多 20 个。');
  const old = loadCustomProviders();
  const out = [];
  for (const item of list) {
    const name = String(item.name || '').trim();
    const baseUrl = normalizeBaseUrl(item.baseUrl);
    if (!name) throw new Error('自定义模型服务缺少名称。');
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error(`服务「${name}」的地址必须以 http(s):// 开头。`);
    let models = Array.isArray(item.models) ? item.models : String(item.models || '').split(/[\n,，、]/);
    models = [...new Set(models.map((m) => String(m).trim()).filter(Boolean))];
    if (!models.length) throw new Error(`服务「${name}」至少填写一个模型名称。`);
    const oldItem = item.id ? old.find((o) => o.id === item.id) : null;
    const id = oldItem ? oldItem.id : `svc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const apiKey = String(item.apiKey || '').trim() || (oldItem ? oldItem.apiKey || '' : '');
    out.push({ id, name, baseUrl, apiKey, models });
  }
  return out;
}

function maskProviders(list) {
  return (list || []).map(({ apiKey, ...rest }) => ({ ...rest, hasKey: !!apiKey }));
}

async function getAvailableLLMs() {
  const models = [];

  // 1. LM Studio (Local OpenAI-compatible API) - Priority Default
  try {
    const res = await fetch(`${LMSTUDIO_BASE_URL}/models`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json();
      const rawList = data.data || [];
      const chatModels = rawList.filter((m) => !/(?:embedding|rerank)/i.test(m.id));
      for (const m of chatModels) {
        models.push({
          id: m.id,
          name: `LM Studio · ${m.id}`,
          provider: 'lmstudio',
          online: true,
          description: 'LM Studio 本地高性能模型'
        });
      }
    }
  } catch {}

  // 2. DeepSeek Cloud
  if (process.env.DEEPSEEK_API_KEY) {
    models.push({
      id: 'deepseek-chat',
      name: 'DeepSeek-V3 (云端极速)',
      provider: 'deepseek',
      online: true,
      description: '通用大模型，知识面广，推理快速'
    });
    models.push({
      id: 'deepseek-reasoner',
      name: 'DeepSeek-R1 (云端深度推理)',
      provider: 'deepseek',
      online: true,
      description: '深度思考推理模型，适合复杂分析'
    });
  }

  // 3. Ollama Local
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = await res.json();
      for (const m of (data.models || [])) {
        if (!/(?:embed|bge|e5|gte|mxbai|rerank|nomic)/i.test(m.name)) {
          models.push({
            id: m.name,
            name: `Ollama · ${m.name} (本地离线)`,
            provider: 'ollama',
            online: true,
            size: m.size ? `${(m.size / (1024 * 1024 * 1024)).toFixed(1)}GB` : ''
          });
        }
      }
    }
  } catch {}

  // 4. 自定义模型服务（不主动探测在线状态，连通性由「测试」按钮按需检查）
  for (const svc of loadCustomProviders()) {
    for (const mid of svc.models) {
      models.push({
        id: `custom:${svc.id}:${mid}`,
        name: `${svc.name} · ${mid} (自定义)`,
        provider: `custom:${svc.id}`,
        online: false
      });
    }
  }

  return models;
}

// 从已发现模型中挑选默认对话模型：优先 LM Studio，其次常见本地模型名，最后任取一个。
function defaultModelPreference() {
  const saved = readDotEnvValues();
  return String(saved.DEFAULT_LLM_MODEL ?? process.env.DEFAULT_LLM_MODEL ?? '').trim();
}

// LLM Wiki（本机 LLM Wiki 桌面应用的 HTTP API）配置：现读 .env，保存即生效。
// baseUrl 非空即启用；问答时把 Wiki 项目的检索结果并入素材（scope=llm-wiki）。
function llmWikiConfig() {
  const saved = readDotEnvValues();
  const pick = (key) => String(saved[key] ?? process.env[key] ?? CONFIG_DEFAULTS[key] ?? '').trim();
  const baseUrl = pick('LLM_WIKI_BASE_URL').replace(/\/+$/, '');
  return {
    baseUrl,
    token: pick('LLM_WIKI_API_TOKEN'),
    project: pick('LLM_WIKI_PROJECT') || 'current',
    enabled: !!baseUrl
  };
}

function llmWikiHeaders(extra = {}) {
  const cfg = llmWikiConfig();
  const headers = { ...extra };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  return headers;
}

function pickDefaultModel(allModels) {
  const preferred = defaultModelPreference();
  if (preferred && (allModels || []).some((m) => m.id === preferred)) return preferred;
  const models = (allModels || []).filter((m) => !String(m.provider || '').startsWith('custom:'));
  return models.find((m) => m.provider === 'lmstudio')?.id
    || ['qwen2.5:7b', 'qwen3.5:9b', 'qwen3:4b', 'llama3.1:8b'].map(p => models.find(m => m.id === p)).find(Boolean)?.id
    || models[0]?.id
    || '';
}

// Unified LLM Chat Invoker
// 对话补全超时（秒级大值：本机模型加载/长思考都可能较慢，但绝不能无限挂死）
const LLM_CHAT_TIMEOUT = 300000;

// 部分思考类模型（如 qwen3 系列）即使关闭 think 也会把 <think>…</think> 推理过程混进正文，
// 只在出现闭合标签时剥离，避免误伤正常模型；流式期间原始内容照常推送，最终答案以剥离后为准
function stripThinkText(text) {
  const s = String(text || '');
  const idx = s.indexOf('</think>');
  if (idx === -1) return s;
  return s.slice(idx + '</think>'.length).trimStart();
}

// 自定义网关经常整个服务离线（如远程中转关机/网络黑洞）。先做一次轻量探测，
// 连不上就在 2.5 秒内报错，而不是等完整对话请求挂满 5 分钟超时。
// 只把「网络层失败」视为不可达（/models 未实现返回 404 也说明服务在线）。
const gatewayHealth = new Map(); // baseUrl -> { failedAt, error }
async function assertGatewayReachable(svc) {
  const prev = gatewayHealth.get(svc.baseUrl);
  if (prev && Date.now() - prev.failedAt < 30000) {
    throw new Error(`模型服务「${svc.name}」当前无法连接（${prev.error}）。请检查服务是否在线后重试。`);
  }
  try {
    await fetch(`${svc.baseUrl}/models`, { signal: AbortSignal.timeout(2500) });
    gatewayHealth.delete(svc.baseUrl);
  } catch (e) {
    const msg = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? '连接超时' : String(e.message || e);
    gatewayHealth.set(svc.baseUrl, { failedAt: Date.now(), error: msg });
    throw new Error(`模型服务「${svc.name}」无法连接（${msg}）。请检查服务是否在线后重试。`);
  }
}

async function callLLM(opts) {
  try {
    return stripThinkText(await callLLMRaw(opts));
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('模型响应超时（5 分钟）：模型服务可能正忙或无响应，请稍后重试');
    }
    throw err;
  }
}

// 解析 OpenAI 兼容补全响应：标准 JSON 直接解析；部分网关/路由器（如 OmniRoute）
// 即使未请求流式也会强制返回 SSE 流（data: {...} 分块），此时累加各块的正文内容
function parseChatCompletionText(raw) {
  const text = String(raw || '');
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { /* 异常内容继续按流式解析 */ }
  }
  let content = '';
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    const payload = l.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(payload); } catch { continue; }
    const choice = (obj.choices || [])[0] || {};
    if (typeof choice.message?.content === 'string') content += choice.message.content;
    else if (typeof choice.delta?.content === 'string') content += choice.delta.content;
  }
  return { choices: [{ message: { content } }] };
}

async function callLLMRaw({ messages, model = '', provider = 'lmstudio' }) {
  // 自定义模型服务：model 形如 custom:<服务id>:<模型id>，或 provider 为 custom:<服务id>
  let customSvc = null;
  let innerModel = model;
  if (model.startsWith('custom:')) {
    const rest = model.slice('custom:'.length);
    const sep = rest.indexOf(':');
    customSvc = loadCustomProviders().find((s) => s.id === (sep === -1 ? rest : rest.slice(0, sep)));
    innerModel = sep === -1 ? '' : rest.slice(sep + 1);
  } else if (String(provider || '').startsWith('custom:')) {
    customSvc = loadCustomProviders().find((s) => s.id === provider.slice(7)) || null;
  }
  if (model.startsWith('custom:') || String(provider || '').startsWith('custom:')) {
    if (!customSvc) throw new Error('自定义模型服务不存在或已被删除');
    if (!innerModel) throw new Error(`服务「${customSvc.name}」未指定模型`);
    await assertGatewayReachable(customSvc);
    const headers = { 'Content-Type': 'application/json' };
    if (customSvc.apiKey) headers.Authorization = `Bearer ${customSvc.apiKey}`;
    const res = await fetch(`${customSvc.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: innerModel, messages, temperature: 0.2, stream: false }),
      signal: AbortSignal.timeout(LLM_CHAT_TIMEOUT)
    });
    const raw = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = JSON.parse(raw).error?.message || msg; } catch { /* 保留状态码信息 */ }
      throw new Error(`${customSvc.name} 错误: ${msg}`);
    }
    const data = parseChatCompletionText(raw);
    return data.choices?.[0]?.message?.content || '';
  }
  if (provider === 'lmstudio' || (!model.startsWith('deepseek') && !model.includes(':'))) {
    if (!model) model = pickDefaultModel(await getAvailableLLMs());
    if (!model) throw new Error('LM Studio 中没有可用模型，请先加载一个对话模型');
    const res = await fetch(`${LMSTUDIO_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        stream: false
      }),
      signal: AbortSignal.timeout(LLM_CHAT_TIMEOUT)
    });
    const raw = await res.text();
    if (!res.ok) {
      let errMsg = 'LM Studio 请求失败';
      try { errMsg = JSON.parse(raw).error?.message || errMsg; } catch { /* 保留默认信息 */ }
      throw new Error(`LM Studio 错误: ${errMsg}`);
    }
    const data = parseChatCompletionText(raw);
    return data.choices?.[0]?.message?.content || '';
  } else if (provider === 'deepseek' || model.startsWith('deepseek')) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY 未配置');
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        messages,
        temperature: 0.2
      }),
      signal: AbortSignal.timeout(LLM_CHAT_TIMEOUT)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'DeepSeek API 请求失败');
    return data.choices?.[0]?.message?.content || '';
  } else {
    // Ollama API
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        think: false,
        options: { num_ctx: 8192, temperature: 0.2 }
      }),
      signal: AbortSignal.timeout(LLM_CHAT_TIMEOUT)
    });
    const data = await res.json();
    if (!res.ok) {
      // Fallback to /api/generate
      const genRes = await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: messages.map((m) => `${m.role}: ${m.content}`).join('\n\n'),
          stream: false
        }),
        signal: AbortSignal.timeout(LLM_CHAT_TIMEOUT)
      });
      const genData = await genRes.json();
      if (!genRes.ok) throw new Error(genData.error || 'Ollama 请求失败');
      return genData.response || '';
    }
    return data.message?.content || '';
  }
}

// ============ 对话流式输出（SSE）：让回答逐字出现，而不是等完整生成 ============

// 把 fetch 响应体按行拆开（自动处理跨 chunk 截断的行）
async function* responseBodyLines(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      yield buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) yield buf;
}

// OpenAI 兼容流式响应（data: {...} / data: [DONE]）→ 逐段正文
async function* openAIDeltas(res) {
  for await (const line of responseBodyLines(res)) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    const payload = l.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(payload); } catch { continue; }
    const choice = (obj.choices || [])[0] || {};
    const piece = typeof choice.delta?.content === 'string'
      ? choice.delta.content
      : (typeof choice.message?.content === 'string' ? choice.message.content : '');
    if (piece) yield piece;
  }
}

// Ollama NDJSON 流（每行一个 JSON）→ 逐段正文
async function* ollamaDeltas(res) {
  for await (const line of responseBodyLines(res)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const piece = obj.message?.content;
    if (typeof piece === 'string' && piece) yield piece;
  }
}

async function streamLLM({ messages, model = '', provider = 'lmstudio', onDelta, signal }) {
  let customSvc = null;
  let innerModel = model;
  if (model.startsWith('custom:')) {
    const rest = model.slice('custom:'.length);
    const sep = rest.indexOf(':');
    customSvc = loadCustomProviders().find((s) => s.id === (sep === -1 ? rest : rest.slice(0, sep)));
    innerModel = sep === -1 ? '' : rest.slice(sep + 1);
  } else if (String(provider || '').startsWith('custom:')) {
    customSvc = loadCustomProviders().find((s) => s.id === provider.slice(7)) || null;
  }

  // OpenAI 兼容服务（custom / lmstudio / deepseek）：SSE 逐段读取；
  // 网关不支持流式而整体返回 JSON 时，一次性把全文发给前端
  const streamChatCompletions = async (url, headers, label) => {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: innerModel, messages, temperature: 0.2, stream: true }),
      signal
    });
    if (!res.ok) {
      const raw = await res.text();
      let msg = `HTTP ${res.status}`;
      try { msg = JSON.parse(raw).error?.message || msg; } catch { /* 保留状态码信息 */ }
      throw new Error(`${label} 错误: ${msg}`);
    }
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream')) {
      const data = parseChatCompletionText(await res.text());
      const full = data.choices?.[0]?.message?.content || '';
      if (full) onDelta(full);
      return full;
    }
    let text = '';
    for await (const piece of openAIDeltas(res)) { text += piece; onDelta(piece); }
    return text;
  };

  if (model.startsWith('custom:') || String(provider || '').startsWith('custom:')) {
    if (!customSvc) throw new Error('自定义模型服务不存在或已被删除');
    if (!innerModel) throw new Error(`服务「${customSvc.name}」未指定模型`);
    await assertGatewayReachable(customSvc);
    const headers = { 'Content-Type': 'application/json' };
    if (customSvc.apiKey) headers.Authorization = `Bearer ${customSvc.apiKey}`;
    return streamChatCompletions(`${customSvc.baseUrl}/chat/completions`, headers, customSvc.name);
  }
  if (provider === 'lmstudio' || (!model.startsWith('deepseek') && !model.includes(':'))) {
    if (!model) model = pickDefaultModel(await getAvailableLLMs());
    if (!model) throw new Error('LM Studio 中没有可用模型，请先加载一个对话模型');
    innerModel = model;
    return streamChatCompletions(`${LMSTUDIO_BASE_URL}/chat/completions`, { 'Content-Type': 'application/json' }, 'LM Studio');
  }
  if (provider === 'deepseek' || model.startsWith('deepseek')) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('DEEPSEEK_API_KEY 未配置');
    innerModel = model || 'deepseek-chat';
    return streamChatCompletions('https://api.deepseek.com/chat/completions', {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    }, 'DeepSeek');
  }
  // Ollama：/api/chat 流式失败时退回非流式（含 /api/generate 兜底），一次性发出
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true, think: false, options: { num_ctx: 8192, temperature: 0.2 } }),
    signal
  }).catch(() => null);
  if (!res || !res.ok) {
    const answer = await callLLMRaw({ messages, model, provider: 'ollama' });
    if (answer) onDelta(answer);
    return answer;
  }
  let text = '';
  for await (const piece of ollamaDeltas(res)) { text += piece; onDelta(piece); }
  return text;
}

function walk(dir, prefix = '') {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) walk(abs, rel);
    else if (entry.isFile() && /\.(md|canvas)$/i.test(entry.name)) {
      // 文件可能在 readdir 与 stat 之间被删除——跳过即可，不能让启动崩溃
      let stat;
      try { stat = fs.statSync(abs); } catch { continue; }
      if (entry.name.toLowerCase().endsWith('.md')) {
        let title = entry.name.replace(/\.md$/i, '');
        let tags = [];
        try {
          const sample = fs.readFileSync(abs, 'utf8').slice(0, 8000);
          const heading = sample.match(/^#\s+(.+)$/m);
          if (heading) title = heading[1].trim();
          tags = [...sample.matchAll(/(?:^|\s)#([\w\u4e00-\u9fff/-]+)/g)].map(m => m[1]);
        } catch {}
        notes.push({ path: rel.split(path.sep).join('/'), title, folder: path.dirname(rel).split(path.sep).join('/'), bytes: stat.size, mtime: stat.mtimeMs, tags: [...new Set(tags)].slice(0, 12) });
      }
    }
  }
}
walk(ROOT);
notes.sort((a, b) => b.mtime - a.mtime);

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function safeNotePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  if (!normalized.endsWith('.md') || parts.length === 0) return null;
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || SKIP.has(part))) {
    return null;
  }
  const requested = path.resolve(ROOT, normalized);
  const rootAbs = path.resolve(ROOT);
  return requested.startsWith(rootAbs + path.sep) ? requested : null;
}

function updateNoteInMemory(relPath, extraStats = {}) {
  const normalizedRel = String(relPath || '').replaceAll('\\', '/');
  const abs = safeNotePath(normalizedRel);
  if (!abs || !fs.existsSync(abs)) return;

  try {
    const stat = fs.statSync(abs);
    let title = path.basename(normalizedRel, '.md');
    let tags = extraStats.tags || [];
    if (!tags.length) {
      try {
        const sample = fs.readFileSync(abs, 'utf8').slice(0, 8000);
        const heading = sample.match(/^#\s+(.+)$/m);
        if (heading) title = heading[1].trim();
        tags = [...sample.matchAll(/(?:^|\s)#([\w\u4e00-\u9fff/-]+)/g)].map(m => m[1]);
      } catch {}
    }

    const noteItem = {
      path: normalizedRel,
      title: extraStats.title || title,
      folder: path.dirname(normalizedRel).split(path.sep).join('/'),
      bytes: stat.size,
      mtime: stat.mtimeMs,
      tags: [...new Set(tags)].slice(0, 12)
    };

    const existingIdx = notes.findIndex(n => n.path === normalizedRel);
    if (existingIdx !== -1) {
      notes.splice(existingIdx, 1);
    }
    notes.unshift(noteItem);
  } catch {}
}
function readVaultMarkdown(rel) {
  const abs = safeNotePath(rel);
  return abs && fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
}
function readNote(rel) {
  const abs = safeNotePath(rel);
  if (!abs || !fs.existsSync(abs)) return null;
  // 名为 xxx.md 的目录会让 readFileSync 抛 EISDIR——必须按文件处理
  try { if (!fs.statSync(abs).isFile()) return null; } catch { return null; }
  const content = fs.readFileSync(abs, 'utf8');
  const item = notes.find(n => n.path === rel);
  const links = [...content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map(m => m[1].trim()).slice(0, 80);
  const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => m[1].trim()).slice(0, 40);
  return { ...(item || { path: rel, title: path.basename(rel, '.md') }), content, links, headings };
}

// Obsidian 风格 [[wikilink]] 解析：文件名优先，其次精确标题；索引未命中时扫磁盘
// （启动后新建的笔记不在内存索引里，日记模板里的 gzh-topic-candidates 就属于这类）。
function pickWikiPath(candidates) {
  return candidates.slice().sort((a, b) => {
    const aArch = /\/archive\//i.test(a);
    const bArch = /\/archive\//i.test(b);
    if (aArch !== bArch) return aArch ? 1 : -1;
    return a.length - b.length || a.localeCompare(b);
  })[0] || null;
}

function findWikiByWalk(basenameMd) {
  const needle = String(basenameMd || '').toLowerCase();
  if (!needle) return null;
  const hits = [];
  const search = (dir, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) search(path.join(dir, entry.name), rel);
      else if (entry.isFile() && entry.name.toLowerCase() === needle) {
        hits.push(rel.split(path.sep).join('/'));
      }
    }
  };
  search(ROOT, '');
  return pickWikiPath(hits);
}

function resolveWikiLink(name) {
  const raw = String(name || '').trim().replaceAll('\\', '/').replace(/\.md$/i, '');
  if (!raw) return null;
  const withMd = `${raw}.md`;
  if (raw.includes('/')) {
    const abs = safeNotePath(withMd);
    if (abs && fs.existsSync(abs)) return withMd.replace(/^\/+/, '');
  }
  const needle = path.basename(withMd).toLowerCase();
  const byFile = notes.filter((n) => String(n.path || '').split('/').pop().toLowerCase() === needle).map((n) => n.path);
  if (byFile.length) return pickWikiPath(byFile);
  const titleNeedle = raw.toLowerCase();
  const byTitle = notes.filter((n) => String(n.title || '').toLowerCase() === titleNeedle).map((n) => n.path);
  if (byTitle.length) return pickWikiPath(byTitle);
  return findWikiByWalk(needle);
}
function parseInboxTasks() {
  const content = readVaultMarkdown(INBOX_REL);
  if (content === null) return [];
  const lines = content.split(/\r?\n/);
  return lines.map((line, index) => {
    const match = line.match(/^(\s*(?:[-*]|\d+\.)\s+\[)( |x|X|\/)(\]\s+)(.*)$/);
    if (!match) return null;
    const tail = match[4];
    const due = tail.match(/📅\s*(\d{4}-\d{2}-\d{2})/)?.[1] || '';
    const doneDate = tail.match(/✅\s*(\d{4}-\d{2}-\d{2})/)?.[1] || '';
    return { line: index, text: tail, done: match[2].toLowerCase() === 'x', status: match[2], due, doneDate, raw: line };
  }).filter(Boolean);
}
function writeInboxLines(lines) {
  writeMarkdown(INBOX_REL, lines.join('\n'));
}
function allowedWritePath(rel) {
  const normalized = String(rel || '').replaceAll('\\', '/');
  const parts = normalized.split('/');
  return normalized.endsWith('.md') && parts.length > 0 && !parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || SKIP.has(part));
}
function writeMarkdown(rel, content) {
  if (!allowedWritePath(rel)) throw new Error('Write path is not allowed');
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(path.resolve(ROOT) + path.sep)) throw new Error('Write path is not allowed');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = `${abs}.webtmp-${process.pid}`;
  fs.writeFileSync(temp, String(content || ''), 'utf8');
  fs.renameSync(temp, abs);
}
function readBody(req) {
  return new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 1000000) req.destroy(new Error('请求体过大（超过 1MB）')); }); req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } }); req.on('error', reject); });
}
function dateParts(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? match.slice(1) : null;
}
function dailyRelPath(value) {
  const parts = dateParts(value);
  if (!parts) return null;
  const [year, month, day] = parts;
  return DAILY_PATH_PATTERN
    .replaceAll('{YYYY}', year)
    .replaceAll('{MM}', month)
    .replaceAll('{DD}', day);
}
function fillDailyTemplate(template, value) {
  const [year, month, day] = value.split('-');
  // 支持 Obsidian 风格的 {{date:格式}} 占位符；时间部分默认 09:00（日记通常在白天补写）
  const format = (f) => String(f)
    .replaceAll('YYYY', year)
    .replaceAll('MM', month)
    .replaceAll('DD', day)
    .replaceAll('HH', '09')
    .replaceAll('mm', '00')
    .replaceAll('ss', '00');
  return String(template || DEFAULT_DAILY_TEMPLATE)
    .replace(/\{\{date:([^{}]+)\}\}/g, (_, f) => format(f))
    .replaceAll('{{date}}', value)
    .replaceAll('{{time}}', '09:00')
    .replaceAll('{{YYYY}}', year)
    .replaceAll('{{MM}}', month)
    .replaceAll('{{DD}}', day);
}
function dailyDateFromPath(rel) {
  const escaped = DAILY_PATH_PATTERN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace('\\{YYYY\\}', '(\\d{4})')
    .replace('\\{MM\\}', '(\\d{2})')
    .replace('\\{DD\\}', '(\\d{2})');
  const match = String(rel || '').match(new RegExp(`^${escaped}$`));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}
function dailyFor(value) {
  const rel = dailyRelPath(value);
  if (!rel) return null;
  const abs = safeNotePath(rel);
  let content = '';
  let exists = false;
  // 名为日期的目录会让 readFileSync 抛 EISDIR 崩溃，按文件处理
  if (abs && fs.existsSync(abs)) {
    try { exists = fs.statSync(abs).isFile(); } catch { exists = false; }
  }
  if (exists) content = fs.readFileSync(abs, 'utf8');
  else {
    content = fillDailyTemplate(dailyTemplateSettings().content, value);
  }
  return { path: rel, title: value, content, exists, generated: !exists, date: value };
}

// 复刻日记模板「今日笔记」Dataview 查询的语义：当天新建（birthtime）或文件名以日期开头的笔记，
// 排除 Daily/Archive 目录与日记本身，按创建时间倒序。Obsidian 靠 Dataview 插件实时查询，网页端自己算。
let dailyInsightsCache = { date: '', at: 0, data: null };
function dailyInsights(date) {
  if (dailyInsightsCache.date === date && Date.now() - dailyInsightsCache.at < 30000) return dailyInsightsCache.data;
  const collected = [];
  const collect = (dir, prefix) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) { collect(abs, rel); continue; }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      let stat;
      try { stat = fs.statSync(abs); } catch { continue; }
      const name = entry.name.replace(/\.md$/i, '');
      const folder = path.dirname(rel).split(path.sep).join('/');
      if (folder.includes('Daily') || folder.includes('Archive')) continue;
      if (name === date) continue; // 日记本身不算「今日笔记」
      const birth = new Date(stat.birthtimeMs);
      const createdDay = stat.birthtimeMs > 0
        ? `${birth.getFullYear()}-${String(birth.getMonth() + 1).padStart(2, '0')}-${String(birth.getDate()).padStart(2, '0')}`
        : '';
      if (createdDay !== date && !name.startsWith(date)) continue;
      collected.push({ rel: rel.split(path.sep).join('/'), name, ctime: stat.birthtimeMs || stat.mtimeMs });
    }
  };
  collect(ROOT, '');
  collected.sort((a, b) => b.ctime - a.ctime);
  const data = { date, notes: collected.slice(0, 50), total: collected.length };
  dailyInsightsCache = { date, at: Date.now(), data };
  return data;
}

function folderTreePayload() {
  const root = { name: '', path: '', count: 0, children: new Map() };
  for (const note of notes) {
    const parts = String(note.path || '').split('/').filter(Boolean);
    parts.pop();
    let node = root;
    for (const part of parts) {
      const childPath = node.path ? `${node.path}/${part}` : part;
      if (!node.children.has(part)) node.children.set(part, { name: part, path: childPath, count: 0, children: new Map() });
      node = node.children.get(part);
      node.count += 1;
    }
  }
  let totalFolders = 0;
  const serialize = (node) => {
    const children = [...node.children.values()]
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .map((child) => {
        totalFolders += 1;
        return serialize(child);
      });
    return { name: node.name, path: node.path, count: node.count, children };
  };
  return { folders: serialize(root).children, total: totalFolders };
}
// ===================== 📡 RSS 资讯聚合 =====================
// 内置默认源（feeds.json，随仓库分发）；用户在设置页配置的源存 data/feeds.json（gitignored，优先级更高）
const FEEDS_JSON = path.join(APP, 'feeds.json');
const USER_FEEDS_FILE = path.join(DATA_DIR, 'feeds.json');
const FEED_CACHE_FILE = path.join(DATA_DIR, 'feeds-cache.json');
const FEED_READ_FILE = path.join(DATA_DIR, 'feed-read.json');
const FEED_TTL = 30 * 60 * 1000;
const FEED_TIMEOUT = 15000;

function defaultFeeds() {
  return [
    { key: 'hn', name: 'Hacker News', url: 'https://hnrss.org/frontpage', max: 25 },
    { key: 'github-trending', name: 'GitHub Trending', url: 'https://mshibanami.github.io/GitHubTrendingRSS/daily.xml', max: 25 },
    { key: 'simonwillison', name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', max: 15 },
    { key: 'importai', name: 'Import AI', url: 'https://importai.substack.com/feed', max: 10 },
    { key: 'aibreakfast', name: 'AI Breakfast', url: 'https://aibreakfast.beehiiv.com/feed', max: 10 }
  ];
}

function loadFeedsConfig() {
  try {
    const user = JSON.parse(fs.readFileSync(USER_FEEDS_FILE, 'utf8'));
    if (Array.isArray(user) && user.length) return user;
  } catch { /* 无自定义源时回退内置默认 */ }
  try { return JSON.parse(fs.readFileSync(FEEDS_JSON, 'utf8')); } catch { return defaultFeeds(); }
}
function saveFeedsConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${USER_FEEDS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, USER_FEEDS_FILE);
}
// 设置页的源列表文本 ↔ 结构化配置。每行：名称 | URL | 每源条数（名称、条数可省略）
function parseFeedsText(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 50) throw new Error('RSS 源最多配置 50 个。');
  const seen = new Set();
  return lines.map((line, idx) => {
    const parts = line.split('|').map((p) => p.trim()).filter(Boolean);
    const url = parts.find((p) => /^https?:\/\//i.test(p));
    if (!url || parts.length > 3) throw new Error(`第 ${idx + 1} 行格式应为「名称 | URL | 条数」：${line}`);
    let host = '';
    try { host = new URL(url).hostname; } catch { throw new Error(`第 ${idx + 1} 行 URL 无效：${url}`); }
    const name = parts.find((p) => p !== url && !/^\d+$/.test(p)) || host;
    const maxPart = parts.find((p) => /^\d+$/.test(p));
    const max = maxPart ? Math.min(Math.max(Number(maxPart), 1), 50) : 20;
    let key = host.replace(/[^a-z0-9.-]/gi, '') || `feed-${idx + 1}`;
    let n = 2;
    while (seen.has(key)) key = `${key}-${n++}`;
    seen.add(key);
    return { key, name, url, max };
  });
}
function feedsToText(config) {
  return (config || []).map((f) => `${f.name} | ${f.url} | ${f.max || 20}`).join('\n');
}
function loadJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJsonFile(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 忽略 */ }
}
let feedCache = loadJsonFile(FEED_CACHE_FILE, { updatedAt: 0, feeds: {} });
// 形状防护：文件损坏/被改成别的结构时回退到空缓存，避免 feedCache.feeds 为 undefined 时崩溃
if (!feedCache || typeof feedCache !== 'object' || typeof feedCache.feeds !== 'object' || feedCache.feeds === null) {
  feedCache = { updatedAt: 0, feeds: {} };
}
let feedRead = loadJsonFile(FEED_READ_FILE, {});
if (!feedRead || typeof feedRead !== 'object') feedRead = {};

function decodeEntities(s) {
  return String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function extractField(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}
function extractLink(block) {
  const m1 = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (m1) return decodeEntities(m1[1]);
  const m2 = block.match(/<link\s+[^>]*href=["']([^"']+)["']/i);
  return m2 ? m2[1] : '';
}
function parseFeedXml(xml, feedName, maxItems) {
  const articles = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const blocks = items.length ? items : entries;
  const isAtom = !items.length && entries.length;
  for (const b of blocks.slice(0, maxItems)) {
    const title = extractField(b, 'title');
    const link = isAtom ? extractLink(b) : extractField(b, 'link');
    if (!title && !link) continue;
    const dateStr = isAtom ? (extractField(b, 'published') || extractField(b, 'updated')) : (extractField(b, 'pubDate') || extractField(b, 'dc:date') || extractField(b, 'date'));
    const pub = dateStr ? new Date(dateStr) : null;
    const summary = isAtom ? (extractField(b, 'summary') || extractField(b, 'content')) : extractField(b, 'description');
    const id = extractField(b, 'guid') || link || `${feedName}:${title}`;
    articles.push({ id, title, link, pubDate: (pub && !isNaN(pub)) ? pub.toISOString() : null, summary: (summary || '').slice(0, 300) });
  }
  return articles;
}
async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'
    },
    signal: AbortSignal.timeout(FEED_TIMEOUT)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const articles = parseFeedXml(xml, feed.name, feed.max || 20);
  if (!articles.length) throw new Error('未解析到文章');
  return articles;
}
async function refreshFeeds(force = false) {
  const config = loadFeedsConfig();
  const now = Date.now();
  const tasks = config.map(async (feed) => {
    const cached = feedCache.feeds[feed.key];
    if (!force && cached && cached.ok !== false && now - (cached.updatedAt || 0) < FEED_TTL) return;
    try {
      const articles = await fetchFeed(feed);
      feedCache.feeds[feed.key] = { ok: true, updatedAt: now, articles, error: null };
    } catch (error) {
      feedCache.feeds[feed.key] = { ok: false, updatedAt: now, error: error.message || String(error), articles: (cached && cached.articles) ? cached.articles : [] };
    }
  });
  await Promise.all(tasks);
  feedCache.updatedAt = now;
  saveJsonFile(FEED_CACHE_FILE, feedCache);
}
function feedsPayload() {
  const config = loadFeedsConfig();
  const sources = [];
  const articles = [];
  for (const feed of config) {
    const cached = feedCache.feeds[feed.key] || { ok: false, articles: [] };
    const read = feedRead[feed.key] || {};
    const unread = (cached.articles || []).filter((a) => !read[a.id]).length;
    sources.push({ key: feed.key, name: feed.name, url: feed.url, unread, ok: cached.ok !== false, error: cached.error || null, updatedAt: cached.updatedAt || 0 });
    for (const a of (cached.articles || [])) {
      articles.push({ id: a.id, key: feed.key, source: feed.name, title: a.title, link: a.link, pubDate: a.pubDate, summary: a.summary, read: !!read[a.id] });
    }
  }
  articles.sort((a, b) => {
    const da = a.pubDate || '2000-01-01'; const db = b.pubDate || '2000-01-01';
    return da < db ? 1 : da > db ? -1 : 0;
  });
  return { sources, articles: articles.slice(0, 250), updatedAt: feedCache.updatedAt };
}
function markFeedRead(payload) {
  const { key, id, all } = payload;
  if (all && key) { feedRead[key] = {}; }
  else if (all) { feedRead = {}; }
  else if (key && id) { if (!feedRead[key]) feedRead[key] = {}; feedRead[key][id] = true; }
  else if (id) {
    for (const f of loadFeedsConfig()) {
      if ((feedCache.feeds[f.key] || {}).articles && feedCache.feeds[f.key].articles.some((a) => a.id === id)) {
        if (!feedRead[f.key]) feedRead[f.key] = {};
        feedRead[f.key][id] = true;
        break;
      }
    }
  }
  saveJsonFile(FEED_READ_FILE, feedRead);
}
function saveRssInbox(title, link, source) {
  // 压平换行：条目按行存储/按行回读，带换行的字段会破坏文件结构
  const flat = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
  const line = `- [ ] 读：${flat(title)}（${flat(source)}）${flat(link)} #reading`;
  let content = readVaultMarkdown(RSS_INBOX_REL);
  if (content !== null) content = content.trimEnd();
  else content = '# RSS Read Later\n\n> Saved from VaultDesk feeds.\n';
  content += `\n${line}\n`;
  writeMarkdown(RSS_INBOX_REL, content);
  return RSS_INBOX_REL;
}

// 回读稍后读文件（与 saveRssInbox 行格式互逆），line 为文件行号用于完成/移除
function parseRssLater() {
  const content = readVaultMarkdown(RSS_INBOX_REL);
  if (content === null) return [];
  return content.split(/\r?\n/).map((line, index) => {
    const m = line.match(/^- \[( |x|X)\] 读：(.+)（([^（）]+)）(https?:\/\/\S+?)(?:\s+#\S+)?\s*$/);
    if (!m) return null;
    return { line: index, done: m[1].toLowerCase() === 'x', title: m[2].trim(), source: m[3].trim(), link: m[4], raw: line };
  }).filter(Boolean);
}

// ===================== 🧠 向量化语义检索 =====================
// 索引存储：data/vector-meta.json（元数据）+ data/vector-data.bin（float32 向量）
// 嵌入来源：Ollama /api/embed 或 LM Studio /v1/embeddings（OpenAI 兼容），零额外依赖。
const VECTOR_META_FILE = path.join(DATA_DIR, 'vector-meta.json');
const VECTOR_DATA_FILE = path.join(DATA_DIR, 'vector-data.bin');
const VECTOR_BATCH = 32;
const VECTOR_EMBED_TIMEOUT = 120000;
const VECTOR_CHECKPOINT_EVERY = 2000; // 每处理多少个文件落盘一次，中断/崩溃也不丢进度

const vectorStore = {
  meta: null,       // { root, provider, model, dim, files: {rel: {mtime, size, chunks:[{o,l,text,line,heading}]}}, updatedAt }
  vectors: null,    // Float32Array 缓存（行 = chunk 内第 o 个标量）
  status: { phase: 'idle', filesTotal: 0, filesDone: 0, chunksDone: 0, currentFile: '', error: null, skipped: [] },
  activeJob: null,  // { runId, stop: false }
  lastWatch: null,  // { rootAbs, watcher, pollTimer }
  pendingIncremental: false,
  lastIncrementalAt: 0
};

function loadVectorMeta() {
  if (vectorStore.meta) return vectorStore.meta;
  try { vectorStore.meta = JSON.parse(fs.readFileSync(VECTOR_META_FILE, 'utf8')); } catch { vectorStore.meta = null; }
  // 索引只属于构建它时的那个 vault。缺少 vaultRoot 的是旧格式索引，无法证明属于当前 vault，一律作废，
  // 避免换了 vault 后仍把旧 vault 的检索结果混进来。
  if (vectorStore.meta && vectorStore.meta.vaultRoot !== undefined) {
    if (path.resolve(vectorStore.meta.vaultRoot) !== path.resolve(ROOT)) {
      console.info(`[Vector] 已有向量索引属于其他 vault（${vectorStore.meta.vaultRoot}），与当前 vault（${ROOT}）不符，已忽略。可在设置中重建索引。`);
      vectorStore.meta = null;
    }
  } else if (vectorStore.meta) {
    console.info('[Vector] 检测到旧格式的向量索引，与当前 vault 归属关系未知，已忽略。可在设置中重建索引。');
    vectorStore.meta = null;
  }
  return vectorStore.meta;
}

// 索引覆盖的目录列表（新格式 roots 数组；兼容旧格式单 root 字段）
function metaRoots(meta) {
  if (!meta) return [];
  if (Array.isArray(meta.roots)) return meta.roots;
  return meta.root !== undefined ? [meta.root] : [];
}

function sameRoots(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((r, i) => r === b[i]);
}

// 规整多目录列表：非法路径丢弃、去重、去掉被父目录覆盖的子目录；空列表 = 整个 vault（['']）
function normalizeIndexRoots(input) {
  const list = (Array.isArray(input) ? input : [input]).map((r) => {
    try { return cleanRelPath(r, '') || ''; } catch { return null; }
  });
  const uniq = [...new Set(list.filter((r) => r !== null))];
  const kept = [];
  for (const r of uniq.sort((a, b) => a.length - b.length)) {
    if (kept.some((k) => k === '' || r === k || r.startsWith(k + '/'))) continue;
    kept.push(r);
  }
  return kept.length ? kept : [''];
}

function saveVectorMeta(meta) {
  vectorStore.meta = meta;
  vectorStore.vectors = null; // 元数据变化后强制重载向量缓存
  vectorStore.norms = null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${VECTOR_META_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(meta), 'utf8');
  fs.renameSync(tmp, VECTOR_META_FILE);
}

function saveVectorData(buf) {
  const tmp = `${VECTOR_DATA_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, buf, 'utf8');
  fs.renameSync(tmp, VECTOR_DATA_FILE);
}

function ensureVectorCache() {
  const meta = loadVectorMeta();
  if (!meta || !meta.dim) { vectorStore.vectors = null; vectorStore.norms = null; return null; }
  const count = vectorChunkCount(meta);
  if (vectorStore.vectors && vectorStore.vectors.length === count * meta.dim) return vectorStore.vectors;
  try {
    const buf = fs.readFileSync(VECTOR_DATA_FILE);
    vectorStore.vectors = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  } catch { vectorStore.vectors = null; }
  buildVectorNorms();
  return vectorStore.vectors;
}

// 每个 chunk 的范数只取决于向量数据本身，与查询无关——预计算一次后，
// 检索时只需逐 chunk 算点积，全库扫描可省约 40% 耗时（52 万块实测 1.44s → 0.84s）
function buildVectorNorms() {
  vectorStore.norms = null;
  const vectors = vectorStore.vectors;
  const meta = loadVectorMeta();
  if (!vectors || !meta || !meta.dim) return;
  const slots = Math.floor(vectors.length / meta.dim);
  const norms = new Float32Array(slots);
  for (let s = 0; s < slots; s++) {
    let nb = 0;
    const base = s * meta.dim;
    for (let d = 0; d < meta.dim; d++) { const v = vectors[base + d]; nb += v * v; }
    norms[s] = Math.sqrt(nb);
  }
  vectorStore.norms = norms;
}

function vectorChunkCount(meta) {
  let n = 0;
  for (const rel of Object.keys(meta.files || {})) n += meta.files[rel].chunks.length;
  return n;
}

function chunkText(text) {
  let body = String(text || '');
  if (body.startsWith('---')) body = body.replace(/^---[\s\S]*?---\s*/, '');
  const lines = body.split(/\r?\n/);
  const chunks = [];
  let current = [];
  let startLine = 1;
  let heading = '';
  const flush = () => {
    const merged = current.join(' ').replace(/\s+/g, ' ').trim();
    if (merged.length >= 8) chunks.push({ text: merged, line: startLine, heading });
    current = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) { flush(); heading = h[2].trim(); startLine = i + 1; continue; }
    if (/^```/.test(line.trim())) {
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) i += 1;
      continue;
    }
    if (line.trim() === '') { flush(); startLine = i + 2; continue; }
    current.push(line.trim());
    if (current.join(' ').length >= 1200) flush();
  }
  flush();
  return chunks;
}

async function embedTexts(provider, model, texts, retryDepth = 0) {
  const out = [];
  for (let i = 0; i < texts.length; i += VECTOR_BATCH) {
    const batch = texts.slice(i, i + VECTOR_BATCH);
    let vectors;
    try {
      vectors = await embedBatch(provider, model, batch);
    } catch (err) {
      // 超时/服务错误时把批次减半重试（最多 3 层），仍失败才抛出——
      // 大文件（如转换出的超长表格）容易让整批超时，拆小通常能过
      if (retryDepth < 3 && batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        const first = await embedTexts(provider, model, batch.slice(0, half), retryDepth + 1);
        const rest = await embedTexts(provider, model, batch.slice(half), retryDepth + 1);
        vectors = first.concat(rest);
      } else {
        throw err;
      }
    }
    if (vectors.length !== batch.length) throw new Error('嵌入服务返回数量与请求不一致');
    for (const v of vectors) {
      if (!Array.isArray(v) || !v.length) throw new Error('嵌入服务返回空向量');
      out.push(v);
    }
  }
  return out;
}

async function embedBatch(provider, model, batch) {
  if (String(provider).startsWith('custom:')) {
    const svc = loadCustomProviders().find((s) => s.id === provider.slice(7));
    if (!svc) throw new Error('自定义模型服务不存在或已被删除');
    const headers = { 'Content-Type': 'application/json' };
    if (svc.apiKey) headers.Authorization = `Bearer ${svc.apiKey}`;
    const res = await fetch(`${svc.baseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: batch }),
      signal: AbortSignal.timeout(VECTOR_EMBED_TIMEOUT)
    });
    if (!res.ok) throw new Error(`嵌入服务 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data.data || []).map((item) => item.embedding);
  }
  if (provider === 'lmstudio') {
    const res = await fetch(`${LMSTUDIO_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: batch }),
      signal: AbortSignal.timeout(VECTOR_EMBED_TIMEOUT)
    });
    if (!res.ok) throw new Error(`嵌入服务 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data.data || []).map((item) => item.embedding);
  }
  const res = await fetch('http://127.0.0.1:11434/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: batch }),
    signal: AbortSignal.timeout(VECTOR_EMBED_TIMEOUT)
  });
  if (!res.ok) throw new Error(`嵌入服务 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.embeddings || [];
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function vectorIndexFiles(rootRel) {
  const rootAbs = rootRel ? path.join(ROOT, rootRel) : ROOT;
  const files = [];
  const walkDir = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.join(prefix, entry.name);
      if (entry.isDirectory()) walkDir(abs, rel);
      else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
        try {
          const stat = fs.statSync(abs);
          if (stat.size <= 2 * 1024 * 1024) files.push({ abs, rel: rel.split(path.sep).join('/'), mtime: stat.mtimeMs, size: stat.size });
        } catch {}
      }
    }
  };
  walkDir(rootAbs, rootRel || '');
  return files;
}

// 多目录扫描并按 rel 去重（normalizeIndexRoots 已去嵌套，这里兜底）
function vectorIndexFilesOf(roots) {
  const seen = new Set();
  const out = [];
  for (const rootRel of (Array.isArray(roots) ? roots : [roots])) {
    for (const f of vectorIndexFiles(rootRel)) {
      if (seen.has(f.rel)) continue;
      seen.add(f.rel);
      out.push(f);
    }
  }
  return out;
}

// 断点落盘：把已嵌入的向量追加进数据文件并保存元数据（dataChunks 会被清空，偏移记录在 meta 中，不受影响）
function persistVectorProgress(nextMeta, dataChunks) {
  if (dataChunks.length) {
    let fd;
    try {
      fd = fs.openSync(VECTOR_DATA_FILE, 'a');
      for (const buf of dataChunks) fs.writeSync(fd, buf, 0, buf.length);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    dataChunks.length = 0;
  }
  nextMeta.updatedAt = Date.now();
  saveVectorMeta(nextMeta);
}

async function runIndexJob({ runId, roots, provider, model, mode }) {
  // stop()：任务被替换、被清空，或 /api/vector/stop 置了 stop 标志时为真
  const stop = () => !vectorStore.activeJob || vectorStore.activeJob.runId !== runId || vectorStore.activeJob.stop === true;
  const statusEl = vectorStore.status;
  let nextMeta = null;
  const dataChunks = [];
  try {
    statusEl.phase = 'scanning';
    statusEl.currentFile = '';
    statusEl.filesDone = 0;
    statusEl.chunksDone = 0;
    statusEl.error = null;
    statusEl.skipped = [];
    const files = vectorIndexFilesOf(roots);
    const meta = loadVectorMeta();
    // 已存在同目录 + 同模型的索引则继承：未变更的文件不重复嵌入——
    // 全量重建因此可以「断点续传」（中断后重新点开始即从上次进度继续），增量更新只处理变化文件
    const inherited = !!(meta && sameRoots(metaRoots(meta), roots) && meta.provider === provider && meta.model === model);
    nextMeta = inherited
      ? { ...meta, files: { ...(meta.files || {}) } }
      : { roots, provider, model, dim: 0, files: {}, totalChunks: 0, updatedAt: Date.now(), vaultRoot: ROOT };
    normalizeChunkPids(nextMeta);

    const changed = [];
    let unchanged = 0;
    if (mode === 'incremental' || inherited) {
      for (const f of files) {
        const cur = nextMeta.files[f.rel];
        if (!cur || cur.mtime !== f.mtime || cur.size !== f.size) changed.push(f);
        else unchanged += 1;
      }
      const fileSet = new Set(files.map((f) => f.rel));
      for (const rel of Object.keys(nextMeta.files)) {
        if (!fileSet.has(rel)) changed.push({ rel, abs: path.join(ROOT, rel), mtime: 0, size: 0, deleted: true });
      }
    } else {
      changed.push(...files);
    }
    statusEl.filesTotal = changed.length;
    if (unchanged) console.info(`[Vector] ${unchanged} 个文件无变化，跳过重复嵌入`);

    let orphanSlots = 0;
    let sinceCheckpoint = 0;
    const qdrantDeleteIds = []; // 被 re-embed/删除文件的旧点位，从 Qdrant 同步移除
    for (const f of changed) {
      if (stop()) {
        persistVectorProgress(nextMeta, dataChunks);
        statusEl.phase = 'stopped';
        return { ok: false, stopped: true };
      }
      statusEl.currentFile = f.rel;
      if (f.deleted) {
        const old = nextMeta.files[f.rel];
        if (old) {
          orphanSlots += old.chunks.length;
          for (const c of old.chunks) if (c.p !== undefined) qdrantDeleteIds.push(c.p);
          delete nextMeta.files[f.rel];
        }
        statusEl.filesDone += 1;
        continue;
      }
      statusEl.phase = 'embedding';
      let text;
      try { text = fs.readFileSync(f.abs, 'utf8'); } catch { statusEl.filesDone += 1; continue; }
      const chunks = chunkText(text);
      if (!chunks.length) { nextMeta.files[f.rel] = { mtime: f.mtime, size: f.size, chunks: [] }; statusEl.filesDone += 1; continue; }
      let vectors;
      try { vectors = await embedTexts(provider, model, chunks.map((c) => c.text)); }
      catch (err) {
        if (stop()) {
          persistVectorProgress(nextMeta, dataChunks);
          statusEl.phase = 'stopped';
          return { ok: false, stopped: true };
        }
        // 单个文件失败（超大文件、嵌入服务偶发超时等）记录后跳过，不让它毁掉整个索引任务
        if (statusEl.skipped.length < 100) statusEl.skipped.push({ rel: f.rel, error: String(err.message || err) });
        console.warn(`[Vector] 嵌入失败，跳过 ${f.rel}: ${err.message}`);
        statusEl.filesDone += 1;
        continue;
      }
      if (!nextMeta.dim) nextMeta.dim = vectors[0]?.length || 0;
      else if (vectors[0]?.length !== nextMeta.dim) {
        persistVectorProgress(nextMeta, dataChunks);
        statusEl.phase = 'error';
        statusEl.error = `向量维度(${vectors[0].length})与索引维度(${nextMeta.dim})不一致，请更换模型或清空索引后重建`;
        return { ok: false, error: statusEl.error };
      }
      const old = nextMeta.files[f.rel];
      if (old && old.chunks.length) {
        orphanSlots += old.chunks.length;
        for (const c of old.chunks) if (c.p !== undefined) qdrantDeleteIds.push(c.p);
      }
      const record = [];
      for (let c = 0; c < chunks.length; c++) {
        const buf = Buffer.alloc(4 * nextMeta.dim);
        for (let d = 0; d < nextMeta.dim; d++) buf.writeFloatLE(Number(vectors[c][d]) || 0, d * 4);
        record.push({ o: nextMeta.totalChunks * nextMeta.dim, l: nextMeta.dim, text: chunks[c].text, line: chunks[c].line, heading: chunks[c].heading, p: nextMeta.nextPid++ });
        dataChunks.push(buf);
        nextMeta.totalChunks += 1;
        statusEl.chunksDone += 1;
      }
      nextMeta.files[f.rel] = { mtime: f.mtime, size: f.size, chunks: record };
      statusEl.filesDone += 1;
      // Qdrant 已配置时边索引边推送新点位（熔断保护下失败即弃，由后台对账补齐）
      if (qdrantUrl()) {
        for (let c = 0; c < chunks.length; c++) {
          qdrantUpsertQueue.push({ id: record[c].p, vector: vectors[c], payload: { rel: f.rel, o: record[c].o, root: f.rel.split('/')[0] } });
        }
        await qdrantFlushUpserts();
      }
      sinceCheckpoint += 1;
      if (sinceCheckpoint >= VECTOR_CHECKPOINT_EVERY) {
        sinceCheckpoint = 0;
        persistVectorProgress(nextMeta, dataChunks);
      }
    }

    statusEl.phase = 'saving';
    persistVectorProgress(nextMeta, dataChunks);
    await qdrantFlushUpserts();
    if (qdrantDeleteIds.length) qdrantDeletePoints(qdrantDeleteIds).catch((e) => console.warn('[Qdrant] 点位删除失败（后台同步会自动补齐）:', e.message || e));
    if (orphanSlots > 0 && orphanSlots > (statusEl.filesTotal || 1) * 200) {
      compactVectorData(nextMeta);
    }
    statusEl.phase = 'done';
    statusEl.currentFile = '';
    return { ok: true, files: files.length, chunks: vectorChunkCount(nextMeta), changed: changed.length };
  } catch (err) {
    // 意外错误也尽量保住已嵌入的内容
    try { if (nextMeta) persistVectorProgress(nextMeta, dataChunks); } catch { /* 保存失败则维持原索引 */ }
    statusEl.phase = 'error';
    statusEl.error = err.message || String(err);
    return { ok: false, error: statusEl.error };
  } finally {
    vectorStore.activeJob = null;
  }
}

function compactVectorData(meta) {
  try {
    const vectors = ensureVectorCache();
    if (!vectors) return;
    const out = Buffer.alloc(Math.max(1, vectorChunkCount(meta)) * meta.dim * 4);
    let offset = 0;
    for (const rel of Object.keys(meta.files || {})) {
      for (const chunk of (meta.files[rel] && meta.files[rel].chunks) || []) {
        for (let d = 0; d < meta.dim; d++) out.writeFloatLE(vectors[chunk.o + d] || 0, offset + d * 4);
        chunk.o = Math.floor(offset / 4);
        offset += meta.dim * 4;
      }
    }
    saveVectorData(out.subarray(0, offset));
    saveVectorMeta(meta);
  } catch (e) { console.error('[Vector Compaction Error]', e); }
}

// ============ 🧭 Qdrant 可选加速后端（.env QDRANT_URL，留空 = 不启用） ============
// 边界说明：Qdrant 只加速「向量检索」这一步（HNSW 近似最近邻，52 万块毫秒级返回），
// 嵌入仍由原服务（Ollama/LM Studio/自定义）计算，回答耗时仍由对话大模型决定。
// 本地 vector-data.bin 始终是权威数据源；Qdrant 只是可重建的加速副本，任何失败都回退本地扫描。
const QDRANT_COLLECTION = 'vaultdesk';
const qdrantSync = { running: false, done: 0, total: 0, error: null };
const qdrantCircuit = { fails: 0, openUntil: 0 }; // 连续失败后熔断 60s，避免索引任务被挂起的网络请求拖慢
const qdrantUpsertQueue = [];

function qdrantUrl() {
  return String(readDotEnvValues().QDRANT_URL || process.env.QDRANT_URL || '').trim().replace(/\/+$/, '');
}

async function qdrantFetch(pathname, opts = {}, timeout = 8000) {
  const base = qdrantUrl();
  if (!base) throw new Error('Qdrant 未配置');
  const res = await fetch(`${base}${pathname}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body,
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error(`Qdrant HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json().catch(() => ({}));
}

async function qdrantCount() {
  const d = await qdrantFetch(`/collections/${QDRANT_COLLECTION}/points/count`, { method: 'POST', body: '{}' }, 3000);
  const count = d.result && d.result.count;
  return typeof count === 'number' ? count : -1;
}

// 集合不存在或维度不符时（重）建；已存在且维度一致则原样保留
async function qdrantEnsureCollection(dim) {
  let existing = null;
  try {
    const d = await qdrantFetch(`/collections/${QDRANT_COLLECTION}`, {}, 4000);
    existing = d.result || null;
  } catch (e) {
    if (!/HTTP 404/.test(String(e.message || e))) throw e;
  }
  if (existing) {
    const v = existing.config && existing.config.params && existing.config.params.vectors;
    const size = typeof v === 'number' ? v : v && v.size;
    if (size === dim) return;
    await qdrantFetch(`/collections/${QDRANT_COLLECTION}`, { method: 'DELETE' }, 30000);
  }
  await qdrantFetch(`/collections/${QDRANT_COLLECTION}`, {
    method: 'PUT',
    body: JSON.stringify({ vectors: { size: dim, distance: 'Cosine' } })
  }, 30000);
}

async function qdrantDropCollection() {
  try { await qdrantFetch(`/collections/${QDRANT_COLLECTION}`, { method: 'DELETE' }, 30000); }
  catch (e) { if (!/HTTP 404/.test(String(e.message || e))) console.warn('[Qdrant]', e.message || e); }
}

function qdrantUpsertPoints(points) {
  return qdrantFetch(`/collections/${QDRANT_COLLECTION}/points?wait=false`, {
    method: 'PUT',
    body: JSON.stringify({ points })
  }, 30000);
}

function qdrantDeletePoints(ids) {
  if (!ids.length) return Promise.resolve();
  // wait=true：删除量极小，同步等待可避免与后台对账同步竞态产生残留点位
  return qdrantFetch(`/collections/${QDRANT_COLLECTION}/points/delete?wait=true`, {
    method: 'POST',
    body: JSON.stringify({ points: ids })
  }, 30000);
}

// 点位 id（uint64）分配：写入 meta.chunk.p，跨增量重建保持稳定
function normalizeChunkPids(meta) {
  if (meta.nextPid !== undefined) return meta;
  let max = -1;
  for (const f of Object.values(meta.files || {})) {
    for (const c of f.chunks) if (c.p > max) max = c.p;
  }
  meta.nextPid = max + 1;
  return meta;
}

function assignChunkPids(meta) {
  normalizeChunkPids(meta);
  let changed = false;
  for (const f of Object.values(meta.files || {})) {
    for (const c of f.chunks) {
      if (c.p === undefined) { c.p = meta.nextPid++; changed = true; }
    }
  }
  if (changed) saveVectorMeta(meta);
}

// 索引任务边嵌入边推送（每文件一次，最多 256 点/请求）；Qdrant 不可用时熔断并丢弃队列，
// 交给基于点位数对账的后台同步补齐——绝不因 Qdrant 故障拖慢或破坏本地索引
async function qdrantFlushUpserts() {
  if (!qdrantUpsertQueue.length) return;
  if (!qdrantUrl() || Date.now() < qdrantCircuit.openUntil) { qdrantUpsertQueue.length = 0; return; }
  while (qdrantUpsertQueue.length) {
    const batch = qdrantUpsertQueue.splice(0, 256);
    try {
      await qdrantUpsertPoints(batch);
      qdrantCircuit.fails = 0;
    } catch (e) {
      qdrantCircuit.fails += 1;
      if (qdrantCircuit.fails >= 2) qdrantCircuit.openUntil = Date.now() + 60000;
      qdrantUpsertQueue.length = 0;
      console.warn('[Qdrant] 增量写入失败（后台同步会自动补齐）:', e.message || e);
      return;
    }
  }
}

// 后台对账同步：把本地全部向量补推到 Qdrant（按点位 id 幂等覆盖），
// 远端多出的残留点位（本地已删除）通过重建集合清除。首次全量 52 万块约需几分钟。
async function qdrantSyncJob() {
  if (!qdrantUrl() || qdrantSync.running || vectorStore.activeJob) return;
  const meta = normalizeChunkPids(loadVectorMeta() || {});
  const vectors = ensureVectorCache();
  if (!meta || !meta.dim || !vectors) return;
  qdrantSync.running = true;
  qdrantSync.error = null;
  qdrantSync.done = 0;
  try {
    assignChunkPids(meta);
    const total = vectorChunkCount(meta);
    qdrantSync.total = total;
    await qdrantEnsureCollection(meta.dim);
    let remote = await qdrantCount();
    if (remote > total) {
      await qdrantDropCollection();
      await qdrantEnsureCollection(meta.dim);
      remote = 0;
    }
    if (remote < total) {
      const batch = [];
      for (const rel of Object.keys(meta.files || {})) {
        for (const c of meta.files[rel].chunks) {
          if (c.p === undefined) continue;
          batch.push({
            id: c.p,
            vector: Array.from(vectors.subarray(c.o, c.o + meta.dim)),
            payload: { rel, o: c.o, root: rel.split('/')[0] }
          });
          if (batch.length >= 256) {
            await qdrantUpsertPoints(batch);
            qdrantSync.done += batch.length;
            batch.length = 0;
          }
        }
      }
      if (batch.length) { await qdrantUpsertPoints(batch); qdrantSync.done += batch.length; }
    }
    console.info(`[Qdrant] 同步完成：${total} 个点位 @ ${qdrantUrl()}`);
  } catch (e) {
    qdrantSync.error = e.message || String(e);
    console.warn('[Qdrant Sync]', qdrantSync.error);
  } finally {
    qdrantSync.running = false;
  }
}

async function qdrantStatusPayload() {
  const url = qdrantUrl();
  const base = { url, configured: !!url, syncing: qdrantSync.running, synced: qdrantSync.done, syncTotal: qdrantSync.total, error: qdrantSync.error };
  if (!url) return { ...base, ok: false };
  try {
    const meta = loadVectorMeta();
    return { ...base, ok: true, points: await qdrantCount(), local: meta ? vectorChunkCount(meta) : 0 };
  } catch (e) {
    return { ...base, ok: false, error: e.message || String(e) };
  }
}

// Qdrant 上的语义检索：顶层目录前缀（问答「检索范围」的取值形态）转为 root 字段过滤，
// 更深的前缀 Qdrant 不支持 starts_with，改为超量取回后本地过滤
async function searchSemanticQdrant(qv, meta, { prefix = '', limit = 5 }) {
  const deepPrefix = prefix && prefix.includes('/');
  const filter = prefix && !deepPrefix
    ? { must: [{ key: 'root', match: { value: prefix } }] }
    : undefined;
  const want = deepPrefix ? Math.min(limit * 8, 100) : limit;
  const d = await qdrantFetch(`/collections/${QDRANT_COLLECTION}/points/search`, {
    method: 'POST',
    body: JSON.stringify({ vector: Array.from(qv), limit: want, with_payload: true, filter })
  }, 5000);
  const out = [];
  for (const p of d.result || []) {
    const rel = p.payload && p.payload.rel;
    const file = rel ? meta.files[rel] : null;
    if (!file) continue;
    if (prefix && !rel.startsWith(prefix)) continue;
    const chunk = file.chunks.find((c) => c.o === (p.payload && p.payload.o));
    if (!chunk) continue;
    out.push({ rel, line: chunk.line, text: chunk.text, heading: chunk.heading, score: p.score });
    if (out.length >= limit) break;
  }
  return out;
}

// ============ 📥 文档导入（ANYDOC 转换为 Markdown） ============
// 把一个或多个外部文件夹中的文档（含子文件夹）转换为 Markdown 导入 vault；
// 可选定时监控：周期性扫描源文件夹，新增/修改的文件自动增量转换导入。
// 转换依赖安装了 firecrawl-anydoc 的 Python 环境（自动探测，可用 .env 的
// DOC_IMPORT_PYTHON 指定解释器）；.md/.txt/.csv 无 Python 也能原样导入。
const IMPORT_SOURCES_FILE = path.join(DATA_DIR, 'doc-import-sources.json');
const IMPORT_STATE_FILE = path.join(DATA_DIR, 'doc-import-state.json');
const IMPORT_SUPPORTED_EXTS = new Set(['.md', '.txt', '.csv', '.docx', '.doc', '.wps', '.xlsx', '.xls', '.pptx', '.pdf']);
const IMPORT_EXCLUDE_DIRS = new Set(['.git', '.svn', '.hg', '__pycache__', 'node_modules', '.obsidian', '.trash']);
const IMPORT_PY_SCRIPT = 'import sys\nfrom anydoc import to_markdown\nmd = to_markdown(sys.argv[1])\nsys.stdout.write(md if isinstance(md, str) else str(md))';

const importStore = {
  sources: [],      // [{ id, dir, target, watch, interval }]
  state: { files: {}, lastRuns: {} },
  activeJob: null,  // { id, stop, status: {...} }
  python: null,     // { path, anydoc, checkedAt }
  timer: null
};

function loadImportConfig() {
  const src = loadJsonFile(IMPORT_SOURCES_FILE, { sources: [] });
  importStore.sources = (src && Array.isArray(src.sources)) ? src.sources : [];
  const st = loadJsonFile(IMPORT_STATE_FILE, { files: {}, lastRuns: {} });
  importStore.state = {
    files: (st && typeof st.files === 'object' && st.files) ? st.files : {},
    lastRuns: (st && typeof st.lastRuns === 'object' && st.lastRuns) ? st.lastRuns : {}
  };
}
function saveImportSources() { saveJsonFile(IMPORT_SOURCES_FILE, { sources: importStore.sources }); }
function saveImportState() { saveJsonFile(IMPORT_STATE_FILE, importStore.state); }

// 探测可用的 Python 转换环境（结果缓存 10 分钟）：
// 依次尝试 .env DOC_IMPORT_PYTHON → <vault>/00_META/venv/work-doc-convert/bin/python → python3
function detectImportPython(force = false) {
  const cached = importStore.python;
  if (!force && cached && Date.now() - cached.checkedAt < 600000) return Promise.resolve(cached);
  const candidates = [];
  const cfg = String(readDotEnvValues().DOC_IMPORT_PYTHON || '').trim();
  if (cfg) candidates.push(cfg);
  candidates.push(path.join(ROOT, '00_META', 'venv', 'work-doc-convert', 'bin', 'python'));
  candidates.push('python3');
  const probe = (p, code) => new Promise((resolve) => {
    try { execFile(p, ['-c', code], { timeout: 10000 }, (err) => resolve(!err)); }
    catch { resolve(false); }
  });
  return (async () => {
    for (const p of candidates) {
      if (await probe(p, 'import anydoc')) {
        importStore.python = { path: p, anydoc: true, checkedAt: Date.now() };
        return importStore.python;
      }
    }
    const plain = await probe('python3', 'print(1)');
    importStore.python = { path: plain ? 'python3' : '', anydoc: false, checkedAt: Date.now() };
    return importStore.python;
  })();
}

function scanImportSource(source) {
  const out = [];
  const walkDir = (absDir, rel) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('~$') || IMPORT_EXCLUDE_DIRS.has(e.name)) continue;
      const abs = path.join(absDir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walkDir(abs, r);
      else if (e.isFile() && IMPORT_SUPPORTED_EXTS.has(path.extname(e.name).toLowerCase())) out.push({ rel: r, abs });
    }
  };
  walkDir(source.dir, '');
  return out;
}

function importOutRel(source, file) {
  const relMd = file.rel.replace(/\.[^.]+$/, '') + '.md';
  let target = '';
  try { target = cleanRelPath(source.target, '') || ''; } catch { target = ''; }
  return target ? `${target}/${relMd}` : relMd;
}

function convertImportFile(file, python) {
  const ext = path.extname(file.rel).toLowerCase();
  if (ext === '.md' || ext === '.txt' || ext === '.csv') {
    return Promise.resolve(fs.readFileSync(file.abs, 'utf8'));
  }
  if (!python || !python.anydoc) {
    return Promise.reject(new Error('需要安装了 firecrawl-anydoc 的 Python 环境才能转换该格式'));
  }
  return new Promise((resolve, reject) => {
    execFile(python.path, ['-c', IMPORT_PY_SCRIPT, file.abs], { timeout: 180000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message || err).trim().slice(0, 300)));
      resolve(String(stdout));
    });
  });
}

// 重建笔记索引，让新导入的文件立刻出现在列表/统计/关键词检索中
function rebuildNotes() {
  notes = [];
  walk(ROOT);
}

async function runImportSource(sourceId, { trigger = 'manual' } = {}) {
  if (importStore.activeJob) throw new Error('已有导入任务在运行');
  const source = importStore.sources.find((s) => s.id === sourceId);
  if (!source) throw new Error('导入源不存在');
  if (!fs.existsSync(source.dir) || !fs.statSync(source.dir).isDirectory()) throw new Error(`源文件夹不存在：${source.dir}`);
  const python = await detectImportPython();
  const status = { sourceId, trigger, phase: 'scanning', filesTotal: 0, filesDone: 0, converted: 0, skipped: 0, failed: 0, errors: [], currentFile: '' };
  importStore.activeJob = { id: sourceId, stop: false, status };
  try {
    const files = scanImportSource(source);
    status.phase = 'importing';
    status.filesTotal = files.length;
    let stateDirty = false;
    for (const f of files) {
      if (!importStore.activeJob || importStore.activeJob.stop) { status.phase = 'stopped'; break; }
      status.currentFile = f.rel;
      const key = `${sourceId}|${f.rel}`;
      let st;
      try { st = fs.statSync(f.abs); } catch { status.filesDone += 1; continue; }
      const prev = importStore.state.files[key];
      // 未变化（同大小同修改时间且上次成功）的文件跳过——增量导入的基础
      if (prev && prev.status === 'ok' && prev.mtime === st.mtimeMs && prev.size === st.size) {
        status.skipped += 1;
        status.filesDone += 1;
        continue;
      }
      try {
        const md = await convertImportFile(f, python);
        const outRel = importOutRel(source, f);
        const front = `---\nsource: "${f.abs}"\nconverted_at: ${new Date().toISOString()}\nformat: ${path.extname(f.rel).replace('.', '')}\n---\n\n`;
        writeMarkdown(outRel, `${front}${String(md).trim()}\n`);
        importStore.state.files[key] = { mtime: st.mtimeMs, size: st.size, out: outRel, status: 'ok', updatedAt: Date.now() };
        status.converted += 1;
        stateDirty = true;
      } catch (err) {
        importStore.state.files[key] = { mtime: st.mtimeMs, size: st.size, status: 'error', error: String(err.message || err).slice(0, 200), updatedAt: Date.now() };
        status.failed += 1;
        if (status.errors.length < 20) status.errors.push({ rel: f.rel, error: String(err.message || err).slice(0, 200) });
        stateDirty = true;
        console.warn(`[DocImport] 转换失败 ${f.rel}: ${err.message}`);
      }
      status.filesDone += 1;
      if (stateDirty && status.filesDone % 20 === 0) { saveImportState(); stateDirty = false; }
    }
    if (status.phase === 'importing') status.phase = 'done';
    importStore.state.lastRuns[sourceId] = {
      at: Date.now(), trigger, total: status.filesTotal,
      ok: status.converted, skipped: status.skipped, failed: status.failed,
      error: status.errors[0] ? status.errors[0].error : ''
    };
    saveImportState();
    if (status.converted > 0) rebuildNotes();
    console.info(`[DocImport] ${trigger === 'watch' ? '定时' : '手动'}导入完成 ${source.dir}：共 ${status.filesTotal} 文件（转换 ${status.converted} / 跳过 ${status.skipped} / 失败 ${status.failed}）`);
    return status;
  } finally {
    importStore.activeJob = null;
  }
}

// 定时监控调度：每 30 秒检查一次，到点且空闲就导入下一个启用了监控的源（串行，一次一个）
function startImportTicker() {
  if (importStore.timer) return;
  importStore.timer = setInterval(() => {
    if (importStore.activeJob) return;
    const now = Date.now();
    for (const s of importStore.sources) {
      if (!s.watch) continue;
      const lastAt = (importStore.state.lastRuns[s.id] && importStore.state.lastRuns[s.id].at) || 0;
      const everyMs = Math.max(60, Number(s.interval) || 300) * 1000;
      if (now - lastAt >= everyMs) {
        runImportSource(s.id, { trigger: 'watch' }).catch((e) => console.warn('[DocImport] 定时导入失败:', e.message));
        break;
      }
    }
  }, 30000);
  importStore.timer.unref && importStore.timer.unref();
}

function importStatusPayload() {
  const running = importStore.activeJob ? importStore.activeJob.status : null;
  const sources = importStore.sources.map((s) => {
    const last = importStore.state.lastRuns[s.id] || null;
    let indexed = 0, broken = 0;
    for (const key of Object.keys(importStore.state.files)) {
      if (!key.startsWith(`${s.id}|`)) continue;
      const rec = importStore.state.files[key];
      if (rec && rec.status === 'ok') indexed += 1;
      else broken += 1;
    }
    return { ...s, lastRun: last, indexed, broken };
  });
  return { python: importStore.python, running, sources };
}

loadImportConfig();
startImportTicker();


function vectorWatchSetup(roots) {
  try {
    const list = (Array.isArray(roots) ? roots : [roots]).map((r) => String(r || ''));
    const prev = vectorStore.lastWatch;
    if (prev && prev.roots && prev.roots.length === list.length && list.every((r) => prev.roots.includes(r))) return;
    if (prev && prev.watches) {
      for (const w of prev.watches.values()) {
        try { w.watcher && w.watcher.close(); } catch {}
        if (w.pollTimer) clearInterval(w.pollTimer);
      }
    }
    const watches = new Map();
    for (const rootRel of list) {
      const rootAbs = path.join(ROOT, rootRel);
      let watcher = null;
      try { watcher = fs.watch(rootAbs, { recursive: true }, () => scheduleIncremental(rootRel)); } catch { watcher = null; }
      const pollTimer = watcher ? null : setInterval(() => scheduleIncremental(rootRel), 30000);
      watches.set(rootRel, { watcher, pollTimer });
    }
    vectorStore.lastWatch = { roots: list, watches };
  } catch (e) { console.error('[Vector Watch Error]', e); }
}

function scheduleIncremental(rootRel) {
  if (!loadVectorMeta() || vectorStore.activeJob) return;
  if (Date.now() - vectorStore.lastIncrementalAt < 800) {
    vectorStore.pendingIncremental = true;
    return;
  }
  const meta = loadVectorMeta();
  if (!meta || !metaRoots(meta).includes(String(rootRel || ''))) return;
  vectorStore.lastIncrementalAt = Date.now();
  vectorStore.activeJob = { runId: Date.now() + Math.random(), stop: false };
  vectorStore.status.phase = 'incremental';
  vectorStore.status.currentFile = '';
  runIndexJob({ runId: vectorStore.activeJob.runId, roots: metaRoots(meta), provider: meta.provider, model: meta.model, mode: 'incremental' }).then(() => {
    if (vectorStore.pendingIncremental) {
      vectorStore.pendingIncremental = false;
      setTimeout(() => scheduleIncremental(rootRel), 300);
    }
  });
}

function vectorStatusPayload() {
  const meta = loadVectorMeta();
  const status = vectorStore.status;
  const watching = !!(vectorStore.lastWatch && vectorStore.lastWatch.watches && [...vectorStore.lastWatch.watches.values()].some((w) => w.watcher || w.pollTimer));
  return {
    status,
    watching,
    config: meta ? { roots: metaRoots(meta), provider: meta.provider, model: meta.model, dim: meta.dim } : null,
    files: meta ? Object.keys(meta.files || {}).length : 0,
    chunks: meta ? vectorChunkCount(meta) : 0,
    updatedAt: meta ? meta.updatedAt : 0
  };
}

async function searchSemantic(query, { prefix = '', limit = 5 } = {}) {
  const meta = loadVectorMeta();
  if (!meta || !query) return [];
  let qv;
  try { qv = (await embedTexts(meta.provider, meta.model, [String(query)]))[0]; }
  catch { return []; }
  // Qdrant 优先：命中即返回，完全不必把 2GB 本地向量缓存载入内存（低内存机器尤为关键）；
  // 失败或尚未就绪则回退本地全量扫描
  if (qdrantUrl() && !qdrantSync.running) {
    try {
      const hits = await searchSemanticQdrant(qv, meta, { prefix, limit });
      if (hits.length > 0 || (await qdrantCount()) === vectorChunkCount(meta)) return hits;
      console.warn('[Qdrant] 命中为空且点位数与本地不一致，回退本地扫描（可能仍在同步中）');
    } catch (e) { console.warn('[Qdrant Search]', e.message || e, '— 回退本地扫描'); }
  }
  const vectors = ensureVectorCache();
  if (!vectors) return [];
  const dim = meta.dim;
  let qn = 0;
  for (let d = 0; d < qv.length; d++) qn += qv[d] * qv[d];
  qn = Math.sqrt(qn);
  const norms = vectorStore.norms;
  const results = [];
  for (const rel of Object.keys(meta.files || {})) {
    if (prefix && !rel.startsWith(prefix)) continue;
    for (const chunk of (meta.files[rel] && meta.files[rel].chunks) || []) {
      const base = chunk.o;
      let sim;
      if (norms && base % dim === 0 && base / dim < norms.length) {
        let dot = 0;
        for (let d = 0; d < dim; d++) dot += qv[d] * vectors[base + d];
        sim = qn === 0 || norms[base / dim] === 0 ? 0 : dot / (qn * norms[base / dim]);
      } else {
        sim = cosineSimilarity(qv, vectors.subarray(base, base + dim));
      }
      if (sim > 0) results.push({ rel, line: chunk.line, text: chunk.text, heading: chunk.heading, score: sim });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

let restartPending = false;

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // 跨站请求防护：本服务无鉴权，而浏览器允许任意网页向本机服务发 POST（CSRF）。
  // 对修改类请求校验 Origin 与所访问的 Host 一致，不一致即拒绝；
  // 不带 Origin 的请求（curl、本机脚本等）不受影响。
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
    const origin = req.headers.origin;
    if (origin) {
      let sameSite = false;
      try {
        const o = new URL(origin);
        const hostName = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
        const loopback = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);
        sameSite = o.hostname.toLowerCase() === hostName
          || (loopback.has(o.hostname.toLowerCase()) && loopback.has(hostName));
      } catch { sameSite = false; }
      if (!sameSite) return json(res, { error: '跨源请求已拒绝（Origin 与本机服务地址不一致）' }, 403);
    }
  }
  if (url.pathname === '/api/settings') {
    if (req.method === 'GET') return json(res, currentSettings());
    if (req.method === 'POST') {
      readBody(req).then(payload => {
        const { values, errors } = validateSettings(payload.values || payload);
        if (errors.length) return json(res, { ok: false, errors }, 400);
        // LLM Wiki 令牌留空 = 保持已保存的值（令牌不回显，前端拿不到原值）
        if (!values.LLM_WIKI_API_TOKEN) {
          const prev = readDotEnvValues().LLM_WIKI_API_TOKEN ?? process.env.LLM_WIKI_API_TOKEN ?? '';
          if (String(prev).trim()) values.LLM_WIKI_API_TOKEN = String(prev).trim();
        }
        const hasFeeds = Object.hasOwn(payload, 'rssFeeds');
        const feedsConfig = hasFeeds ? parseFeedsText(payload.rssFeeds) : null; // 先校验再落盘
        writeDotEnvValues(values);
        if (Object.hasOwn(payload, 'dailyTemplate')) writeDailyTemplate(payload.dailyTemplate);
        // 新配置了 Qdrant 时立即触发后台对账同步（QDRANT_URL 是现读配置，保存即生效）
        if (qdrantUrl()) setTimeout(() => qdrantSyncJob(), 500);
        if (hasFeeds) {
          if (feedsConfig.length) saveFeedsConfig(feedsConfig);
          else { try { fs.unlinkSync(USER_FEEDS_FILE); } catch { /* 本就没有自定义源 */ } }
          refreshFeeds(false).catch(() => { /* 新增源的抓取失败不阻塞保存 */ });
        }
        return json(res, { ...currentSettings(), ok: true, requiresRestart: true });
      }).catch(error => json(res, { error: error.message || 'Unable to save settings' }, 400));
      return;
    }
  }
  // 🔄 重启服务：先应答，再派生新进程接管端口、当前进程退出（设置改动后一键生效）
  if (url.pathname === '/api/restart' && req.method === 'POST') {
    if (restartPending) return json(res, { ok: true, message: '重启已在进行中' });
    restartPending = true;
    json(res, { ok: true, message: 'VaultDesk 正在重启…' });
    setTimeout(() => {
      // 由 launchd 等服务管理器托管时（VAULTDESK_MANAGED 已设置）不能自行派生子进程：
      // 托管实例退出后管理器会重新拉起，detached 子进程会与之抢端口造成崩溃循环
      if (String(process.env.VAULTDESK_MANAGED || '').trim()) {
        console.log('[Restart] 托管模式下直接退出，由服务管理器重新拉起。');
        setTimeout(() => process.exit(0), 150);
        return;
      }
      try {
        // loadDotEnv 不覆盖已有环境变量，若让子进程原样继承 process.env，
        // 它会沿用旧值、永远读不到刚保存的 .env —— 先用 .env 最新内容覆盖再传
        const env = { ...process.env, ...readDotEnvValues() };
        const child = spawn(process.execPath, [path.join(APP, 'server.js')], {
          detached: true,
          stdio: ['ignore', 1, 2], // 沿用当前进程的 stdout/stderr，日志继续写向同一位置
          env,
          cwd: APP
        });
        child.unref();
        console.log(`[Restart] 新进程已派生 (pid ${child.pid})，当前进程即将退出。`);
      } catch (e) {
        console.error('[Restart] 派生新进程失败：', e);
      } finally {
        setTimeout(() => process.exit(0), 150);
      }
    }, 300);
    return;
  }
  // 📂 目录浏览（设置页"选择目录"弹窗用）：只列子目录名，不读文件内容
  if (url.pathname === '/api/browse-dir' && req.method === 'GET') {
    const raw = url.searchParams.get('path') || '';
    const target = raw ? path.resolve(raw) : os.homedir();
    let dirs = [];
    try {
      dirs = fs.readdirSync(target, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    } catch (error) {
      return json(res, { error: `无法读取目录 ${target}：${error.message}` }, 400);
    }
    const parent = path.dirname(target);
    return json(res, { path: target, parent: parent === target ? null : parent, home: os.homedir(), dirs });
  }
  if (url.pathname === '/api/stats') {
    const folders = new Set(notes.map(n => n.path.split('/')[0]));
    const totalBytes = notes.reduce((sum, n) => sum + n.bytes, 0);
    return json(res, { notes: notes.length, folders: folders.size, markdownBytes: totalBytes, root: ROOT, generatedAt: Date.now() });
  }
  if (url.pathname === '/api/notes') {
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const folder = url.searchParams.get('folder') || '';
    const tag = url.searchParams.get('tag') || '';
    const limit = Math.min(Number(url.searchParams.get('limit')) || 180, 500);
    const filtered = notes.filter(n => (!folder || n.path.startsWith(folder + '/') || n.path === folder) && (!tag || n.tags.includes(tag)) && (!q || `${n.title} ${n.path} ${n.tags.join(' ')}`.toLowerCase().includes(q)));
    return json(res, { notes: filtered.slice(0, limit), total: filtered.length });
  }
  if (url.pathname === '/api/folders') {
    const counts = new Map();
    for (const n of notes) { const root = n.path.split('/')[0]; counts.set(root, (counts.get(root) || 0) + 1); }
    return json(res, [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count));
  }
  if (url.pathname === '/api/folder-tree') {
    return json(res, folderTreePayload());
  }
  if (url.pathname === '/api/note') {
    if (req.method === 'POST') {
      readBody(req).then(payload => {
        if (String(payload.path || '').startsWith('llm-wiki:')) return json(res, { error: 'LLM Wiki 页面为只读，不能写回。' }, 400);
        writeMarkdown(payload.path, payload.content);
        updateNoteInMemory(payload.path);
        return json(res, { ok: true, path: payload.path });
      }).catch(error => json(res, { error: error.message || 'Unable to write note' }, 400));
      return;
    }
    const wikiName = String(url.searchParams.get('wiki') || '').trim();
    let notePath = String(url.searchParams.get('path') || '');
    if (wikiName) {
      const resolved = resolveWikiLink(wikiName);
      if (!resolved) return json(res, { error: 'Note not found' }, 404);
      notePath = resolved;
      updateNoteInMemory(notePath);
    }
    if (notePath.startsWith('llm-wiki:')) {
      // LLM Wiki 页面只读回读：经 Wiki API 取原文，在阅读器中打开（不写入 vault）
      const wcfg = llmWikiConfig();
      if (!wcfg.enabled) return json(res, { error: 'LLM Wiki 未配置' }, 404);
      try {
        const rel = notePath.slice('llm-wiki:'.length);
        const wr = await fetch(`${wcfg.baseUrl}/api/v1/projects/${encodeURIComponent(wcfg.project)}/files/content?path=${encodeURIComponent(rel)}`, { headers: llmWikiHeaders(), signal: AbortSignal.timeout(8000) });
        const wd = await wr.json().catch(() => ({}));
        if (!wr.ok || typeof wd.content !== 'string') return json(res, { error: `LLM Wiki 页面读取失败（HTTP ${wr.status}）` }, 404);
        return json(res, { path: notePath, title: path.basename(rel).replace(/\.md$/i, ''), content: wd.content, links: [], headings: [], wiki: true });
      } catch (e) {
        return json(res, { error: `LLM Wiki 页面读取失败：${e.message || e}` }, 404);
      }
    }
    const item = readNote(notePath);
    return item ? json(res, item) : json(res, { error: 'Note not found' }, 404);
  }
  if (url.pathname === '/api/daily') {
    const item = dailyFor(url.searchParams.get('date'));
    return item ? json(res, item) : json(res, { error: 'Invalid date' }, 400);
  }
  if (url.pathname === '/api/daily-dates') {
    const dates = notes.map(n => dailyDateFromPath(n.path)).filter(Boolean);
    return json(res, [...new Set(dates)].sort());
  }
  if (url.pathname === '/api/daily/insights') {
    const date = url.searchParams.get('date');
    if (!dateParts(date)) return json(res, { error: 'Invalid date' }, 400);
    return json(res, dailyInsights(date));
  }
  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    return json(res, { tasks: parseInboxTasks(), source: INBOX_REL });
  }
  if (url.pathname === '/api/task' && req.method === 'POST') {
    readBody(req).then(async payload => {
      const inboxContent = readVaultMarkdown(INBOX_REL);
      const lines = inboxContent === null ? [] : inboxContent.split(/\r?\n/);
      if (payload.action === 'add') {
        // 压平换行：任务按行存储，带换行的文本会破坏文件结构
        const text = String(payload.text || '').trim().replace(/[\r\n]+/g, ' ');
        if (!text) return json(res, { error: 'Task text is empty' }, 400);
        const due = String(payload.due || '').match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
        lines.push(`- [ ] ${text}${due ? ` 📅 ${due}` : ''}`);
        writeInboxLines(lines);
        return json(res, { ok: true, tasks: parseInboxTasks() });
      }
      const lineNumber = Number(payload.line);
      if (!Number.isInteger(lineNumber) || lineNumber < 0 || lineNumber >= lines.length) return json(res, { error: 'Invalid task line' }, 400);
      const current = parseInboxTasks().find(task => task.line === lineNumber);
      if (!current) return json(res, { error: 'Task not found' }, 404);
      const match = lines[lineNumber].match(/^(\s*(?:[-*]|\d+\.)\s+\[)( |x|X|\/)(\]\s+)(.*)$/);
      if (payload.action === 'toggle') {
        const status = payload.done ? 'x' : ' ';
        const cleanTail = match[4].replace(/\s+✅\s+\d{4}-\d{2}-\d{2}/g, '');
        const completedAt = String(payload.completedAt || new Date().toISOString().slice(0, 10)).match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || new Date().toISOString().slice(0, 10);
        lines[lineNumber] = `${match[1]}${status}${match[3]}${cleanTail}${payload.done ? ` ✅ ${completedAt}` : ''}`;
      } else if (payload.action === 'edit') {
        const text = String(payload.text || '').trim();
        if (!text) return json(res, { error: 'Task text is empty' }, 400);
        lines[lineNumber] = `${match[1]}${match[2]}${match[3]}${text}`;
      } else if (payload.action === 'delete') {
        lines.splice(lineNumber, 1);
        writeInboxLines(lines);
        return json(res, { ok: true, deletedLine: lineNumber, tasks: parseInboxTasks() });
      } else return json(res, { error: 'Unsupported task action' }, 400);
      writeInboxLines(lines);
      return json(res, { ok: true, task: parseInboxTasks().find(task => task.line === lineNumber) });
    }).catch(() => json(res, { error: 'Unable to write task' }, 500));
    return;
  }
  if (url.pathname === '/api/llm/models' && req.method === 'GET') {
    const models = await getAvailableLLMs();
    const defaultModel = pickDefaultModel(models);
    const defaultProvider = models.find(m => m.id === defaultModel)?.provider || 'ollama';
    return json(res, { models, defaultModel, defaultProvider });
  }
  // 🤖 自定义模型服务管理（OpenAI 兼容）
  if (url.pathname === '/api/llm/custom-providers' && req.method === 'GET') {
    return json(res, { providers: maskProviders(loadCustomProviders()) });
  }
  if (url.pathname === '/api/llm/custom-providers' && req.method === 'POST') {
    readBody(req).then(payload => {
      const list = sanitizeCustomProviders(payload.providers);
      saveCustomProviders(list);
      return json(res, { ok: true, providers: maskProviders(list) });
    }).catch(error => json(res, { error: error.message || '保存失败' }, 400));
    return;
  }
  // 连通性测试：探测 OpenAI 兼容的 /models 列表（地址没带 /v1 时自动补试一次）
  if (url.pathname === '/api/llm/providers/test' && req.method === 'POST') {
    readBody(req).then(async (payload) => {
      const base = normalizeBaseUrl(payload.baseUrl);
      if (!/^https?:\/\//i.test(base)) return json(res, { ok: false, error: '地址必须以 http(s):// 开头' });
      const headers = {};
      if (payload.apiKey) headers.Authorization = `Bearer ${payload.apiKey}`;
      let lastErr = '';
      const candidates = base.endsWith('/v1') ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`];
      for (const candidate of candidates) {
        try {
          const r = await fetch(candidate, { headers, signal: AbortSignal.timeout(8000) });
          if (r.ok) {
            const data = await r.json().catch(() => ({}));
            const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
            return json(res, { ok: true, endpoint: candidate, models });
          }
          lastErr = `HTTP ${r.status} @ ${candidate}`;
        } catch (e) { lastErr = `${e.message || e} @ ${candidate}`; }
      }
      return json(res, { ok: false, error: `连通失败：${lastErr}` });
    }).catch(error => json(res, { ok: false, error: error.message || '测试失败' }));
    return;
  }
  // 内置本地服务已下载的模型列表（设置页"获取本地模型"按钮）
  if (url.pathname === '/api/llm/local-models' && req.method === 'GET') {
    const provider = url.searchParams.get('provider') || '';
    try {
      if (provider === 'ollama') {
        const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5000) });
        const d = await r.json();
        return json(res, { ok: true, models: (d.models || []).map((m) => ({ id: m.name, size: m.size ? `${(m.size / 1073741824).toFixed(1)}GB` : '' })) });
      }
      if (provider === 'lmstudio') {
        const r = await fetch(`${LMSTUDIO_BASE_URL}/models`, { signal: AbortSignal.timeout(5000) });
        const d = await r.json();
        return json(res, { ok: true, models: (d.data || []).map((m) => ({ id: m.id })) });
      }
      return json(res, { ok: false, error: '未知的服务类型' });
    } catch (e) {
      return json(res, { ok: false, error: `无法连接服务：${e.message || e}` });
    }
  }
  // 📖 LLM Wiki 连接状态（设置页"知识检索"状态展示与测试按钮）
  if (url.pathname === '/api/wiki/status' && req.method === 'GET') {
    const cfg = llmWikiConfig();
    if (!cfg.enabled) return json(res, { configured: false });
    try {
      // HTTP 状态也要检查：令牌错误时 Wiki 会返回 401，只看 JSON 体会误报「已连接」
      const hres = await fetch(`${cfg.baseUrl}/api/v1/health`, { headers: llmWikiHeaders(), signal: AbortSignal.timeout(4000) });
      if (!hres.ok) {
        return json(res, { configured: true, ok: false, error: hres.status === 401 || hres.status === 403 ? '访问被拒绝：请检查访问令牌是否正确' : `LLM Wiki 返回 HTTP ${hres.status}`, hasToken: !!cfg.token });
      }
      const health = await hres.json();
      let projects = [];
      try {
        const pdata = await fetch(`${cfg.baseUrl}/api/v1/projects`, { headers: llmWikiHeaders(), signal: AbortSignal.timeout(4000) }).then((r) => r.json());
        projects = (Array.isArray(pdata) ? pdata : pdata.projects || []).map((p) => ({ id: p.id, name: p.name, current: !!p.current }));
      } catch { /* 项目列表失败不影响健康状态展示 */ }
      return json(res, { configured: true, ok: health.ok !== false, status: health.status || '', version: health.version || '', projects, hasToken: !!cfg.token, project: cfg.project });
    } catch (e) {
      return json(res, { configured: true, ok: false, error: `无法连接 LLM Wiki：${e.message || e}` });
    }
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    readBody(req).then(async (payload) => {
      const question = String(payload.question || '').trim();
      if (!question) return json(res, { error: '问题不能为空' }, 400);

      const limit = Math.min(Number(payload.limit) || 5, 10);
      const path_prefix = String(payload.path_prefix || '').trim();
      const tag = String(payload.tag || '').trim();
      const history = (Array.isArray(payload.history) ? payload.history.slice(-8) : [])
        // 过滤空消息（如旧版本空回答残留），避免污染发给模型的上下文
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim());
      let model = String(payload.model || '').trim();
      if (!model) model = pickDefaultModel(await getAvailableLLMs());
      if (!model) return json(res, { error: '未检测到可用的大模型服务。请安装并启动 LM Studio 或 Ollama，或在 .env 中配置 DEEPSEEK_API_KEY。' }, 400);
      let provider = payload.provider;
      if (!provider) {
        if (model.startsWith('deepseek')) provider = 'deepseek';
        else if (model.includes(':')) provider = 'ollama';
        else provider = 'lmstudio';
      }

      const chatT0 = Date.now();
      // 1. RAG Search over vault（关键词 + 向量语义，若索引存在且检索范围在其覆盖内）
      let sources = await searchVaultRAG(question, { limit, path_prefix, tag });
      const vecMeta = loadVectorMeta();
      const covered = !vecMeta || !path_prefix || metaRoots(vecMeta).some((r) => !r || path_prefix === r || path_prefix.startsWith(r + '/') || r.startsWith(path_prefix));
      if (vecMeta && covered) {
        try {
          const hits = await searchSemantic(question, { prefix: path_prefix, limit });
          const seenPaths = new Set(sources.map(s => s.path));
          for (const hit of hits) {
            if (seenPaths.has(hit.rel)) continue;
            seenPaths.add(hit.rel);
            sources.push({
              title: hit.heading || path.basename(hit.rel, '.md'),
              path: hit.rel,
              line: hit.line,
              score: Math.round(hit.score * 1000),
              scope: 'semantic',
              tags: [],
              excerpt: hit.text
            });
          }
        } catch (e) { console.error('[Semantic Search Error]', e); }
      }
      // LLM Wiki（可选）：把 Wiki 项目的检索命中并入素材（path 前缀 llm-wiki:，在阅读器中只读打开）
      const wikiCfg = llmWikiConfig();
      if (wikiCfg.enabled) {
        try {
          const wr = await fetch(`${wikiCfg.baseUrl}/api/v1/projects/${encodeURIComponent(wikiCfg.project)}/search`, {
            method: 'POST',
            headers: llmWikiHeaders({ 'Content-Type': 'application/json' }),
            signal: AbortSignal.timeout(8000),
            body: JSON.stringify({ query: question, topK: limit, includeContent: true })
          });
          const wd = await wr.json().catch(() => ({}));
          if (!wr.ok) throw new Error(`HTTP ${wr.status}${wd.error ? `：${typeof wd.error === 'string' ? wd.error : JSON.stringify(wd.error)}` : ''}`);
          for (const hit of (wd.results || []).slice(0, limit)) {
            const rel = String(hit.path || '').trim();
            if (!rel) continue;
            sources.push({
              title: String(hit.title || rel),
              path: `llm-wiki:${rel}`,
              line: 1,
              score: Number(hit.score) || 0,
              scope: 'llm-wiki',
              tags: [],
              excerpt: String(hit.content || hit.snippet || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').slice(0, 2500)
            });
          }
        } catch (e) { console.warn('[LLM Wiki Search]', e.message || e); }
      }
      // 三路来源的分数量纲不可比（关键词：原始分 / 语义：相似度×1000 / Wiki：API 自己的分），
      // 直接混排会让 Wiki 与关键词命中被系统性挤出上下文——改为分桶配额：各来源按分排序后轮流取
      const buckets = new Map();
      for (const s of sources) {
        const key = s.scope || 'vault';
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(s);
      }
      for (const list of buckets.values()) list.sort((a, b) => (b.score || 0) - (a.score || 0));
      const picked = [];
      while (picked.length < limit) {
        let added = false;
        for (const list of buckets.values()) {
          if (picked.length >= limit) break;
          const item = list.shift();
          if (item) { picked.push(item); added = true; }
        }
        if (!added) break;
      }
      sources = picked;
      const searchMs = Date.now() - chatT0;

      // LLM 自身不知道当前日期，「今天/最近一周」这类相对时间需要一个锚点才能推算
      const nowDate = new Date();
      const todayStr = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`;
      const weekdayStr = '日一二三四五六'[nowDate.getDay()];

      // 2. Build Context Prompt
      const contextText = sources.length
        ? sources.map((s, i) => `[素材 ${i + 1}] 标题: ${s.title}\n路径: ${s.path} (行号: ${s.line})\n内容:\n${String(s.excerpt).slice(0, 800)}${s.excerpt.length > 800 ? '\n…（片段截断）' : ''}`).join('\n\n---\n\n')
        : '（知识库中暂未检索到高度相关的文档素材）';

      const systemPrompt = `你是一个基于用户 Markdown 知识库的专业智能助理。
今天是 ${todayStr}（星期${weekdayStr}）。用户提到的“今天/昨天/本周/最近一周/本月”等相对时间，一律以这个日期为基准推算出具体日期范围，并结合素材中出现的日期判断内容的新旧与相关性。
请仔细阅读以下检索到的知识库素材，并严格基于素材内容回答用户提出的问题或进行多轮追问解答：

===== 知识库检索素材开始 =====
${contextText}
===== 知识库检索素材结束 =====

回答准则：
1. 严格以提供的知识库素材为依据，条理清晰、层次分明；
2. 如果素材中未包含相关信息或证据不足，请明确诚实指出“根据当前知识库检索素材，暂未记录关于...的内容”；
3. 输出请使用 Markdown 格式（可包含列表、加粗等）；
4. 请精炼作答：直接给结论，正文控制在 350 字以内，不写引言和多余总结；
5. 结尾附上“参考出处”小节，简要罗列引用的文件路径及关联点。`;

      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
        { role: 'user', content: question }
      ];

      // 流式模式：SSE 先推检索来源（meta），再逐段推送回答（delta），结束发 done/error
      if (payload.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        const sseSend = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* 连接已断 */ } };
        sseSend('meta', { sources, model, provider });
        const abortCtrl = new AbortController();
        res.on('close', () => { if (!res.writableEnded) abortCtrl.abort(); });
        try {
          const llmStart = Date.now();
          const answer = await streamLLM({
            messages, model, provider,
            signal: abortCtrl.signal,
            onDelta: (text) => sseSend('delta', { text })
          });
          sseSend('done', {
            answer: stripThinkText(answer), model, provider,
            timings: { searchMs, llmMs: Date.now() - chatT0 - searchMs, totalMs: Date.now() - chatT0 }
          });
        } catch (err) {
          console.error('[Chat Stream Error]', err);
          if (!abortCtrl.signal.aborted) sseSend('error', { error: err.message || String(err) });
        }
        res.end();
        return;
      }

      try {
        const answer = await callLLM({ messages, model, provider });
        const llmMs = Date.now() - chatT0 - searchMs;
        return json(res, { ok: true, answer, sources, question, model, provider, timings: { searchMs, llmMs, totalMs: Date.now() - chatT0 } });
      } catch (err) {
        console.error('[Chat LLM Error]', err);
        return json(res, { error: `LLM 调用失败: ${err.message}`, sources, ok: false }, 500);
      }
    }).catch(() => json(res, { error: '请求解析失败' }, 500));
    return;
  }
  if (url.pathname === '/api/chat/save' && req.method === 'POST') {
    readBody(req).then(async (payload) => {
      const question = String(payload.question || '').trim();
      const answer = String(payload.answer || '').trim();
      const sources = Array.isArray(payload.sources) ? payload.sources : [];
      const model = String(payload.model || 'LLM');
      if (!question || !answer) return json(res, { error: '问题或回答不能为空' }, 400);

      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toTimeString().slice(0, 8);
      const [year, month, day] = dateStr.split('-');
      const slug = question.slice(0, 30).replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'qa';
      const relPath = CHAT_SAVE_PATH_PATTERN
        .replaceAll('{YYYY}', year)
        .replaceAll('{MM}', month)
        .replaceAll('{DD}', day)
        .replaceAll('{date}', dateStr)
        .replaceAll('{slug}', slug);
      const mdLines = [
        '---',
        `title: "问答: ${question.replace(/"/g, '\\"')}"`,
        `date: ${dateStr}`,
        `created_at: ${dateStr} ${timeStr}`,
        `model: ${model}`,
        'type: kb-answer',
        'tags: [ai-chat, qa, knowledge-fabric]',
        '---',
        '',
        `# 问答：${question}`,
        '',
        `> **提问时间**: ${dateStr} ${timeStr} · **模型**: \`${model}\` · **引用素材数**: ${sources.length} 篇`,
        '',
        '## 🤖 回答内容',
        '',
        answer,
        '',
        '## 🔍 引用知识库素材',
        '',
        ...sources.map((s, idx) => `### ${idx + 1}. [[${s.path}#L${s.line}|${s.title}]]\n- 路径: \`${s.path}\`\n- 匹配度评分: \`${s.score}\`\n- 片段摘录:\n\`\`\`text\n${s.excerpt}\n\`\`\`\n`)
      ];

      writeMarkdown(relPath, mdLines.join('\n'));

      // Update memory index
      updateNoteInMemory(relPath, { title: `问答: ${question}`, tags: ['ai-chat', 'qa', 'knowledge-fabric'] });

      return json(res, { ok: true, path: relPath, title: `问答: ${question}` });
    }).catch(() => json(res, { error: '保存问答失败' }, 500));
    return;
  }
  // 📡 RSS 资讯聚合
  if (url.pathname === '/api/feeds' && req.method === 'GET') {
    if (Date.now() - (feedCache.updatedAt || 0) > FEED_TTL) { try { await refreshFeeds(false); } catch { /* 忽略 */ } }
    return json(res, feedsPayload());
  }
  if (url.pathname === '/api/feeds/refresh' && req.method === 'POST') {
    try {
      await refreshFeeds(true);
      return json(res, feedsPayload());
    } catch (e) {
      return json(res, { error: e.message || '资讯刷新失败' }, 500);
    }
  }
  if (url.pathname === '/api/feeds/add' && req.method === 'POST') {
    readBody(req).then(payload => {
      const urlIn = String(payload.url || '').trim();
      if (!/^https?:\/\//i.test(urlIn)) return json(res, { error: 'URL 格式不对' }, 400);
      const config = loadFeedsConfig();
      if (config.some(f => f.url === urlIn)) return json(res, { error: '该源已存在' }, 400);
      const name = String(payload.name || '').trim() || new URL(urlIn).hostname;
      const key = name.toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || `feed-${Date.now()}`;
      config.push({ key, name, url: urlIn, max: 20 });
      saveFeedsConfig(config);
      fetchFeed({ key, name, url: urlIn, max: 20 }).then(articles => {
        feedCache.feeds[key] = { ok: true, updatedAt: Date.now(), articles, error: null };
        saveJsonFile(FEED_CACHE_FILE, feedCache);
      }).catch(err => {
        feedCache.feeds[key] = { ok: false, updatedAt: Date.now(), error: err.message || String(err), articles: [] };
        saveJsonFile(FEED_CACHE_FILE, feedCache);
      });
      return json(res, { ok: true, key, name, url: urlIn });
    }).catch(() => json(res, { error: '请求解析失败' }, 400));
    return;
  }
  if (url.pathname === '/api/feed/read' && req.method === 'POST') {
    readBody(req).then(payload => { markFeedRead(payload); return json(res, { ok: true }); }).catch(() => json(res, { error: '请求解析失败' }, 400));
    return;
  }
  if (url.pathname === '/api/feed/save' && req.method === 'POST') {
    readBody(req).then(payload => {
      const title = String(payload.title || '无标题').trim();
      const link = String(payload.link || '').trim();
      const source = String(payload.source || 'RSS').trim();
      const rel = saveRssInbox(title, link, source);
      return json(res, { ok: true, path: rel, items: parseRssLater() });
    }).catch(() => json(res, { error: '保存失败' }, 500));
    return;
  }
  // 稍后读列表：回读 vault 中的 read-later.md
  if (url.pathname === '/api/feed/later' && req.method === 'GET') {
    return json(res, { items: parseRssLater(), path: RSS_INBOX_REL });
  }
  if (url.pathname === '/api/feed/later' && req.method === 'POST') {
    readBody(req).then(payload => {
      const lineNo = Number(payload.line);
      const action = String(payload.action || '');
      const target = parseRssLater().find((i) => i.line === lineNo);
      if (!target) return json(res, { error: '条目不存在或文件已变化' }, 404);
      const lines = (readVaultMarkdown(RSS_INBOX_REL) || '').split(/\r?\n/);
      if (action === 'remove') {
        lines.splice(lineNo, 1);
      } else if (action === 'done') {
        lines[lineNo] = target.done
          ? lines[lineNo].replace(/^- \[x\]/i, '- [ ]')
          : lines[lineNo].replace(/^- \[ \]/, '- [x]');
      } else {
        return json(res, { error: '未知操作' }, 400);
      }
      writeMarkdown(RSS_INBOX_REL, lines.join('\n'));
      return json(res, { ok: true, items: parseRssLater() });
    }).catch(() => json(res, { error: '操作失败' }, 500));
    return;
  }
  // ===================== 🧠 向量化检索 API =====================
  if (url.pathname === '/api/vector/status' && req.method === 'GET') {
    const payload = vectorStatusPayload();
    payload.qdrant = await qdrantStatusPayload();
    return json(res, payload);
  }
  if (url.pathname === '/api/vector/models' && req.method === 'GET') {
    const models = [];
    // LM Studio 嵌入模型
    try {
      const resLM = await fetch(`${LMSTUDIO_BASE_URL}/models`, { signal: AbortSignal.timeout(1500) });
      if (resLM.ok) {
        const data = await resLM.json();
        for (const m of (data.data || [])) {
          if (/(embed|bge|e5|gte|mxbai|nomic|qwen3-embed)/i.test(m.id)) models.push({ id: m.id, provider: 'lmstudio', name: `LM Studio · ${m.id}` });
        }
      }
    } catch {}
    // Ollama 嵌入模型
    try {
      const resOl = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
      if (resOl.ok) {
        const data = await resOl.json();
        for (const m of (data.models || [])) {
          if (/(embed|bge|e5|gte|mxbai|nomic|qwen3-embed|rerank)/i.test(m.name)) models.push({ id: m.name, provider: 'ollama', name: `Ollama · ${m.name}` });
        }
      }
    } catch {}
    // 自定义模型服务的嵌入模型
    for (const svc of loadCustomProviders()) {
      try {
        const headers = {};
        if (svc.apiKey) headers.Authorization = `Bearer ${svc.apiKey}`;
        const r = await fetch(`${normalizeBaseUrl(svc.baseUrl)}/models`, { headers, signal: AbortSignal.timeout(2500) });
        if (!r.ok) continue;
        const data = await r.json().catch(() => ({}));
        for (const m of (data.data || data.models || [])) {
          const mid = m.id || m.name;
          if (mid && /(embed|bge|e5|gte|mxbai|nomic|qwen3-embed|rerank)/i.test(mid)) {
            models.push({ id: mid, provider: `custom:${svc.id}`, name: `${svc.name} · ${mid}` });
          }
        }
      } catch {}
    }
    return json(res, { models });
  }
  if (url.pathname === '/api/vector/index' && req.method === 'POST') {
    readBody(req).then(payload => {
      if (vectorStore.activeJob) return json(res, { ok: false, error: '已有向量化任务在运行' }, 409);
      const roots = normalizeIndexRoots(payload.roots !== undefined ? payload.roots : payload.root);
      const provider = String(payload.provider || 'ollama');
      const model = String(payload.model || '').trim();
      // 嵌入服务白名单：内置两种 + 自定义 OpenAI 兼容服务（custom:<id>）；
      // embedBatch/模型列表/前端下拉都已支持 custom:，此处不能漏
      const providerOk = ['ollama', 'lmstudio'].includes(provider)
        || (provider.startsWith('custom:') && loadCustomProviders().some((s) => s.id === provider.slice(7)));
      if (!providerOk) return json(res, { ok: false, error: provider.startsWith('custom:') ? '自定义嵌入服务不存在或已被删除' : '无效的嵌入服务' }, 400);
      if (!model) return json(res, { ok: false, error: '请选择嵌入模型' }, 400);
      for (const root of roots) {
        const rootAbs = root ? path.join(ROOT, root) : ROOT;
        if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
          return json(res, { ok: false, error: root ? `目录不存在或不是文件夹：${root}` : 'Vault 根目录不存在或不是文件夹' }, 400);
        }
      }
      vectorStore.activeJob = { runId: Date.now() + Math.random(), stop: false };
      vectorStore.status = { phase: 'starting', filesTotal: 0, filesDone: 0, chunksDone: 0, currentFile: '', error: null, skipped: [] };
      runIndexJob({ runId: vectorStore.activeJob.runId, roots, provider, model, mode: 'full' }).then((res2) => {
        // 只有成功完成的任务才挂文件监控（停止/出错的索引没有落盘，无需增量）
        if (!res2 || res2.ok !== false) vectorWatchSetup(roots);
        // Qdrant 已配置时对账同步（正常情况索引已双写，此处只是补齐失败缺口）
        if (qdrantUrl()) qdrantSyncJob();
      });
      return json(res, { ok: true });
    }).catch(() => json(res, { error: '请求解析失败' }, 400));
    return;
  }
  if (url.pathname === '/api/vector/stop' && req.method === 'POST') {
    if (vectorStore.activeJob) vectorStore.activeJob.stop = true;
    return json(res, { ok: true });
  }
  if (url.pathname === '/api/vector/clear' && req.method === 'POST') {
    if (vectorStore.activeJob) return json(res, { ok: false, error: '任务运行中，请先停止' }, 409);
    try { fs.rmSync(VECTOR_META_FILE, { force: true }); fs.rmSync(VECTOR_DATA_FILE, { force: true }); } catch {}
    vectorStore.meta = null;
    vectorStore.vectors = null;
    vectorStore.norms = null;
    if (qdrantUrl()) qdrantDropCollection();
    vectorStore.status = { phase: 'idle', filesTotal: 0, filesDone: 0, chunksDone: 0, currentFile: '', error: null, skipped: [] };
    // lastWatch 的实际结构是 { roots, watches: Map<root, {watcher, pollTimer}> }——逐个关闭，否则会泄漏
    const prev = vectorStore.lastWatch;
    if (prev && prev.watches) {
      for (const w of prev.watches.values()) {
        try { w.watcher && w.watcher.close(); } catch {}
        if (w.pollTimer) clearInterval(w.pollTimer);
      }
    }
    vectorStore.lastWatch = null;
    return json(res, { ok: true });
  }
  if (url.pathname === '/api/vector/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    const prefix = url.searchParams.get('prefix') || '';
    const limit = Math.min(Number(url.searchParams.get('limit')) || 5, 20);
    if (!q) return json(res, { error: '缺少查询词' }, 400);
    searchSemantic(q, { prefix, limit }).then(hits => {
      return json(res, { hits: hits.map(h => ({ path: h.rel, line: h.line, heading: h.heading, text: h.text, score: Math.round(h.score * 1000) / 1000 })) });
    }).catch(e => json(res, { error: e.message || '检索失败' }, 500));
    return;
  }
  if (url.pathname === '/api/doc-import' && req.method === 'GET') {
    detectImportPython(url.searchParams.get('refresh') === '1').then(() => json(res, importStatusPayload()));
    return;
  }
  if (url.pathname === '/api/doc-import/sources' && req.method === 'POST') {
    readBody(req).then(payload => {
      const action = String(payload.action || '');
      if (action === 'add' || action === 'update') {
        const s = payload.source || {};
        let dir = String(s.dir || '').trim();
        let target = String(s.target || '').trim();
        const watch = !!s.watch;
        const interval = Math.max(60, Number(s.interval) || 300);
        let dirAbs = null;
        if (dir) {
          if (!path.isAbsolute(dir)) return json(res, { ok: false, error: '源文件夹必须是绝对路径' }, 400);
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(res, { ok: false, error: '源文件夹不存在或不是文件夹' }, 400);
          dirAbs = path.resolve(dir);
          const rootAbs = path.resolve(ROOT);
          if (dirAbs === rootAbs || dirAbs.startsWith(rootAbs + path.sep)) {
            return json(res, { ok: false, error: '源文件夹不能位于 vault 内部（避免已导入的笔记被重复导入）' }, 400);
          }
        } else if (action === 'add') {
          return json(res, { ok: false, error: '源文件夹必须是绝对路径' }, 400);
        }
        if (target) {
          try { target = cleanRelPath(target, ''); }
          catch { return json(res, { ok: false, error: '目标文件夹必须是安全的 vault 内相对路径' }, 400); }
        }
        if (action === 'add') {
          if (importStore.sources.some((x) => path.resolve(x.dir) === dirAbs)) return json(res, { ok: false, error: '该文件夹已添加过' }, 400);
          const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          importStore.sources.push({ id, dir: dirAbs, target, watch, interval });
          saveImportSources();
          return json(res, { ok: true, sources: importStore.sources });
        }
        // update：部分更新——只改传入的字段（如仅切换监控开关）
        const cur = importStore.sources.find((x) => x.id === s.id);
        if (!cur) return json(res, { ok: false, error: '导入源不存在' }, 404);
        if (dirAbs) cur.dir = dirAbs;
        if (s.target !== undefined) cur.target = target;
        if (s.watch !== undefined) cur.watch = watch;
        if (s.interval !== undefined) cur.interval = interval;
        saveImportSources();
        return json(res, { ok: true, sources: importStore.sources });
      }
      if (action === 'remove') {
        const id = String((payload.source || {}).id || '');
        const before = importStore.sources.length;
        importStore.sources = importStore.sources.filter((x) => x.id !== id);
        if (importStore.sources.length === before) return json(res, { ok: false, error: '导入源不存在' }, 404);
        // 只移除该源的转换关系记录；已导入的笔记文件保留，可在「全部笔记」中自行删除
        for (const key of Object.keys(importStore.state.files)) {
          if (key.startsWith(`${id}|`)) delete importStore.state.files[key];
        }
        delete importStore.state.lastRuns[id];
        saveImportSources();
        saveImportState();
        return json(res, { ok: true, sources: importStore.sources });
      }
      return json(res, { ok: false, error: '未知操作' }, 400);
    }).catch(() => json(res, { error: '请求解析失败' }, 400));
    return;
  }
  if (url.pathname === '/api/doc-import/run' && req.method === 'POST') {
    readBody(req).then(payload => {
      const id = String(payload.id || '');
      if (importStore.activeJob) return json(res, { ok: false, error: '已有导入任务在运行' }, 409);
      if (!importStore.sources.some((s) => s.id === id)) return json(res, { ok: false, error: '导入源不存在' }, 404);
      runImportSource(id, { trigger: 'manual' }).catch((e) => console.warn('[DocImport]', e.message));
      return json(res, { ok: true });
    }).catch(() => json(res, { error: '请求解析失败' }, 400));
    return;
  }
  if (url.pathname === '/api/doc-import/stop' && req.method === 'POST') {
    if (importStore.activeJob) importStore.activeJob.stop = true;
    return json(res, { ok: true });
  }
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const abs = path.resolve(APP, 'public', '.' + file);
  if (!abs.startsWith(path.resolve(APP, 'public') + path.sep)) return json(res, { error: 'Not found' }, 404);
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, { error: 'Not found' }, 404);
    const ext = path.extname(abs).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.webmanifest': 'application/manifest+json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    const stream = fs.createReadStream(abs); stream.on('error', () => { if (!res.headersSent) json(res, { error: 'Not found' }, 404); else res.destroy(); }); stream.pipe(res);
  } catch { json(res, { error: 'Not found' }, 404); }
}
// 启动时若已有向量索引，恢复目录监听（增量向量化在服务重启后继续生效）
const server = http.createServer(route);
// 端口短暂被占用时（重启竞态：旧进程尚未完全退出）自动重试绑定
let bindRetries = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && ++bindRetries <= 30) {
    console.warn(`[Startup] 端口 ${PORT} 被占用，500ms 后重试（${bindRetries}/30）…`);
    setTimeout(() => server.listen(PORT, HOST), 500);
  } else {
    console.error(`[Startup] 无法监听 ${HOST}:${PORT}：`, err.message);
    process.exit(1);
  }
});
server.listen(PORT, HOST, () => {
  console.log(`VaultDesk running at http://${HOST}:${PORT}`);
  const vecMeta = loadVectorMeta();
  if (vecMeta) vectorWatchSetup(metaRoots(vecMeta));
  // Qdrant 已配置时启动后台对账同步（延迟 10s 等服务就绪；数量一致时空转）
  if (qdrantUrl()) setTimeout(() => qdrantSyncJob(), 10000);
});

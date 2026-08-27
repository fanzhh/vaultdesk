import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(APP, '.env');
const DATA_DIR = path.join(APP, 'data');
const DAILY_TEMPLATE_FILE = path.join(DATA_DIR, 'daily-template.md');
const DEFAULT_DAILY_TEMPLATE = '# {{date}}\n\n## Notes\n\n## Tasks\n';

function loadDotEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

loadDotEnv();

const ROOT = path.resolve(process.env.OBSIDIAN_VAULT_ROOT || path.join(os.homedir(), 'markdown-vault'));
const PORT = Number(process.env.PORT || 4177);
const HOST = process.env.HOST || '127.0.0.1';
const KB_SEARCH = process.env.KB_SEARCH_SCRIPT || path.join(ROOT, '00_META/scripts/kb-search.py');
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
  'VAULT_RSS_READ_LATER_PATH',
  'VAULT_CHAT_SAVE_PATH_PATTERN',
  'KB_SEARCH_SCRIPT',
  'LMSTUDIO_BASE_URL',
  'HOST',
  'PORT'
];
const CONFIG_DEFAULTS = {
  OBSIDIAN_VAULT_ROOT: path.join(os.homedir(), 'markdown-vault'),
  VAULT_INBOX_PATH: 'Inbox.md',
  VAULT_DAILY_PATH_PATTERN: 'Daily/{YYYY}-{MM}-{DD}.md',
  VAULT_RSS_READ_LATER_PATH: 'read-later.md',
  VAULT_CHAT_SAVE_PATH_PATTERN: 'answers/{YYYY}-{MM}-{DD}-answer-{slug}.md',
  KB_SEARCH_SCRIPT: path.join(ROOT, '00_META/scripts/kb-search.py'),
  LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234/v1',
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
    VAULT_RSS_READ_LATER_PATH: RSS_INBOX_REL,
    VAULT_CHAT_SAVE_PATH_PATTERN: CHAT_SAVE_PATH_PATTERN,
    KB_SEARCH_SCRIPT: KB_SEARCH,
    LMSTUDIO_BASE_URL,
    HOST,
    PORT: String(PORT)
  };
  const requiresRestart = CONFIG_KEYS.some(key => values[key] && values[key] !== effective[key]);
  return {
    envPath: ENV_PATH,
    requiresRestart,
    values,
    effective,
    defaults: CONFIG_DEFAULTS,
    dailyTemplate: dailyTemplateSettings()
  };
}

function dailyTemplateSettings() {
  let content = DEFAULT_DAILY_TEMPLATE;
  let custom = false;
  if (fs.existsSync(DAILY_TEMPLATE_FILE)) {
    content = fs.readFileSync(DAILY_TEMPLATE_FILE, 'utf8');
    custom = true;
  }
  return {
    path: DAILY_TEMPLATE_FILE,
    content,
    defaultContent: DEFAULT_DAILY_TEMPLATE,
    custom
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
  for (const key of ['VAULT_INBOX_PATH', 'VAULT_DAILY_PATH_PATTERN', 'VAULT_RSS_READ_LATER_PATH', 'VAULT_CHAT_SAVE_PATH_PATTERN']) {
    if (next[key]) {
      try { cleanRelPath(next[key], ''); }
      catch { errors.push(`${key} 必须是安全的 vault 内相对路径。`); }
    }
  }
  if (next.VAULT_INBOX_PATH && !next.VAULT_INBOX_PATH.endsWith('.md')) errors.push('待办文件路径必须以 .md 结尾。');
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

// RAG Search Helper over Knowledge Vault
function searchVaultRAG(query, { limit = 5, path_prefix = '', tag = '' } = {}) {
  return new Promise((resolve) => {
    const args = [KB_SEARCH, query, '--limit', String(limit), '--json'];
    if (path_prefix) args.push('--prefix', path_prefix);
    if (tag) args.push('--tag', tag);

    execFile('python3', args, { cwd: ROOT, timeout: 40000 }, (err, stdout) => {
      if (err) {
        console.error('[RAG Search Error]', err.message);
        return resolve([]);
      }
      try {
        const rawMatches = JSON.parse(stdout || '[]');
        const sources = rawMatches.map((m) => {
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
        resolve(sources);
      } catch (e) {
        console.error('[RAG Parse Error]', e);
        resolve([]);
      }
    });
  });
}

const LMSTUDIO_BASE_URL = process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1';

// Available LLM Models List
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

  return models;
}

// Unified LLM Chat Invoker
async function callLLM({ messages, model = 'qwen3.5-2b', provider = 'lmstudio' }) {
  if (provider === 'lmstudio' || (!model.startsWith('deepseek') && !model.includes(':'))) {
    const res = await fetch(`${LMSTUDIO_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'qwen3.5-2b',
        messages,
        temperature: 0.2
      })
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = data.error?.message || 'LM Studio 请求失败';
      throw new Error(`LM Studio 错误: ${errMsg}`);
    }
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
      })
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
      })
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
        })
      });
      const genData = await genRes.json();
      if (!genRes.ok) throw new Error(genData.error || 'Ollama 请求失败');
      return genData.response || '';
    }
    return data.message?.content || '';
  }
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
      const stat = fs.statSync(abs);
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
  const content = fs.readFileSync(abs, 'utf8');
  const item = notes.find(n => n.path === rel);
  const links = [...content.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map(m => m[1].trim()).slice(0, 80);
  const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => m[1].trim()).slice(0, 40);
  return { ...(item || { path: rel, title: path.basename(rel, '.md') }), content, links, headings };
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
    return { line: index, text: tail, done: match[2].toLowerCase() === 'x', status: match[2], due, raw: line };
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
  return new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 1000000) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } }); req.on('error', reject); });
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
  return String(template || DEFAULT_DAILY_TEMPLATE)
    .replaceAll('{{date}}', value)
    .replaceAll('{{YYYY}}', year)
    .replaceAll('{{MM}}', month)
    .replaceAll('{{DD}}', day)
    .replaceAll('{{date:YYYY-MM-DD}}', value)
    .replaceAll('{{date:YYYY-MM-DD HH:mm}}', `${value} 09:00`);
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
  let exists = Boolean(abs && fs.existsSync(abs));
  if (exists) content = fs.readFileSync(abs, 'utf8');
  else {
    content = fillDailyTemplate(dailyTemplateSettings().content, value);
  }
  return { path: rel, title: value, content, exists, generated: !exists, date: value };
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
// RSS 源配置（feeds.json）、抓取缓存（data/feeds-cache.json）、已读状态（data/feed-read.json）
const FEEDS_JSON = path.join(APP, 'feeds.json');
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
  try { return JSON.parse(fs.readFileSync(FEEDS_JSON, 'utf8')); } catch { return defaultFeeds(); }
}
function saveFeedsConfig(config) {
  try { fs.writeFileSync(FEEDS_JSON, JSON.stringify(config, null, 2), 'utf8'); } catch { /* 忽略 */ }
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
let feedRead = loadJsonFile(FEED_READ_FILE, {});

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
  const line = `- [ ] 读：${title}（${source}）${link} #reading`;
  let content = readVaultMarkdown(RSS_INBOX_REL);
  if (content !== null) content = content.trimEnd();
  else content = '# RSS Read Later\n\n> Saved from VaultDesk feeds.\n';
  content += `\n${line}\n`;
  writeMarkdown(RSS_INBOX_REL, content);
  return RSS_INBOX_REL;
}

// ===================== 🧠 向量化语义检索 =====================
// 索引存储：data/vector-meta.json（元数据）+ data/vector-data.bin（float32 向量）
// 嵌入来源：Ollama /api/embed 或 LM Studio /v1/embeddings（OpenAI 兼容），零额外依赖。
const VECTOR_META_FILE = path.join(DATA_DIR, 'vector-meta.json');
const VECTOR_DATA_FILE = path.join(DATA_DIR, 'vector-data.bin');
const VECTOR_BATCH = 32;
const VECTOR_EMBED_TIMEOUT = 60000;

const vectorStore = {
  meta: null,       // { root, provider, model, dim, files: {rel: {mtime, size, chunks:[{o,l,text,line,heading}]}}, updatedAt }
  vectors: null,    // Float32Array 缓存（行 = chunk 内第 o 个标量）
  status: { phase: 'idle', filesTotal: 0, filesDone: 0, chunksDone: 0, currentFile: '', error: null },
  activeJob: null,  // { runId, stop: false }
  lastWatch: null,  // { rootAbs, watcher, pollTimer }
  pendingIncremental: false,
  lastIncrementalAt: 0
};

function loadVectorMeta() {
  if (vectorStore.meta) return vectorStore.meta;
  try { vectorStore.meta = JSON.parse(fs.readFileSync(VECTOR_META_FILE, 'utf8')); } catch { vectorStore.meta = null; }
  return vectorStore.meta;
}

function saveVectorMeta(meta) {
  vectorStore.meta = meta;
  vectorStore.vectors = null; // 元数据变化后强制重载向量缓存
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
  if (!meta || !meta.dim) { vectorStore.vectors = null; return null; }
  const count = vectorChunkCount(meta);
  if (vectorStore.vectors && vectorStore.vectors.length === count * meta.dim) return vectorStore.vectors;
  try {
    const buf = fs.readFileSync(VECTOR_DATA_FILE);
    vectorStore.vectors = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  } catch { vectorStore.vectors = null; }
  return vectorStore.vectors;
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

async function embedTexts(provider, model, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += VECTOR_BATCH) {
    const batch = texts.slice(i, i + VECTOR_BATCH);
    let vectors;
    if (provider === 'lmstudio') {
      const res = await fetch(`${LMSTUDIO_BASE_URL}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(VECTOR_EMBED_TIMEOUT)
      });
      if (!res.ok) throw new Error(`嵌入服务 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      vectors = (data.data || []).map((item) => item.embedding);
    } else {
      const res = await fetch('http://127.0.0.1:11434/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(VECTOR_EMBED_TIMEOUT)
      });
      if (!res.ok) throw new Error(`嵌入服务 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      vectors = data.embeddings || [];
    }
    if (vectors.length !== batch.length) throw new Error('嵌入服务返回数量与请求不一致');
    for (const v of vectors) {
      if (!Array.isArray(v) || !v.length) throw new Error('嵌入服务返回空向量');
      out.push(v);
    }
  }
  return out;
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

async function runIndexJob({ runId, root, provider, model, mode }) {
  const stop = () => !vectorStore.activeJob || vectorStore.activeJob.runId !== runId;
  const statusEl = vectorStore.status;
  try {
    statusEl.phase = 'scanning';
    statusEl.currentFile = '';
    statusEl.filesDone = 0;
    statusEl.chunksDone = 0;
    statusEl.error = null;
    const files = vectorIndexFiles(root);
    statusEl.filesTotal = files.length;
    const meta = mode === 'incremental' ? loadVectorMeta() : null;
    const nextMeta = meta && meta.root === root && meta.provider === provider && meta.model === model
      ? { ...meta, files: { ...(meta.files || {}) } }
      : { root, provider, model, dim: 0, files: {}, totalChunks: 0, updatedAt: Date.now() };

    const changed = [];
    if (mode === 'incremental') {
      const known = new Set(Object.keys(meta.files || {}));
      for (const f of files) {
        const cur = meta.files[f.rel];
        if (!cur || cur.mtime !== f.mtime || cur.size !== f.size) changed.push(f);
      }
      for (const rel of known) {
        if (!files.some((f) => f.rel === rel)) changed.push({ rel, abs: path.join(ROOT, rel), mtime: 0, size: 0, deleted: true });
      }
    } else {
      changed.push(...files);
    }

    let orphanSlots = 0;
    const dataChunks = [];
    for (const f of changed) {
      if (stop()) { statusEl.phase = 'stopped'; return { ok: false, stopped: true }; }
      statusEl.currentFile = f.rel;
      if (f.deleted) {
        const old = nextMeta.files[f.rel];
        if (old) { orphanSlots += old.chunks.length; delete nextMeta.files[f.rel]; }
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
        if (stop()) { statusEl.phase = 'stopped'; return { ok: false, stopped: true }; }
        statusEl.phase = 'error';
        statusEl.error = `嵌入失败 @ ${f.rel}: ${err.message}`;
        return { ok: false, error: statusEl.error };
      }
      if (!nextMeta.dim) nextMeta.dim = vectors[0]?.length || 0;
      else if (vectors[0]?.length !== nextMeta.dim) {
        statusEl.phase = 'error';
        statusEl.error = `向量维度(${vectors[0].length})与索引维度(${nextMeta.dim})不一致，请更换模型或清空索引后重建`;
        return { ok: false, error: statusEl.error };
      }
      const old = nextMeta.files[f.rel];
      if (old && old.chunks.length) orphanSlots += old.chunks.length;
      const record = [];
      for (let c = 0; c < chunks.length; c++) {
        const buf = Buffer.alloc(4 * nextMeta.dim);
        for (let d = 0; d < nextMeta.dim; d++) buf.writeFloatLE(Number(vectors[c][d]) || 0, d * 4);
        record.push({ o: nextMeta.totalChunks * nextMeta.dim, l: nextMeta.dim, text: chunks[c].text, line: chunks[c].line, heading: chunks[c].heading });
        dataChunks.push(buf);
        nextMeta.totalChunks += 1;
        statusEl.chunksDone += 1;
      }
      nextMeta.files[f.rel] = { mtime: f.mtime, size: f.size, chunks: record };
      statusEl.filesDone += 1;
    }

    statusEl.phase = 'saving';
    if (dataChunks.length) {
      let fd;
      try {
        fd = fs.openSync(VECTOR_DATA_FILE, 'a');
        for (const buf of dataChunks) fs.writeSync(fd, buf, 0, buf.length);
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    nextMeta.updatedAt = Date.now();
    saveVectorMeta(nextMeta);
    if (mode === 'incremental' && orphanSlots > 0 && orphanSlots > (statusEl.filesTotal || 1) * 200) {
      compactVectorData(nextMeta);
    }
    statusEl.phase = 'done';
    statusEl.currentFile = '';
    return { ok: true, files: files.length, chunks: vectorChunkCount(nextMeta), changed: changed.length };
  } catch (err) {
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
      for (const chunk of meta.files[rel].chunks) {
        for (let d = 0; d < meta.dim; d++) out.writeFloatLE(vectors[chunk.o + d] || 0, offset + d * 4);
        chunk.o = Math.floor(offset / 4);
        offset += meta.dim * 4;
      }
    }
    saveVectorData(out.subarray(0, offset));
    saveVectorMeta(meta);
  } catch (e) { console.error('[Vector Compaction Error]', e); }
}

function vectorWatchSetup(rootRel) {
  try {
    const prev = vectorStore.lastWatch;
    const rootAbs = rootRel ? path.join(ROOT, rootRel) : ROOT;
    if (prev && prev.rootAbs === rootAbs) return;
    if (prev) {
      try { prev.watcher && prev.watcher.close(); } catch {}
      if (prev.pollTimer) clearInterval(prev.pollTimer);
      vectorStore.lastWatch = null;
    }
    let watcher = null;
    try { watcher = fs.watch(rootAbs, { recursive: true }, () => scheduleIncremental(rootRel)); } catch { watcher = null; }
    const pollTimer = watcher ? null : setInterval(() => scheduleIncremental(rootRel), 30000);
    vectorStore.lastWatch = { rootAbs, watcher, pollTimer };
  } catch (e) { console.error('[Vector Watch Error]', e); }
}

function scheduleIncremental(rootRel) {
  if (!loadVectorMeta() || vectorStore.activeJob) return;
  if (Date.now() - vectorStore.lastIncrementalAt < 800) {
    vectorStore.pendingIncremental = true;
    return;
  }
  const meta = loadVectorMeta();
  if (!meta || meta.root !== rootRel) return;
  vectorStore.lastIncrementalAt = Date.now();
  vectorStore.activeJob = { runId: Date.now() + Math.random(), stop: false };
  vectorStore.status.phase = 'incremental';
  vectorStore.status.currentFile = '';
  runIndexJob({ runId: vectorStore.activeJob.runId, root: meta.root, provider: meta.provider, model: meta.model, mode: 'incremental' }).then(() => {
    if (vectorStore.pendingIncremental) {
      vectorStore.pendingIncremental = false;
      setTimeout(() => scheduleIncremental(rootRel), 300);
    }
  });
}

function vectorStatusPayload() {
  const meta = loadVectorMeta();
  const status = vectorStore.status;
  const watching = !!(vectorStore.lastWatch && (vectorStore.lastWatch.watcher || vectorStore.lastWatch.pollTimer));
  return {
    status,
    watching,
    config: meta ? { root: meta.root, provider: meta.provider, model: meta.model, dim: meta.dim } : null,
    files: meta ? Object.keys(meta.files).length : 0,
    chunks: meta ? vectorChunkCount(meta) : 0,
    updatedAt: meta ? meta.updatedAt : 0
  };
}

async function searchSemantic(query, { prefix = '', limit = 5 } = {}) {
  const meta = loadVectorMeta();
  const vectors = ensureVectorCache();
  if (!meta || !vectors || !query) return [];
  let qv;
  try { qv = (await embedTexts(meta.provider, meta.model, [String(query)]))[0]; }
  catch { return []; }
  const dim = meta.dim;
  const results = [];
  for (const rel of Object.keys(meta.files || {})) {
    if (prefix && !rel.startsWith(prefix)) continue;
    for (const chunk of meta.files[rel].chunks) {
      const sim = cosineSimilarity(qv, vectors.subarray(chunk.o, chunk.o + dim));
      if (sim > 0) results.push({ rel, line: chunk.line, text: chunk.text, heading: chunk.heading, score: sim });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/settings') {
    if (req.method === 'GET') return json(res, currentSettings());
    if (req.method === 'POST') {
      readBody(req).then(payload => {
        const { values, errors } = validateSettings(payload.values || payload);
        if (errors.length) return json(res, { ok: false, errors }, 400);
        writeDotEnvValues(values);
        if (Object.hasOwn(payload, 'dailyTemplate')) writeDailyTemplate(payload.dailyTemplate);
        return json(res, { ...currentSettings(), ok: true, requiresRestart: true });
      }).catch(error => json(res, { error: error.message || 'Unable to save settings' }, 400));
      return;
    }
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
    const limit = Math.min(Number(url.searchParams.get('limit') || 180), 500);
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
        writeMarkdown(payload.path, payload.content);
        updateNoteInMemory(payload.path);
        return json(res, { ok: true, path: payload.path });
      }).catch(error => json(res, { error: error.message || 'Unable to write note' }, 400));
      return;
    }
    const item = readNote(url.searchParams.get('path'));
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
  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    return json(res, { tasks: parseInboxTasks(), source: INBOX_REL });
  }
  if (url.pathname === '/api/task' && req.method === 'POST') {
    readBody(req).then(async payload => {
      const inboxContent = readVaultMarkdown(INBOX_REL);
      const lines = inboxContent === null ? [] : inboxContent.split(/\r?\n/);
      if (payload.action === 'add') {
        const text = String(payload.text || '').trim();
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
        const completedAt = String(payload.completedAt || new Date().toISOString().slice(0, 10));
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
    const preferred = ['qwen2.5:7b', 'qwen3.5:9b', 'qwen3:4b', 'llama3.1:8b'];
    const defaultModel = models.find((m) => m.provider === 'lmstudio')?.id
      || preferred.map(p => models.find(m => m.id === p)).find(Boolean)?.id
      || models[0]?.id || '';
    const defaultProvider = models.find(m => m.id === defaultModel)?.provider || 'ollama';
    return json(res, { models, defaultModel, defaultProvider });
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    readBody(req).then(async (payload) => {
      const question = String(payload.question || '').trim();
      if (!question) return json(res, { error: '问题不能为空' }, 400);

      const limit = Math.min(Number(payload.limit) || 5, 10);
      const path_prefix = String(payload.path_prefix || '').trim();
      const tag = String(payload.tag || '').trim();
      const history = Array.isArray(payload.history) ? payload.history.slice(-8) : [];
      let model = payload.model || 'qwen3.5:9b';
      let provider = payload.provider;
      if (!provider) {
        if (model.startsWith('deepseek')) provider = 'deepseek';
        else if (model.includes(':')) provider = 'ollama';
        else provider = 'lmstudio';
      }

      // 1. RAG Search over vault（关键词 + 向量语义，若索引存在且检索范围在其覆盖内）
      let sources = await searchVaultRAG(question, { limit, path_prefix, tag });
      const vecMeta = loadVectorMeta();
      const covered = !vecMeta || !path_prefix || path_prefix.startsWith(vecMeta.root || '') || (vecMeta.root || '').startsWith(path_prefix);
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
      sources = sources.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);

      // 2. Build Context Prompt
      const contextText = sources.length
        ? sources.map((s, i) => `[素材 ${i + 1}] 标题: ${s.title}\n路径: ${s.path} (行号: ${s.line})\n内容:\n${String(s.excerpt).slice(0, 800)}${s.excerpt.length > 800 ? '\n…（片段截断）' : ''}`).join('\n\n---\n\n')
        : '（知识库中暂未检索到高度相关的文档素材）';

      const systemPrompt = `你是一个基于用户 Markdown 知识库的专业智能助理。
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

      try {
        const answer = await callLLM({ messages, model, provider });
        return json(res, { ok: true, answer, sources, question, model, provider });
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
    await refreshFeeds(true);
    return json(res, feedsPayload());
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
      return json(res, { ok: true, path: rel });
    }).catch(() => json(res, { error: '保存失败' }, 500));
    return;
  }
  // ===================== 🧠 向量化检索 API =====================
  if (url.pathname === '/api/vector/status' && req.method === 'GET') {
    return json(res, vectorStatusPayload());
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
    return json(res, { models });
  }
  if (url.pathname === '/api/vector/index' && req.method === 'POST') {
    readBody(req).then(payload => {
      if (vectorStore.activeJob) return json(res, { ok: false, error: '已有向量化任务在运行' }, 409);
      const root = cleanRelPath(payload.root || '', '') || '';
      const provider = String(payload.provider || 'ollama');
      const model = String(payload.model || '').trim();
      if (!['ollama', 'lmstudio'].includes(provider)) return json(res, { ok: false, error: '无效的嵌入服务' }, 400);
      if (!model) return json(res, { ok: false, error: '请选择嵌入模型' }, 400);
      const rootAbs = root ? path.join(ROOT, root) : ROOT;
      if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) return json(res, { ok: false, error: '目录不存在或不是文件夹' }, 400);
      vectorStore.activeJob = { runId: Date.now() + Math.random(), stop: false };
      vectorStore.status = { phase: 'starting', filesTotal: 0, filesDone: 0, chunksDone: 0, currentFile: '', error: null };
      runIndexJob({ runId: vectorStore.activeJob.runId, root, provider, model, mode: 'full' }).then((res2) => {
        vectorWatchSetup(root);
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
    vectorStore.status = { phase: 'idle', filesTotal: 0, filesDone: 0, chunksDone: 0, currentFile: '', error: null };
    const prev = vectorStore.lastWatch;
    if (prev) {
      try { prev.watcher && prev.watcher.close(); } catch {}
      if (prev.pollTimer) clearInterval(prev.pollTimer);
      vectorStore.lastWatch = null;
    }
    return json(res, { ok: true });
  }
  if (url.pathname === '/api/vector/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    const prefix = url.searchParams.get('prefix') || '';
    const limit = Math.min(Number(url.searchParams.get('limit') || 5), 20);
    if (!q) return json(res, { error: '缺少查询词' }, 400);
    searchSemantic(q, { prefix, limit }).then(hits => {
      return json(res, { hits: hits.map(h => ({ path: h.rel, line: h.line, heading: h.heading, text: h.text, score: Math.round(h.score * 1000) / 1000 })) });
    });
    return;
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
server.listen(PORT, HOST, () => {
  console.log(`VaultDesk running at http://${HOST}:${PORT}`);
  const vecMeta = loadVectorMeta();
  if (vecMeta && vecMeta.root !== undefined) vectorWatchSetup(vecMeta.root);
});

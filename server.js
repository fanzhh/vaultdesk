import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const APP = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const envPath = path.join(APP, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
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
  const requested = path.resolve(ROOT, String(value || ''));
  return requested.startsWith(path.resolve(ROOT) + path.sep) && requested.toLowerCase().endsWith('.md') ? requested : null;
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
const INBOX_REL = '01_AREAS/Inbox.md';
function parseInboxTasks() {
  const abs = path.join(ROOT, INBOX_REL);
  const content = fs.readFileSync(abs, 'utf8');
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
  const abs = path.join(ROOT, INBOX_REL);
  const temp = `${abs}.webtmp-${process.pid}`;
  fs.writeFileSync(temp, lines.join('\n'), 'utf8');
  fs.renameSync(temp, abs);
}
function allowedWritePath(rel) {
  const normalized = String(rel || '').split(path.sep).join('/');
  const parts = normalized.split('/');
  return normalized.endsWith('.md') && parts.length > 0 && !parts.some(part => !part || part.startsWith('.') || SKIP.has(part));
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
function dailyFor(value) {
  const parts = dateParts(value);
  if (!parts) return null;
  const [year, month, day] = parts;
  const rel = `01_AREAS/Daily/${year}/${month}/${year}-${month}-${day}.md`;
  const abs = safeNotePath(rel);
  const templateRel = '00_META/templates/daily_note_template.md';
  let content = '';
  let exists = Boolean(abs && fs.existsSync(abs));
  if (exists) content = fs.readFileSync(abs, 'utf8');
  else {
    const template = fs.readFileSync(path.join(ROOT, templateRel), 'utf8');
    content = template.replaceAll('{{date:YYYY-MM-DD}}', value).replaceAll('{{date:YYYY-MM-DD HH:mm}}', `${value} 09:00`);
  }
  return { path: rel, title: value, content, exists, generated: !exists, date: value };
}
// ===================== 📡 RSS 资讯聚合 =====================
// RSS 源配置（feeds.json）、抓取缓存（data/feeds-cache.json）、已读状态（data/feed-read.json）
const FEEDS_JSON = path.join(APP, 'feeds.json');
const DATA_DIR = path.join(APP, 'data');
const FEED_CACHE_FILE = path.join(DATA_DIR, 'feeds-cache.json');
const FEED_READ_FILE = path.join(DATA_DIR, 'feed-read.json');
const RSS_INBOX_REL = '01_AREAS/reading/rss-inbox.md';
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
  const abs = path.join(ROOT, RSS_INBOX_REL);
  const line = `- [ ] 读：${title}（${source}）${link} #reading`;
  let content = '';
  if (fs.existsSync(abs)) content = fs.readFileSync(abs, 'utf8').trimEnd();
  else content = '# RSS Read Later\n\n> Saved from VaultDesk feeds.\n';
  content += `\n${line}\n`;
  writeMarkdown(RSS_INBOX_REL, content);
  return RSS_INBOX_REL;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
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
  if (url.pathname === '/api/note') {
    if (req.method === 'POST') {
      readBody(req).then(payload => {
        writeMarkdown(payload.path, payload.content);
        try {
          const abs = path.join(ROOT, payload.path);
          const stat = fs.statSync(abs);
          notes.unshift({ path: payload.path, title: path.basename(payload.path, '.md'), folder: path.dirname(payload.path), bytes: stat.size, mtime: stat.mtimeMs, tags: [] });
        } catch { /* 忽略索引更新失败 */ }
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
    const dates = notes.map(n => n.path.match(/^01_AREAS\/Daily\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\.md$/)?.[3]).filter(Boolean);
    return json(res, [...new Set(dates)].sort());
  }
  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    return json(res, { tasks: parseInboxTasks(), source: INBOX_REL });
  }
  if (url.pathname === '/api/task' && req.method === 'POST') {
    readBody(req).then(async payload => {
      const lines = fs.readFileSync(path.join(ROOT, INBOX_REL), 'utf8').split(/\r?\n/);
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
    const preferred = ['gemma4:e2b', 'qwen3.5:9b', 'qwen3:4b'];
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

      // 1. RAG Search over vault
      const sources = await searchVaultRAG(question, { limit, path_prefix, tag });

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
      const slug = question.slice(0, 30).replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'qa';
      const relPath = `02_RESOURCES/knowledge-fabric/outputs/answers/${dateStr}-answer-${slug}.md`;
      const absPath = path.join(ROOT, relPath);

      fs.mkdirSync(path.dirname(absPath), { recursive: true });
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

      fs.writeFileSync(absPath, mdLines.join('\n'), 'utf8');

      // Update memory index
      const stat = fs.statSync(absPath);
      notes.unshift({
        path: relPath,
        title: `问答: ${question}`,
        folder: path.dirname(relPath),
        bytes: stat.size,
        mtime: stat.mtimeMs,
        tags: ['ai-chat', 'qa', 'knowledge-fabric']
      });

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
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const abs = path.resolve(APP, 'public', '.' + file);
  if (!abs.startsWith(path.resolve(APP, 'public') + path.sep)) return json(res, { error: 'Not found' }, 404);
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, { error: 'Not found' }, 404);
    const ext = path.extname(abs); const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
    res.writeHead(200, { 'Content-Type': `${types[ext] || 'application/octet-stream'}; charset=utf-8` });
    const stream = fs.createReadStream(abs); stream.on('error', () => { if (!res.headersSent) json(res, { error: 'Not found' }, 404); else res.destroy(); }); stream.pipe(res);
  } catch { json(res, { error: 'Not found' }, 404); }
}
http.createServer(route).listen(PORT, HOST, () => console.log(`Web Obsidian running at http://localhost:${PORT} (LAN enabled)`));

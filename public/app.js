const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// Application State
const state = {
  mainView: 'daily', // 'daily' | 'tasks' | 'notes' | 'chat' | 'feeds' | 'settings'
  feeds: { sources: [], articles: [], activeKey: 'all', unreadOnly: false, loading: false, later: [] },
  notes: [],
  current: null, // Current note in Notes view
  folder: '',
  folderTree: [],
  expandedFolders: new Set(),
  view: 'all', // 'all' | 'recent' | 'drafts' | 'folder'
  query: '',
  listFilter: '',
  dates: [],
  dailyDate: '',
  dailyNote: null,
  inboxTasks: [],
  taskFilter: 'today', // 'today' | 'all' | 'overdue' | 'done' | 'tag:<标签名>'
  taskQuery: '',
  editingTaskLine: null,
  chatHistory: [],
  chatLoading: false,
  availableLLMs: [],
  selectedModel: '',
  selectedScope: '',
  taskSource: 'Inbox.md',
  settings: null,
  settingsLoading: false
};

// Storage Keys
const draftsKey = 'vaultdesk-drafts';
let taskAddInFlight = false; // 待办写回防重复提交
// localStorage 可能是损坏的旧数据，解析失败时当作空列表而不是让整个笔记模块抛错
const drafts = () => {
  try {
    const list = JSON.parse(localStorage.getItem(draftsKey) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
};
const saveDrafts = (value) => {
  try { localStorage.setItem(draftsKey, JSON.stringify(value)); }
  catch (e) { console.warn('[drafts] 草稿保存失败（可能超出浏览器存储配额）', e); }
};
const draftFor = (path) => drafts().find((d) => d.path === path);
function upsertDraft(note, content) {
  const path = note.path || `临时草稿/${note.title || t('未命名笔记')}.md`;
  const title = note.title || note.date || path.split('/').pop().replace(/\.md$/i, '');
  const next = {
    ...note,
    path,
    title,
    content,
    draft: true,
    generated: false,
    exists: true,
    mtime: Date.now()
  };
  saveDrafts([next, ...drafts().filter((d) => d.path !== path)]);
  const draftCount = $('#draftCount');
  if (draftCount) {
    draftCount.textContent = drafts().length;
    draftCount.hidden = drafts().length === 0;
  }
  return next;
}
let pendingDraftAutosaveTimer = null;
// 显式保存到知识库前调用：避免尚未触发的自动保存把刚删掉的草稿又写回来
function cancelPendingDraftAutosave() {
  if (pendingDraftAutosaveTimer) { clearTimeout(pendingDraftAutosaveTimer); pendingDraftAutosaveTimer = null; }
}
function bindDraftAutosave({ editor, note, statusEl, onSaved }) {
  if (!editor) return;
  const save = () => {
    pendingDraftAutosaveTimer = null;
    const saved = upsertDraft(note, editor.value);
    if (statusEl) statusEl.textContent = t('已自动保存到临时草稿 · {time}', { time: new Date(saved.mtime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    if (onSaved) onSaved(saved);
  };
  editor.addEventListener('input', () => {
    if (statusEl) statusEl.textContent = t('正在自动保存…');
    cancelPendingDraftAutosave();
    pendingDraftAutosaveTimer = setTimeout(save, 500);
  });
}

// Utility functions
const escapeHTML = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
}[c]));

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function time(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDate(dateStr, days) {
  const parts = String(dateStr || today()).split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return today();
  const date = new Date(parts[0], parts[1] - 1, parts[2] + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function showToast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2600);
}

function download(title, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/markdown' }));
  a.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ====================== 🌐 i18n 界面多语言 ======================
// 以中文原文为 key：t('保存') 中文原样返回，英文查 I18N_EN，缺词条时回退中文。
const LANG_KEY = 'vaultdesk-lang';
const I18N_EN = {
  // 侧栏 / 通用
  '本机运行 · 可写入 vault': 'Running locally · vault writable',
  '新建笔记': 'New note',
  '搜索笔记、路径或标签': 'Search notes, paths or tags',
  '核心模块': 'MODULES',
  '每日日记': 'Daily Note',
  '事项清单': 'Tasks',
  '资讯聚合': 'Feeds',
  '全部笔记': 'All Notes',
  '知识问答': 'Ask Vault',
  '最近更新': 'Recent',
  '临时草稿': 'Scratch Drafts',
  '系统设置': 'Settings',
  '今天': 'Today',
  '日历快速跳转': 'Jump to Date',
  '回到今天': 'Back to Today',
  '选择日期查看当日日记': 'Pick a date to view its daily note',
  'Vault 目录': 'Vault Folders',
  'Markdown vault': 'Markdown vault',
  '正在读取…': 'Loading…',
  '今日笔记': 'Notes of the day',
  '共 {n} 篇': '{n} notes in total',
  '共 {n} 篇 · 仅显示最近 50 篇': '{n} notes in total · showing latest 50',
  '当天没有新建或以日期命名的笔记': 'No notes created or named with this date',
  '打开侧边栏': 'Open sidebar',
  '专注阅读模式': 'Focus reading mode',
  '切换柔和配色': 'Toggle soft palette',
  '返回上一页': 'Back',
  '前进一页': 'Forward',
  '今日': 'Today',
  // 资讯聚合
  '🔄 刷新': '🔄 Refresh',
  '🔴 未读': '🔴 Unread',
  '✓ 全部已读': '✓ Mark all read',
  '添加 RSS 源 URL...': 'Add RSS feed URL...',
  '＋ 添加': '＋ Add',
  '全部文章': 'All Articles',
  '📥 稍后读': '📥 Read Later',
  '未读': 'unread',
  '篇': 'items',
  '待读': 'to read',
  '空': 'empty',
  '共 {n} 篇{suffix} · 点击文章自动标记已读并在新标签打开': '{n} articles{suffix} · Clicking an article marks it read and opens it in a new tab',
  '（未读）': ' (unread)',
  '暂无文章，点「刷新」拉取': 'No articles yet — hit "Refresh" to fetch',
  '没有未读文章 🎉': 'All caught up 🎉',
  '已存入稍后读': 'Saved to Read Later',
  '保存失败': 'Save failed',
  '已存': 'Saved',
  '已读完': 'Done',
  '✓ 读完': '✓ Done',
  '↺ 恢复': '↺ Unread',
  '共 {n} 条 · 保存在 vault 的 read-later.md，Obsidian 同样可见 · 点击文章在新标签打开': '{n} items · stored in vault read-later.md (visible in Obsidian) · click to open in a new tab',
  '暂无稍后读条目，在文章上点「📥 稍后读」收藏': 'Nothing here yet — use "📥 Read Later" on any article',
  '确定要从稍后读中移除此条目吗？': 'Remove this item from Read Later?',
  '已从稍后读移除': 'Removed from Read Later',
  '操作失败': 'Operation failed',
  '已全部标记为已读': 'All marked as read',
  '已读': 'read',
  '条目不存在或文件已变化': 'Item not found or file changed',
  // 日记
  '日记': 'Daily',
  'RSS 订阅源': 'RSS Feeds',
  '每日手记': 'Daily Note',
  '文件路径: {p}': 'File path: {p}',
  '字数: {n} 字': '{n} words',
  '✏️ 编辑': '✏️ Edit',
  '↓ 下载 .md': '↓ Download .md',
  '当日待办与已办事项': "Today's Tasks",
  '待办 {n} 项': '{n} to do',
  '已办 {n} 项': '{n} done',
  '打开待办中心 ➔': 'Open Tasks ➔',
  '待办事项': 'To Do',
  '已办事项': 'Done',
  '今天没有待办事项': 'Nothing due today',
  '今天没有已办事项': 'Nothing done yet today',
  '编辑': 'Edit',
  '删除': 'Delete',
  '已成功基于模板创建日记': 'Daily note created from template',
  '取消': 'Cancel',
  '💾 保存到知识库': '💾 Save to Vault',
  '正在自动保存…': 'Auto-saving…',
  '输入后会自动保存到临时草稿': 'Typing auto-saves to scratch drafts',
  // 待办
  '编辑待办事项': 'Edit Task',
  '事项内容与标签': 'Task text & tags',
  '事项内容...': 'Task text...',
  '🗑 删除此事项': '🗑 Delete task',
  '保存更改': 'Save changes',
  '待办已标记完成': 'Task completed',
  '已恢复为未完成': 'Task reopened',
  '待办事项已删除': 'Task deleted',
  '确定要从待办文件中删除此事项吗？\n\n"{s}"': 'Delete this task from the task file?\n\n"{s}"',
  '此事项': 'this task',
  '逾期': 'Overdue',
  '已完成': 'Done',
  // 笔记
  '＋ 新建笔记': '＋ New Note',
  '从原始 vault 直接读取，保持文件不变': 'Read straight from the vault — files stay untouched',
  '在当前列表中快速过滤...': 'Filter current list...',
  '打开一篇笔记': 'Open a note',
  '在左侧列表中选择笔记，开始浏览或编辑。': 'Pick a note from the list to read or edit it.',
  '快捷键：⌘ K 搜索 · 点击左侧卡片打开': 'Shortcuts: ⌘ K to search · click a card to open',
  '标题': 'Title',
  '笔记标题': 'Note title',
  '存放位置': 'Location',
  '正在读取 vault 目录…': 'Loading vault folders…',
  '正文（Markdown）': 'Body (Markdown)',
  '正文内容...': 'Note body...',
  '＋ 创建': '＋ Create',
  '笔记已创建': 'Note created',
  '已保存到知识库': 'Saved to vault',
  '保存失败：{e}': 'Save failed: {e}',
  '草稿已删除': 'Draft deleted',
  '确定要删除这份临时草稿吗？': 'Delete this scratch draft?',
  '临时草稿保存在浏览器 localStorage，不会写入 vault': 'Scratch drafts live in browser localStorage and never touch the vault',
  // 知识问答
  '知识库智能问答': 'Knowledge Assistant (RAG)',
  '模型:': 'Model:',
  '检索范围:': 'Scope:',
  '全知识库': 'Whole vault',
  '🧹 清空记录': '🧹 Clear chat',
  '推荐提问:': 'Try asking:',
  '📋 周重点总结': '📋 Weekly digest',
  '✅ 待办跟进': '✅ Task follow-up',
  '🧭 主题索引': '🧭 Topic index',
  '发送': 'Send',
  '输入你想咨询知识库的问题... (支持多轮连续追问，Enter 发送，Shift+Enter 换行)': 'Ask anything about your vault... (Enter to send, Shift+Enter for a new line)',
  '对话已清空': 'Chat cleared',
  '正在思考…': 'Thinking…',
  '回答失败': 'Failed to answer',
  // 设置
  '网页配置': 'Web Settings',
  '设置已保存': 'Settings saved',
  '部分配置需要重启服务后生效': 'Some settings take effect after restarting the service',
  '恢复默认模板': 'Reset template',
  '测试连接': 'Test connection',
  '连通': 'OK',
  '失败': 'Failed',
  // 目录选择器
  '📂 选择目录': '📂 Choose a Folder',
  '⬆ 上级': '⬆ Up',
  '🏠 主目录': '🏠 Home',
  '选择此目录': 'Use This Folder',
  '空目录': 'Empty folder',
  // 杂项
  '秒前': 's ago',
  '分钟前': 'min ago',
  '小时前': 'h ago',
  '天前': 'd ago',
  '刚刚': 'just now',
  // ---- 日记 / 任务 / 笔记 ----
  '未命名笔记': 'Untitled Note',
  '已自动保存到临时草稿 · {time}': 'Auto-saved to scratch draft · {time}',
  'Dataview 动态查询': 'Dataview dynamic query',
  '🖼 图片：': '🖼 Image: ',
  '待办写回失败': 'Failed to write tasks',
  '笔记写回失败': 'Failed to write note',
  '设置保存失败': 'Failed to save settings',
  '优先': 'priority',
  '完成': 'Done',
  '待办已更新': 'Task updated',
  '日记加载失败': 'Failed to load daily note',
  '知识库已归档': 'Archived to vault',
  '当日未建档': 'No daily note yet',
  '当天没有待办事项': 'No open tasks for this day',
  '当天还没有完成的事项': 'Nothing completed yet on this day',
  '当天没有排期的待办事项': 'No scheduled tasks for this day',
  '暂无日记记录': 'No daily note yet',
  '当前 Vault 中尚未创建这一天的日记文件，你可以基于默认模版快速生成。': 'This day has no daily note in the vault yet — create one from the default template in one click.',
  '当前 Vault 中尚未创建这一天的日记文件，你可以基于 vault 日记模板快速生成。': 'This day has no daily note in the vault yet — create one from the vault daily template in one click.',
  '模板预览': 'Template preview',
  '＋ 基于模板一键创建': '＋ Create from template',
  '前一天 (快捷键: ←)': 'Previous day (←)',
  '前一天': 'Previous day',
  '后一天 (快捷键: →)': 'Next day (→)',
  '后一天': 'Next day',
  '日记已成功写回知识库': 'Daily note saved to vault',
  'Inbox ({n} 项未完成)': 'Inbox ({n} open)',
  '今日待办': 'Due today',
  '项': 'items',
  '已逾期待办': 'Overdue',
  '收件箱全部未完': 'All open in Inbox',
  '历史已完成': 'Completed',
  '＋ 添加新待办事项... (输入 #标签 或点击下方快捷插入)': '＋ Add a task... (#tag or quick buttons below)',
  '＋ 写回待办文件': '＋ Write to task file',
  '快捷标签:': 'Quick tags:',
  '优先级': 'Priority',
  '🌟 今日待办': '🌟 Due today',
  '⚠️ 逾期待办': '⚠️ Overdue',
  '📋 全部未完成': '📋 All open',
  '✅ 已完成': '✅ Completed',
  '搜索待办...': 'Search tasks...',
  '逾期未完成事项': 'Overdue open tasks',
  '{n} 项': '{n} items',
  '今日到期事项': 'Due today',
  '未来排期事项': 'Upcoming',
  '收件箱待办池 (未设定日期)': 'Inbox pool (no date)',
  '当前分类下没有匹配的事项': 'No matching tasks in this view',
  '待办事项与任务流': 'Tasks & Workflow',
  '数据源: {s}': 'Source: {s}',
  '待办已写回': 'Tasks written back',
  '知识库笔记': 'Vault Notes',
  '临时草稿只保存在当前浏览器，不会自动写回 vault': 'Scratch drafts live in this browser only — never written back to the vault',
  '没有找到匹配笔记': 'No matching notes found',
  '这篇笔记暂时无法读取': 'This note cannot be read right now',
  '没有找到对应的笔记「{s}」': 'No note found for “{s}”',
  '本机临时草稿': 'Local scratch draft',
  '继续编辑': 'Keep editing',
  '已成功写回知识库': 'Saved to vault',
  '待处理': 'Pending',
  '完成': 'Done',
  '取消': 'Cancelled',
  '等待': 'Waiting',
  '已标记为{s}': 'Marked as {s}',
  // ---- 稍后读补充 ----
  '切换读完状态': 'Toggle read status',
  '从稍后读移除': 'Remove from Read Later',
  '已在稍后读': 'Already in Read Later',
  '存入稍后读': 'Save to Read Later',
  '标记已读': 'Mark as read',
  // ---- 设置：字段 ----
  'Vault 根目录': 'Vault root',
  '本机 Markdown vault（如 Obsidian 库）的绝对路径，启动后会在其中扫描笔记。修改后需重启服务。可直接填写，也可点"选择…"弹窗浏览目录。': 'Absolute path of the local Markdown vault (e.g. an Obsidian vault). Notes are scanned from it at startup. Restart required after changes. Type it directly, or use "Browse…" to pick a folder.',
  '待办文件': 'Task file',
  'Vault 内相对路径。事项清单读写此文件，第一次新增待办时会自动创建。可直接填写，也可点"选择…"弹窗选目录，文件名自动保留。': 'Relative path inside the vault. The Tasks module reads and writes this file; it is created on first task. Type it, or use "Browse…" to pick a folder — the file name is kept.',
  '每日笔记路径': 'Daily note path',
  '必须包含 {YYYY}、{MM}、{DD}。决定每日日记在 vault 中的位置。可直接填写，也可点"选择…"弹窗选目录，文件名模板自动保留。': 'Must contain {YYYY}, {MM}, {DD}. Decides where daily notes live in the vault. Type it, or use "Browse…" — the file-name template is kept.',
  'RSS 稍后读文件': 'RSS read-later file',
  '在「资讯聚合」中保存条目时写入的 Markdown 文件。': 'Markdown file written when you save articles from Feeds.',
  '问答保存路径': 'Q&A save path',
  '点击「保存为笔记」时问答内容的存放位置。必须包含 {slug}，可使用 {YYYY}、{MM}、{DD}、{date}。': 'Where saved Q&As go. Must contain {slug}; may use {YYYY}, {MM}, {DD}, {date}.',
  '本地模型服务地址（LM Studio）': 'Local model server URL (LM Studio)',
  '知识问答与语义索引通过此 OpenAI 兼容接口调用本机大模型。装有 LM Studio 时保持默认即可；只用 Ollama 或 DeepSeek 时可忽略本项。': 'Q&A and semantic indexing call local LLMs through this OpenAI-compatible endpoint. Keep the default when running LM Studio; ignore it if you only use Ollama or DeepSeek.',
  '默认模型': 'Default model',
  '留空 = 自动选择（LM Studio 优先）': 'Leave empty = auto pick (LM Studio first)',
  '知识问答默认使用此模型，问答页仍可临时切换。可从下拉建议中选择本机或自定义服务的模型；所选服务离线时自动回退到其它可用模型。': 'Default model for Q&A; you can still switch per chat. Pick from local or custom-provider models; if that server is offline it falls back to another available model.',
  '关键词检索脚本（可选）': 'Keyword search script (optional)',
  '留空 = 使用内置检索': 'Leave empty = built-in search',
  '知识问答默认使用内置关键词检索，零配置可用。若自备了检索脚本（如基于 ripgrep 的 kb-search.py），填绝对路径即可替换内置实现；脚本缺失或出错时自动回退内置检索。': 'Q&A uses the built-in keyword search by default — zero config. To use your own script (e.g. a ripgrep-based kb-search.py), fill its absolute path; it falls back to the built-in search if missing or failing.',
  'Qdrant 向量数据库（可选加速）': 'Qdrant vector database (optional speedup)',
  '留空 = 使用内置检索。配置后语义检索改走 Qdrant 的向量索引（52 万块从约 1 秒降到毫秒级），首次会自动把已有向量同步过去（约几分钟）。本机启动：docker run -d --name qdrant -p 127.0.0.1:6333:6333 qdrant/qdrant': 'Leave empty for built-in search. When set, semantic search runs on a Qdrant ANN index (~520k chunks: ~1s down to milliseconds); existing vectors sync over automatically on first use (a few minutes). Start locally: docker run -d --name qdrant -p 127.0.0.1:6333:6333 qdrant/qdrant',
  '检索 {s} 秒': 'Search {s}s',
  '生成 {s} 秒': 'Generated in {s}s',
  '■ 停止生成': '■ Stop',
  '（已停止）': '(Stopped)',
  '监听地址': 'Listen address',
  '默认仅本机访问；只建议在可信局域网内改为 0.0.0.0。': 'Localhost only by default; switch to 0.0.0.0 only on a trusted LAN.',
  '端口': 'Port',
  '1-65535 的数字，默认 4177。': 'A number from 1-65535; default 4177.',
  // ---- 设置：标签页 ----
  '知识库': 'Vault',
  'VaultDesk 读取和写入笔记的位置。': 'Where VaultDesk reads and writes notes.',
  '保存位置': 'Save locations',
  '问答内容保存到 vault 时使用的路径，为 vault 内相对路径。': 'Path used when saving Q&A into the vault (relative).',
  '「资讯聚合」模块订阅的 RSS 源与稍后读保存位置。': 'RSS feeds subscribed by the Feeds module and where read-later items are stored.',
  'AI 大模型': 'AI Models',
  '知识问答的对话模型来源。本机没有安装任何模型服务时，除知识问答外的功能不受影响。': 'Where chat models come from. Without any model service, everything except Q&A keeps working.',
  '知识检索': 'Knowledge Search',
  '问答取材方式：内置关键词检索默认生效、无需配置；自备脚本、语义向量检索与 LLM Wiki 知识库均为可选增强。': 'How Q&A gathers material: the built-in keyword search works out of the box; a custom script, semantic vector search and the LLM Wiki knowledge base are optional upgrades.',
  '服务地址': 'Server',
  'VaultDesk 网页服务监听的本机地址与端口。': 'Address and port the VaultDesk web server listens on.',
  // ---- 设置：状态 / 通用 ----
  '未检测到大模型服务，知识问答暂不可用。可安装并启动 LM Studio 或 Ollama，配置 DeepSeek，或在设置中添加自定义模型服务。': 'No LLM service detected — Q&A unavailable for now. Install and start LM Studio or Ollama, configure DeepSeek, or add a custom provider in Settings.',
  '本机可用模型 {n} 个': '{n} local models available',
  'DeepSeek 云端已配置': 'DeepSeek cloud configured',
  '自定义服务 {n} 个': '{n} custom providers',
  '已连接 · {s}': 'Connected · {s}',
  '检测失败：{e}': 'Check failed: {e}',
  '选择…': 'Browse…',
  '名称': 'Name',
  '例如 DeepSeek 官方': 'e.g. DeepSeek Official',
  '服务地址（Base URL）': 'Base URL',
  'API Key': 'API Key',
  '已配置，留空保持不变': 'Configured — leave empty to keep',
  '可留空（本地服务通常不需要）': 'Optional (local servers usually do not need it)',
  '模型名称（多个用逗号分隔）': 'Model names (comma-separated)',
  '测试连通性': 'Test connection',
  'VaultDesk 配置': 'Configuration',
  '正在读取配置…': 'Loading configuration…',
  '配置读取失败：{e}': 'Failed to load config: {e}',
  '配置已保存，重启 VaultDesk 后生效。': 'Settings saved. Restart VaultDesk to apply.',
  '重新读取': 'Reload',
  '当前 vault': 'Current vault',
  '配置文件': 'Config file',
  '填入默认值': 'Fill defaults',
  '保存设置': 'Save settings',
  '请先设置 Vault 根目录，再选择文件位置': 'Set the vault root first, then pick a file location',
  '路径需要位于 vault 内，请重新选择': 'The path must be inside the vault — pick again',
  '语义索引目录需要位于 vault 内，请重新选择': 'The semantic index directory must be inside the vault — pick again',
  // ---- 设置：RSS 源 / AI 面板 ----
  'RSS 源列表（每行一个：名称 | URL | 每源条数，名称和条数可省略）': 'RSS feed list (one per line: name | URL | items per feed; name and count optional)',
  '当前使用上面的自定义源；': 'Using the custom feeds above; ',
  '当前使用内置默认源；': 'Using the built-in default feeds; ',
  '清空保存即恢复内置默认。示例：少数派 | https://sspai.com/feed | 10。保存后新增源会自动抓取，也可在「资讯聚合」页手动刷新。': 'clear and save to restore defaults. Example: Sspai | https://sspai.com/feed | 10. New feeds are fetched automatically after saving; you can also refresh manually in the Feeds view.',
  '服务状态': 'Service status',
  '正在检测本机模型服务…': 'Detecting local model services…',
  '内置本地服务': 'Built-in local services',
  '固定连接本机 127.0.0.1:11434，自动检测': 'Always connects to 127.0.0.1:11434, auto-detected',
  '获取本地模型': 'Fetch local models',
  '使用上方「本地模型服务地址」连接': 'Connects via the "Local model server URL" above',
  '自定义模型服务（OpenAI 兼容）': 'Custom model services (OpenAI-compatible)',
  '接入任意 OpenAI 兼容服务（DeepSeek 官方、第三方中转、vLLM 等）。保存后，其模型会出现在问答模型下拉和「知识检索」的嵌入服务中。': 'Connect any OpenAI-compatible service (official DeepSeek, third-party relays, vLLM, etc.). After saving, its models appear in the chat model dropdown and in the embedding services of Knowledge Search.',
  '＋ 添加服务': '＋ Add service',
  '正在获取…': 'Fetching…',
  '获取失败': 'Fetch failed',
  '连接成功，但未发现已下载的模型。': 'Connected, but no downloaded models found.',
  '{label}（{n} 个）：': '{label} ({n} models):',
  '正在测试…': 'Testing…',
  '✓ 连通成功，{n} 个模型{s}': '✓ Connected, {n} models{s}',
  '已删除该自定义服务': 'Custom service deleted',
  '删除失败': 'Delete failed',
  '自定义：{s}': 'Custom: {s}',
  // ---- 设置：每日模板 / 向量检索 ----
  '每日笔记模板': 'Daily note template',
  '新建每日笔记时使用的模板，保存到应用自己的 data/daily-template.md。支持 {{date}}、{{YYYY}}、{{MM}}、{{DD}} 及 Obsidian 风格的 {{date:YYYY-MM-DD}}。配置上方「日记模板文件」后优先使用该文件。': 'Template used when creating a daily note; stored in the app data folder as data/daily-template.md. Supports {{date}}, {{YYYY}}, {{MM}}, {{DD}} and Obsidian-style {{date:YYYY-MM-DD}}. If a template file is configured above, that file takes precedence.',
  '向量化语义搜索（可选）': 'Semantic vector search (optional)',
  '索引状态': 'Index status',
  '向量化的目录（vault 内相对路径，留空 = 整个 vault）': 'Directory to index (vault-relative, empty = whole vault)',
  '例如 notes、Daily': 'e.g. notes, Daily',
  '建立索引后，目录内 .md/.txt 的新增与修改会被监控并自动增量更新。': 'Once indexed, new or changed .md/.txt files in the directory are watched and updated incrementally.',
  '嵌入服务': 'Embedding service',
  'Ollama（本机 11434）': 'Ollama (local 11434)',
  'LM Studio（OpenAI 兼容接口）': 'LM Studio (OpenAI-compatible API)',
  '对目录分块后调用本机嵌入模型生成向量，全部数据保存在应用 data/ 目录。': 'Chunks the directory, then calls a local embedding model to build vectors; all data stays in the app data/ folder.',
  '嵌入模型': 'Embedding model',
  '正在读取嵌入模型…': 'Loading embedding models…',
  '可从下拉建议中选择，也可直接输入嵌入服务里已有的任意模型 id（如 qwen3-embedding、bge-m3、nomic-embed-text）。': 'Pick from the suggestions, or type any model id your embedding service offers (e.g. qwen3-embedding, bge-m3, nomic-embed-text).',
  '开始向量化': 'Start indexing',
  '停止': 'Stop',
  '清空索引': 'Clear index',
  // ---- 向量索引状态 ----
  '正在启动': 'Starting',
  '正在扫描目录': 'Scanning directory',
  '正在生成向量': 'Generating vectors',
  '正在保存索引': 'Saving index',
  '增量更新中': 'Incremental update',
  '已停止': 'Stopped',
  '出错': 'Error',
  '空闲': 'Idle',
  '状态读取失败': 'Failed to read status',
  '已索引 {f} 个文件 · {c} 块 · {r} · 模型 {m}{w}': 'Indexed {f} files · {c} chunks · {r} · model {m}{w}',
  '目录监控中': 'watching',
  '索引进行中': 'Indexing in progress',
  '未建立索引 —— 选择目录与嵌入模型后开始': 'No index yet — pick a directory and an embedding model to start',
  '{phase} · 文件 {d}/{tot} · 本轮生成 {c} 块{cur}': '{phase} · files {d}/{tot} · {c} chunks this round{cur}',
  '当前': 'current',
  '完成：共 {f} 个文件 / {c} 块': 'Done: {f} files / {c} chunks in total',
  '向量化运行中…': 'Indexing running…',
  '重建索引': 'Rebuild index',
  '未检测到嵌入模型，可手动输入模型 id（Ollama 中执行 ollama pull qwen3-embedding 或 bge-m3）': 'No embedding models detected — type a model id (run "ollama pull qwen3-embedding" or "bge-m3" in Ollama)',
  '未检测到嵌入模型，可手动输入模型 id（在 LM Studio 加载 embedding 模型）': 'No embedding models detected — type a model id (load an embedding model in LM Studio)',
  '该服务未检测到嵌入模型，可手动输入模型 id': 'No embedding models detected on this service — type a model id',
  '可从建议中选择，或直接输入模型 id': 'Pick from suggestions or type a model id',
  '模型列表读取失败：{e}，可手动输入模型 id': 'Failed to load model list: {e} — type a model id manually',
  '请先选择或输入一个嵌入模型': 'Pick or type an embedding model first',
  '启动失败': 'Failed to start',
  '向量化任务已启动，完成后知识问答将自动启用语义检索': 'Indexing started — semantic search in Q&A turns on automatically when done',
  '已发送停止指令': 'Stop command sent',
  '确定清空向量索引？语义检索将退回关键词模式。': 'Clear the vector index? Semantic search falls back to keyword mode.',
  '清空失败': 'Failed to clear',
  '向量索引已清空': 'Vector index cleared',
  // ---- 知识问答 ----
  '🧠 语义检索未启用（可在设置中向量化目录）': '🧠 Semantic search off (index a directory in Settings)',
  '🧠 语义检索 · {f} 文件 / {c} 块 · {m}{w}': '🧠 Semantic search · {f} files / {c} chunks · {m}{w}',
  '监控中': 'watching',
  '🧠 语义检索不可用': '🧠 Semantic search unavailable',
  'RAG 智能对话': 'RAG Chat',
  '未检测到大模型服务（LM Studio / Ollama / DeepSeek）': 'No LLM service detected (LM Studio / Ollama / DeepSeek)',
  '模型列表读取失败': 'Failed to load model list',
  '确定要清空当前对话记录吗？': 'Clear the current conversation?',
  '基于知识库的智能对话助手': 'A chat assistant grounded in your vault',
  '提问后系统会先在本地 Markdown vault 中检索相关素材，再由大模型基于真实内容进行总结与解答，支持连续追问与来源溯源。': 'Each question first retrieves relevant material from your local Markdown vault, then the LLM answers based on that real content — with follow-ups and source tracing.',
  '检索近期笔记并整理主要事项、结论和后续动作': 'Gather recent notes and summarize key items, conclusions and next actions',
  '从知识库中提取近期任务、截止日期和未完成事项': 'Extract recent tasks, deadlines and open items from the vault',
  '按主题聚合相关笔记，生成可继续扩展的索引': 'Cluster related notes by topic into an index you can keep extending',
  '我': 'Me',
  '🔍 知识库检索素材 ({n} 篇参考依据)': '🔍 Vault sources ({n} references)',
  '匹配分: {s} · 行: {l}': 'Score: {s} · line: {l}',
  '📋 复制回答': '📋 Copy answer',
  '💾 保存为 Wiki 笔记': '💾 Save as note',
  '正在知识库中 RAG 检索相关素材并深入思考中...': 'Retrieving vault material and thinking...',
  '回答内容已复制到剪贴板': 'Answer copied to clipboard',
  '知识库问答': 'Vault Q&A',
  '保存中...': 'Saving...',
  '已成功保存为 Wiki 笔记': 'Saved as a note',
  '✓ 已保存': '✓ Saved',
  '⚠️ **问答失败**': '⚠️ **Q&A failed**',
  '无法从模型获取回答': 'No answer from the model',
  '⚠️ **网络或接口异常**': '⚠️ **Network or API error**',
  // ---- 侧栏 / 弹窗 / 其它 ----
  '展开或收起': 'Expand or collapse',
  '暂无目录': 'No folders',
  '{mb} MB · {n} 目录': '{mb} MB · {n} folders',
  '已添加 {n}，正在拉取…': 'Added {n} — fetching…',
  '添加失败': 'Failed to add',
  '此目录下没有可见子目录，可直接「选择此目录」': 'No visible subdirectories here — use "Select this folder"',
  '请填写标题': 'Please enter a title',
  'LLM Wiki 服务地址（可选）': 'LLM Wiki API URL (optional)',
  '填写 LLM Wiki 桌面应用开放的本地 API 地址（留空 = 不启用）。启用后知识问答会把 Wiki 项目的检索命中并入参考素材，来源可在阅读器中只读打开。': 'URL of the local API exposed by the LLM Wiki desktop app (leave empty to disable). When enabled, Q&A merges retrieval hits from the Wiki project into its references; sources open read-only in the reader.',
  'LLM Wiki 访问令牌': 'LLM Wiki access token',
  '可留空（未开启访问控制时不需要）': 'Optional (not needed when access control is off)',
  'LLM Wiki 开启 API 访问控制时必填。令牌只写入本机配置文件，不会回显或上传。': 'Required when LLM Wiki enables API access control. The token is written to the local config file only — never echoed back or uploaded.',
  'LLM Wiki 项目': 'LLM Wiki project',
  '检索哪个 Wiki 项目：填项目 id，或保持 current 使用 LLM Wiki 中当前打开的项目。': 'Which Wiki project to search: a project id, or keep "current" to use the project currently open in LLM Wiki.',
  '未配置：填写上方服务地址即启用': 'Not configured — fill in the API URL above to enable',
  '连接失败': 'Connection failed',
  '{n} 个项目': '{n} projects',
  '当前：{s}': 'current: {s}',
  '未设令牌': 'no token',
  'LLM Wiki 知识库（可选）': 'LLM Wiki knowledge base (optional)',
  '连接状态': 'Connection status',
  '正在检测 LLM Wiki…': 'Detecting LLM Wiki…',
  '连接 LLM Wiki 桌面应用的本地 API。启用后知识问答会并入其项目的检索结果，来源在阅读器中只读打开，不会写入 vault。': 'Connects to the local API of the LLM Wiki desktop app. When enabled, Q&A merges its project retrieval results; sources open read-only in the reader and are never written to the vault.',
  '重启服务': 'Restart server',
  '立即重启': 'Restart now',
  '确定重启 VaultDesk 服务吗？重启后页面会自动恢复。': 'Restart the VaultDesk server? The page will recover automatically once it is back.',
  '正在重启…': 'Restarting…',
  '服务已重启': 'Server restarted',
  '重启失败：服务未能在 30 秒内恢复。': 'Restart failed: the server did not come back within 30 seconds.',
  '向量化的目录（vault 内相对路径，可添加多个；留空 = 整个 vault）': 'Folders to index (vault-relative paths, add multiple; empty = entire vault)',
  '添加': 'Add',
  '整个 vault': 'entire vault',
  '{n} 个目录': '{n} folders',
  '移除': 'Remove',
  '可添加多个目录后一次性建立索引；目录内 .md/.txt 的新增与修改会被监控并自动增量更新。列表为空时索引整个 vault。目录选择会自动保存在本机浏览器，无需点保存。': 'Add multiple folders and index them in one go; new and changed .md/.txt files inside are watched and indexed incrementally. An empty list indexes the entire vault. Your folder selection is saved in this browser automatically — no need to click Save.',
  '请先输入或选择一个目录': 'Enter or pick a folder first',
  '请先设置 Vault 根目录': 'Set the vault root folder first',
  '已停止：任务已中止，已嵌入的内容已保存。重新点「开始向量化」可从上次进度继续。': 'Stopped: the job was aborted and the embedded progress was saved. Click "Start" again to resume where it left off.',
  '（{k} 个文件嵌入失败已跳过）': '({k} files failed to embed and were skipped)',
  '以下 {n} 个文件嵌入失败已跳过（不影响其它文件的检索）：': '{n} files failed to embed and were skipped (other files remain searchable):',
  '日记模板文件（可选）': 'Daily note template file (optional)',
  '填写 vault 内的模板文件后，新建每日笔记优先使用它（支持 Obsidian 的 {{date:YYYY-MM-DD}} 格式占位符）；文件缺失时回退到「每日笔记模板」编辑器的内容。可直接填写，也可点"选择…"弹窗选目录，文件名自动保留。': 'When set, new daily notes use this vault template file first (supports Obsidian {{date:YYYY-MM-DD}} placeholders); if the file is missing, the built-in template editor above is used. Type it directly or pick a folder via the dialog — the file name is kept.',
  '当前生效：vault 模板文件（{f}）': 'In effect: vault template file ({f})',
  '配置的模板文件不存在或不可读，当前生效：内置模板': 'The configured template file is missing or unreadable — the built-in template is in effect',
  '当前生效：内置模板': 'In effect: built-in template',
  '初始化失败': 'Initialization failed',
  '无法读取应用数据：服务可能正在重启或暂时不可用。': 'Could not load app data — the server may be restarting or temporarily unavailable.',
  '重试': 'Retry',
  '文档导入': 'Document Import',
  '把外部文件夹中的文档转换为 Markdown 导入 vault，可添加多个文件夹并定时监控增量导入。': 'Convert documents in external folders to Markdown and import them into the vault; add multiple folders and schedule incremental imports.',
  '转换环境': 'Conversion environment',
  'Python 转换环境': 'Python conversion environment',
  '正在检测…': 'Detecting…',
  '重新检测': 'Re-detect',
  '文档转换使用装有 firecrawl-anydoc 的 Python 环境（自动探测，也可在 .env 用 DOC_IMPORT_PYTHON 指定解释器）。未探测到时仅能导入 .md/.txt/.csv。': 'Document conversion uses a Python environment with firecrawl-anydoc installed (auto-detected; you can also set DOC_IMPORT_PYTHON in .env). Without it, only .md/.txt/.csv can be imported.',
  '未检测到 Python —— 仅能导入 .md/.txt/.csv': 'Python not found — only .md/.txt/.csv can be imported',
  '可用 · anydoc 已安装（{p}）': 'Ready · anydoc installed ({p})',
  'Python 可用但未安装 anydoc —— 仅能导入 .md/.txt/.csv': 'Python found but anydoc is missing — only .md/.txt/.csv can be imported',
  '导入状态': 'Import status',
  '导入进行中：{phase}': 'Importing: {phase}',
  '正在扫描文件夹': 'scanning folder',
  '已配置 {n} 个导入源': '{n} import sources configured',
  '未配置导入源': 'No import sources configured',
  '文件 {d}/{tot} · 转换 {c} · 跳过 {sk} · 失败 {f}{cur}': 'Files {d}/{tot} · converted {c} · skipped {sk} · failed {f}{cur}',
  '导入已停止：已转换的文件已保存。': 'Import stopped — converted files were kept.',
  '{n} 个文件转换失败：': '{n} files failed to convert:',
  '还没有导入源——在下方添加一个文件夹开始导入。': 'No import sources yet — add a folder below to get started.',
  'vault 根目录': 'vault root',
  '监控中 · 每 {n} 分钟': 'watched · every {n} min',
  '未监控': 'not watched',
  '已导入 {n} 个文件': '{n} files imported',
  '{n} 个失败': '{n} failed',
  '上次：{n} 文件（转 {ok}/跳 {sk}/败 {f}）· {time}': 'last run: {n} files ({ok} converted / {sk} skipped / {f} failed) · {time}',
  '立即导入': 'Import now',
  '停止监控': 'Stop watching',
  '开启监控': 'Watch',
  '删除该导入源？只移除导入关系与记录，已导入 vault 的笔记文件会保留。': 'Remove this import source? Only the mapping and records are removed; notes already imported into the vault are kept.',
  '源文件夹绝对路径，如 /Users/you/Documents': 'Absolute path of the source folder, e.g. /Users/you/Documents',
  'vault 内目标文件夹（留空 = vault 根目录）': 'Target folder inside the vault (empty = vault root)',
  '定时监控该文件夹': 'Watch this folder on a schedule',
  '每 5 分钟': 'every 5 min',
  '每 15 分钟': 'every 15 min',
  '每 30 分钟': 'every 30 min',
  '每 1 小时': 'every hour',
  '递归扫描源文件夹的子文件夹，把支持的格式（doc/docx/wps/xls/xlsx/pptx/pdf/txt/csv/md）转换为 Markdown，按子目录结构保存到目标文件夹。开启监控后，新增或编辑的文件会按计划自动增量导入。可添加多个导入源。': 'Recursively scans the source folder (including subfolders), converts supported formats (doc/docx/wps/xls/xlsx/pptx/pdf/txt/csv/md) to Markdown, and saves them into the target folder keeping the subfolder structure. With watching on, new or edited files are imported incrementally on schedule. You can add multiple sources.',
  '添加导入源': 'Add import source',
  '导入源': 'Import sources',
  '请填写或选择源文件夹': 'Enter or pick a source folder first',
  '导入源已添加': 'Import source added',
  '导入任务已启动': 'Import job started',
  '更新失败': 'Update failed',
  '点击选择或输入名称过滤': 'Click to pick, or type to filter by name',
  '⚠️ 模型未返回有效回答（素材已检索到，见下方来源）。请检查所选模型服务是否正常，或换一个模型重试。': '⚠️ The model returned no answer (sources were retrieved and are listed below). Check that the selected model service is working, or try another model.'
};

let LANG = (() => {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'zh' || saved === 'en') return saved;
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
})();

function t(str, vars) {
  let out = (LANG === 'en' && Object.prototype.hasOwnProperty.call(I18N_EN, str)) ? I18N_EN[str] : str;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

// 应用静态 HTML 上的 data-i18n / data-i18n-ph / data-i18n-title
function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';
}

function setLang(lang) {
  if (lang !== 'zh' && lang !== 'en') return;
  LANG = lang;
  localStorage.setItem(LANG_KEY, lang);
  const sel = $('#langSelect');
  if (sel && sel.value !== lang) sel.value = lang;
  applyStaticI18n();
  updateVaultFootLabel();
  switchMainView(state.mainView);
  updateTaskBadges();
  updateFeedBadges();
}

// Markdown Renderer
function markdown(md) {
  if (!md) return '';
  let text = escapeHTML(md).replace(/^---[\s\S]*?---\s*/, '');
  const blocks = [];
  text = text.replace(/&lt;!--[\s\S]*?--&gt;/g, '');

  // Code & Dataview blocks
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    if (lang === 'dataview') {
      blocks.push(`<div class="dataview-block"><span>📊</span><div><strong style="color:var(--accent)">${t('Dataview 动态查询')}</strong><div style="font-size:11px;opacity:0.85;margin-top:2px;font-family:ui-monospace,monospace">${code.trim().replace(/\n/g, '<br>')}</div></div></div>`);
    } else {
      blocks.push(`<pre><code class="language-${lang}">${code.trim()}</code></pre>`);
    }
    return `@@BLOCK${blocks.length - 1}@@`;
  });

  // Headers
  text = text.replace(/^###### (.*)$/gm, '<h6>$1</h6>')
             .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
             .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
             .replace(/^### (.*)$/gm, '<h3>$1</h3>')
             .replace(/^## (.*)$/gm, '<h2>$1</h2>')
             .replace(/^# (.*)$/gm, '<h1>$1</h1>');

  // Blockquotes
  text = text.replace(/^> (.*)$/gm, '<blockquote>$1</blockquote>');

  // Images (before links)
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, `<span class="task-tag" style="background:#f0ece5">${t('🖼 图片：')}$1</span>`);

  // Standard Markdown links: [Text](URL)
  // 只允许 http(s)/mailto 协议——正文已整体 escapeHTML，这里防的是 javascript: 等危险链接
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|[^\s)]+)\)/g, (_, lbl, href) =>
    /^(https?:\/\/|mailto:)/i.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${lbl}</a>`
      : lbl);

  // Wikilinks（正文已转义过一次，捕获到的 link/label 直接使用，不可二次转义）
  text = text.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, link, alias) => {
    const label = alias || link;
    return `<a class="wikilink" href="javascript:void(0)" data-wiki="${link}">${label}</a>`;
  });

  // Task check items：支持 [ ] / [x] / [\] / [-]（以及旧的 [/]）
  let mdTaskIndex = 0;
  text = text.replace(/^[-*] \[([ xX\\\/\-])\] (.*)$/gm, (_, mark, body) => {
    const status = markToCandidateStatus(mark);
    const idx = mdTaskIndex++;
    return `<div class="task-card-row md-task-row md-task-${status}" data-md-task="${idx}" data-md-status="${status}" style="margin:4px 0;padding:6px 10px"><div class="task-checkbox-wrap"><span class="md-task-mark" aria-hidden="true">${candidateMarkGlyph(status)}</span></div><div class="task-content-wrap"><span class="task-title-text">${body}</span></div></div>`;
  });

  // Tables
  text = text.replace(/(?:^|\n)(\|[^\n]+\|\n\|[\s:|-]+\|\n(?:\|[^\n]+\|\n?)+)/g, (match) => {
    const lines = match.trim().split('\n').map((l) => l.trim());
    if (lines.length < 2) return match;
    const headerCells = lines[0].replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const rowLines = lines.slice(2);
    const thead = `<thead><tr>${headerCells.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
    const tbody = `<tbody>${rowLines.map((row) => {
      const cells = row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    }).join('')}</tbody>`;
    return `<table>${thead}${tbody}</table>`;
  });

  // Horizontal rules
  text = text.replace(/^---$/gm, '<hr style="border:0;border-top:1px solid var(--line);margin:1.6em 0">');

  // Formatting: bold, italic, del, code
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
             .replace(/\*(.*?)\*/g, '<em>$1</em>')
             .replace(/~~(.*?)~~/g, '<del>$1</del>')
             .replace(/`([^`]+)`/g, '<code>$1</code>');

  // Lists
  text = text.replace(/^[-*] (.*)$/gm, '<li>$1</li>')
             .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');

  // Paragraphs
  text = text.split(/\n{2,}/).map((p) => {
    const trimmed = p.trim();
    if (!trimmed) return '';
    if (/^<(h\d|ul|ol|blockquote|pre|li|div|table|hr)/.test(trimmed)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  // Restore blocks
  return text.replace(/@@BLOCK(\d+)@@/g, (_, i) => blocks[i]);
}

// API Helpers
async function api(url) {
  const r = await fetch(url);
  return r.json();
}

async function writeTask(payload) {
  const r = await fetch('/api/task', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || t('待办写回失败'));
  return data;
}

async function writeNote(payload) {
  const r = await fetch('/api/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || t('笔记写回失败'));
  return data;
}

async function saveSettings(values, dailyTemplate, rssFeeds) {
  const r = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values, dailyTemplate, rssFeeds })
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data.errors || [data.error || t('设置保存失败')]).join('\n'));
  return data;
}

async function refreshTasks() {
  const data = await api('/api/tasks');
  state.inboxTasks = data.tasks || [];
  state.taskSource = data.source || state.taskSource;
  updateTaskBadges();
}

function updateTaskBadges() {
  const openTasks = state.inboxTasks.filter((task) => !task.done);
  const count = openTasks.length;

  const sideBadge = $('#sidebarTaskBadge');
  if (sideBadge) {
    sideBadge.textContent = count;
    sideBadge.hidden = count === 0;
  }
  renderTaskModalTagChips();
}

// 从待办文本中统计标签频次，作为快捷标签与过滤器（自动适应用户自己的标签习惯）
function computeInboxTaskTags(limit = 5) {
  const counts = new Map();
  for (const task of state.inboxTasks) {
    for (const m of String(task.text || '').matchAll(/#([\w\u4e00-\u9fff/-]+)/g)) {
      counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([tag]) => tag);
}

function renderTaskModalTagChips() {
  const host = $('#taskModalTagChips');
  if (!host) return;
  const tags = computeInboxTaskTags(5);
  host.innerHTML = tags.map((tag) => `<span class="modal-tag" data-tag="#${escapeHTML(tag)}">+ #${escapeHTML(tag)}</span>`).join('')
    + `<span class="modal-tag" data-tag="🔼">+ 🔼 ${t('优先')}</span>`;
}

// 用 vault 实际目录填充「检索范围」与「新建笔记位置」下拉
function populateVaultFolderSelects() {
  const topLevel = (state.folderTree || []).map((n) => String(n.path || '')).filter(Boolean);
  const scopeSel = $('#chatScopeSelect');
  if (scopeSel) {
    const prev = state.selectedScope || '';
    scopeSel.innerHTML = `<option value="">${t('全知识库')}</option>`
      + topLevel.map((f) => `<option value="${escapeHTML(f)}">${escapeHTML(f)}</option>`).join('');
    if ([...scopeSel.options].some((o) => o.value === prev)) scopeSel.value = prev;
  }
  const folderSel = $('#noteFolderSelect');
  if (folderSel) {
    const options = topLevel.length ? topLevel : ['notes'];
    const prev = folderSel.value;
    folderSel.innerHTML = options.map((f) => `<option value="${escapeHTML(f)}">${escapeHTML(f)}</option>`).join('');
    if (options.includes(prev)) folderSel.value = prev;
  }
}

// Task Parsing & Formatting Helper
function formatTaskTitle(rawTitle) {
  if (!rawTitle) return '';
  let text = escapeHTML(rawTitle);

  // Standard Markdown Link: [Text](URL) —— 只允许 http(s)/mailto 协议
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|[^\s)]+)\)/g, (_, lbl, href) =>
    /^(https?:\/\/|mailto:)/i.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer" class="task-inline-link" onclick="event.stopPropagation()">${lbl} ↗</a>`
      : lbl);

  // Wikilinks: [[target|alias]] or [[target]]（已转义过一次，不可二次转义）
  text = text.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, link, alias) => {
    const label = alias || link;
    return `<a class="wikilink" href="javascript:void(0)" data-wiki="${link}" onclick="event.stopPropagation()">${label}</a>`;
  });

  // Inline code
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold / Italic
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
             .replace(/\*(.*?)\*/g, '<em>$1</em>');

  return text;
}

function taskParts(task) {
  const rawText = String(task.text || '');
  const tags = [...rawText.matchAll(/(?:^|\s)(#[\w\u4e00-\u9fff/-]+)/g)].map((m) => m[1]);
  const hasPriority = /🔼|⏫|🔽/.test(rawText);
  const priorityMatch = rawText.match(/(🔼|⏫|🔽)/)?.[1] || '';

  let title = rawText
    .replace(/(?:^|\s)#[\w\u4e00-\u9fff/-]+/g, '')
    .replace(/\s*📅\s*\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\s*📆\s*\d{4}-\d{2}-\d{2}(?:\s+[^\s]+)?/g, '')
    .replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\s*(🔼|⏫|🔽)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const due = task.due || rawText.match(/📅\s*(\d{4}-\d{2}-\d{2})/)?.[1] || '';
  const doneDate = rawText.match(/✅\s*(\d{4}-\d{2}-\d{2})/)?.[1] || '';

  return { title, tags, due, doneDate, priority: priorityMatch };
}

function getTagClass(tag) {
  const lower = tag.toLowerCase();
  if (lower.includes('work') || lower.includes('工作') || lower.includes('oa')) return 'tag-work';
  if (lower.includes('personal') || lower.includes('个人')) return 'tag-personal';
  if (lower.includes('study') || lower.includes('学习') || lower.includes('learning')) return 'tag-learning';
  if (lower.includes('reading') || lower.includes('books') || lower.includes('阅读')) return 'tag-reading';
  if (lower.includes('ai') || lower.includes('agent') || lower.includes('llm') || lower.includes('mcp')) return 'tag-ai';
  if (lower.includes('urgent') || lower.includes('紧急')) return 'tag-urgent';
  return '';
}

// Render individual task card row
function renderTaskCard(task) {
  const parts = taskParts(task);
  const todayStr = today();
  const isOverdue = !task.done && parts.due && parts.due < todayStr;
  const isTodayDue = parts.due === todayStr;

  let dueBadge = '';
  if (parts.due) {
    const label = parts.due === todayStr ? `${t('今日')} (${parts.due})` : parts.due;
    const cls = isOverdue ? 'is-overdue' : (isTodayDue ? 'is-today' : '');
    dueBadge = `<span class="task-due-badge ${cls}">📅 ${escapeHTML(label)}</span>`;
  }

  let doneBadge = '';
  if (task.done && parts.doneDate) {
    doneBadge = `<span class="task-done-badge">✅ ${escapeHTML(parts.doneDate)} ${t('完成')}</span>`;
  }

  const priorityPill = parts.priority ? `<span class="task-tag" style="background:#fee2e2;color:#b91c1c">${parts.priority} ${t('优先')}</span>` : '';

  return `
    <div class="task-card-row ${task.done ? 'is-done' : ''}" data-task-line="${task.line}">
      <div class="task-checkbox-wrap">
        <input type="checkbox" class="task-checkbox" data-task-line="${task.line}" ${task.done ? 'checked' : ''}>
      </div>
      <div class="task-content-wrap">
        <span class="task-title-text">${formatTaskTitle(parts.title)}</span>
        ${priorityPill}
        ${parts.tags.map((tag) => `<span class="task-tag ${getTagClass(tag)}">${escapeHTML(tag)}</span>`).join('')}
        ${dueBadge}
        ${doneBadge}
      </div>
      <div class="task-actions-wrap">
        <button class="task-row-btn btn-edit-task" data-task-line="${task.line}" title="${t('编辑')}">✎ ${t('编辑')}</button>
        <button class="task-row-btn btn-delete-task" data-task-line="${task.line}" title="${t('删除')}">🗑 ${t('删除')}</button>
      </div>
    </div>
  `;
}

// Bind events for task rows
function bindTaskEvents(container) {
  container.querySelectorAll('.task-checkbox').forEach((el) => {
    el.onchange = async () => {
      const line = Number(el.dataset.taskLine);
      const isDone = el.checked;
      try {
        await writeTask({ action: 'toggle', line, done: isDone, completedAt: today() });
        await refreshTasks();
        showToast(isDone ? t('待办已标记完成') : t('已恢复为未完成'));
        if (state.mainView === 'tasks') renderTasksView();
        if (state.mainView === 'daily') renderDaily(state.dailyNote);
      } catch (e) {
        showToast(e.message);
        el.checked = !isDone;
      }
    };
  });

  container.querySelectorAll('.btn-edit-task').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const line = Number(el.dataset.taskLine);
      const item = state.inboxTasks.find((t) => t.line === line);
      if (!item) return;
      openTaskModal(item);
    };
  });

  container.querySelectorAll('.btn-delete-task').forEach((el) => {
    el.onclick = async (e) => {
      e.stopPropagation();
      const line = Number(el.dataset.taskLine);
      const item = state.inboxTasks.find((t) => t.line === line);
      if (!item) return;
      const parts = taskParts(item);
      const previewText = parts.title || item.text || t('此事项');
      if (!confirm(t('确定要从待办文件中删除此事项吗？\n\n"{s}"', { s: previewText }))) return;
      try {
        await writeTask({ action: 'delete', line });
        await refreshTasks();
        showToast(t('待办事项已删除'));
        if (state.mainView === 'tasks') renderTasksView();
        if (state.mainView === 'daily') renderDaily(state.dailyNote);
      } catch (err) {
        showToast(err.message);
      }
    };
  });

  bindWikilinks(container);
}

// Task Edit Modal
function openTaskModal(task) {
  state.editingTaskLine = task.line;
  const modal = $('#taskModal');
  const input = $('#taskModalInput');
  input.value = task.text || '';
  if (typeof modal.showModal === 'function') {
    modal.showModal();
  } else {
    modal.setAttribute('open', '');
  }
}

function initTaskModal() {
  const modal = $('#taskModal');
  const form = $('#taskModalForm');
  const input = $('#taskModalInput');
  const closeBtn = $('#closeTaskModal');
  const cancelBtn = $('#cancelTaskModal');
  const deleteBtn = $('#deleteTaskFromModal');

  const closeModal = () => {
    if (typeof modal.close === 'function') modal.close();
    else modal.removeAttribute('open');
    state.editingTaskLine = null;
  };

  closeBtn.onclick = closeModal;
  cancelBtn.onclick = closeModal;

  if (deleteBtn) {
    deleteBtn.onclick = async () => {
      if (state.editingTaskLine === null) return;
      const line = state.editingTaskLine;
      const item = state.inboxTasks.find((t) => t.line === line);
      const parts = item ? taskParts(item) : { title: '' };
      const previewText = parts.title || item?.text || t('此事项');
      if (!confirm(t('确定要从待办文件中删除此事项吗？\n\n"{s}"', { s: previewText }))) return;
      try {
        await writeTask({ action: 'delete', line });
        await refreshTasks();
        closeModal();
        showToast(t('待办事项已删除'));
        if (state.mainView === 'tasks') renderTasksView();
        if (state.mainView === 'daily') renderDaily(state.dailyNote);
      } catch (err) {
        showToast(err.message);
      }
    };
  }

  // Tag chip click to append（chips 由 renderTaskModalTagChips 按实际标签动态渲染）
  const chipHost = $('#taskModalTagChips');
  if (chipHost) {
    chipHost.onclick = (e) => {
      const el = e.target.closest('.modal-tag');
      if (!el) return;
      const tag = el.dataset.tag;
      if (tag && !input.value.includes(tag)) {
        input.value = `${input.value.trim()} ${tag} `.trimStart();
        input.focus();
      }
    };
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (state.editingTaskLine === null) return;
    const text = input.value.trim();
    if (!text) return;
    try {
      const result = await writeTask({ action: 'edit', line: state.editingTaskLine, text });
      await refreshTasks();
      closeModal();
      showToast(t('待办已更新'));
      if (state.mainView === 'tasks') renderTasksView();
      if (state.mainView === 'daily') renderDaily(state.dailyNote);
    } catch (err) {
      showToast(err.message);
    }
  };
}

// ==========================================================================
// VIEW 1: 📅 DAILY NOTE (每日日记)
// ==========================================================================
let dailyLoadSeq = 0; // 快速翻页时丢弃过期的日记加载响应，避免视图与日期不一致
async function openDaily(date) {
  const seq = ++dailyLoadSeq;
  state.dailyDate = date;
  $('#sideDailyDate').value = date;
  $('#crumbSection').textContent = t('每日日记');
  $('#crumbTarget').textContent = date === today() ? `${t('今日')} (${date})` : date;

  const data = await api(`/api/daily?date=${encodeURIComponent(date)}`);
  if (seq !== dailyLoadSeq) return; // 期间又翻了别的日期，丢弃这份结果
  if (data.error) {
    showToast(t('日记加载失败'));
    return;
  }
  const local = draftFor(data.path);
  const shown = local ? { ...data, ...local, draft: true, generated: false, exists: true } : data;
  state.dailyNote = shown;
  renderDaily(shown);
}

// 日记页底部「今日笔记」：复刻 Dataview 查询（当天新建/日期前缀命名的笔记列表），异步填充
async function loadDailyInsights(date) {
  const box = $('#dailyInsightsBox');
  if (!box || box.dataset.date !== date) return;
  box.innerHTML = `<div class="daily-insights-head"><h2>${t('今日笔记')}</h2></div><div class="daily-insights-loading">${t('正在读取…')}</div>`;
  let data;
  try {
    data = await api(`/api/daily/insights?date=${encodeURIComponent(date)}`);
  } catch { box.innerHTML = ''; return; }
  // 等待期间切换了日期/视图导致 DOM 被重渲染——丢弃过期结果
  if (!box.isConnected || box.dataset.date !== date) return;
  if (data.error || !data.notes) { box.innerHTML = ''; return; }
  const fmt = (ms) => {
    const d = new Date(ms);
    return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const items = data.notes.map((n) => `
    <div class="daily-insight-item">
      <span class="daily-insight-time">${fmt(n.ctime)}</span>
      <a href="javascript:void(0)" class="daily-insight-link" data-path="${escapeHTML(n.rel)}">${escapeHTML(n.name)}</a>
    </div>`).join('');
  const countLabel = data.total > data.notes.length
    ? t('共 {n} 篇 · 仅显示最近 50 篇', { n: data.total })
    : t('共 {n} 篇', { n: data.total });
  box.innerHTML = `
    <div class="daily-insights-head">
      <h2>${t('今日笔记')}</h2>
      <span class="daily-insights-count">${countLabel}</span>
    </div>
    ${data.notes.length ? `<div class="daily-insights-list">${items}</div>` : `<div class="daily-insights-empty">${t('当天没有新建或以日期命名的笔记')}</div>`}
  `;
  box.querySelectorAll('.daily-insight-link').forEach((link) => {
    link.onclick = (e) => {
      e.preventDefault();
      const from = currentLoc();
      switchMainView('notes');
      openNote({ path: link.dataset.path, title: link.dataset.path.split('/').pop().replace(/\.md$/i, '') });
      recordNav(from);
    };
  });
}

function renderDaily(note) {
  const container = $('#dailyContainer');
  if (!container) return;
  const isTodayDate = note.date === today();
  const prev = shiftDate(note.date, -1);
  const next = shiftDate(note.date, 1);

  // Status Badge
  let statusBadge = '';
  if (note.draft) {
    statusBadge = `<span class="badge badge-draft">✎ ${t('临时草稿')}</span>`;
  } else if (note.exists) {
    statusBadge = `<span class="badge badge-success">✓ ${t('知识库已归档')}</span>`;
  } else {
    statusBadge = `<span class="badge badge-warning">◌ ${t('当日未建档')}</span>`;
  }

  // Linked Today Tasks：当日到期未办的 + 当日完成（✅ 日期，无完成日则回退到期日）的
  const dayPending = state.inboxTasks.filter((t) => !t.done && t.due === note.date);
  const dayDone = state.inboxTasks.filter((t) => t.done && (t.doneDate === note.date || (!t.doneDate && t.due === note.date)));
  const linkedTasks = [...dayPending, ...dayDone];
  const openTasks = dayPending;
  const doneTasks = dayDone;

  const taskGroupHtml = (label, tasks, emptyText) => `
    <div class="daily-tasks-group">
      <div class="daily-tasks-group-label">${label}<span class="badge" style="font-size:10px;margin-left:6px">${tasks.length}</span></div>
      ${tasks.length ? tasks.map(renderTaskCard).join('') : `<div style="color:var(--muted);font-size:12px;padding:4px 0 8px">${emptyText}</div>`}
    </div>
  `;

  const taskWidgetHtml = `
    <details class="daily-tasks-widget" ${linkedTasks.length ? 'open' : ''}>
      <summary class="daily-tasks-summary">
        <div class="summary-left">
          <span>📅</span>
          <span>${t('当日待办与已办事项')}</span>
          <span class="badge badge-draft" style="font-size:10px">${t('待办 {n} 项', { n: openTasks.length })}</span>
          <span class="badge badge-success" style="font-size:10px">${t('已办 {n} 项', { n: doneTasks.length })}</span>
        </div>
        <div class="summary-right">
          <a href="javascript:void(0)" class="goto-tasks-link" id="gotoTasksFromDaily">${t('打开待办中心 ➔')}</a>
          <span>▾</span>
        </div>
      </summary>
      <div class="daily-tasks-body" id="dailyTasksList">
        ${linkedTasks.length ? `
          ${taskGroupHtml(t('待办事项'), openTasks, t('当天没有待办事项'))}
          ${taskGroupHtml(t('已办事项'), doneTasks, t('当天还没有完成的事项'))}
        ` : `<div style="color:var(--muted);font-size:12px;padding:8px 0">${t('当天没有排期的待办事项')}</div>`}
      </div>
    </details>
  `;

  // Note Body —— 未建档时也用 vault 日记模板预览（含「相关页面」wikilink），避免只剩空态点不到选题池
  const cleanContent = String(note.content || '')
    .replace(/^## 今日待办[\s\S]*?(?=^## 健康)/m, '')
    .replace(/^## 今日完成\s*\n```dataview[\s\S]*?```\s*/m, '')
    // 「今日笔记」的 Dataview 块网页无法执行，由下方 dailyInsights 区块用服务端计算结果代替
    .replace(/^## 今日笔记\s*\n```dataview[\s\S]*?```\s*/m, '')
    .replace(/```dataview[\s\S]*?```/g, '\n')
    .replace(/^#\s+\d{4}-\d{2}-\d{2}[^\n]*\n?/, '')
    .replace(/\n---\s*\n\*模板版本:[\s\S]*$/, '');

  const createBanner = note.generated ? `
    <div class="daily-empty-state" style="margin-bottom:18px">
      <div class="daily-empty-icon">◌</div>
      <h3>${escapeHTML(note.date)} ${t('暂无日记记录')}</h3>
      <p>${t('当前 Vault 中尚未创建这一天的日记文件，你可以基于 vault 日记模板快速生成。')}</p>
      <button class="btn btn-primary" id="btnCreateDailyFromTpl" style="padding:9px 18px">${t('＋ 基于模板一键创建')}</button>
    </div>
  ` : '';

  const paperBody = `
    <div class="daily-paper">
      ${createBanner}
      <div class="daily-paper-head">
        <div class="eyebrow" style="margin-bottom:4px">${note.generated ? 'TEMPLATE PREVIEW' : 'DAILY JOURNAL'}</div>
        <h1 class="daily-paper-title">${note.generated ? t('模板预览') : t('每日手记')}</h1>
        <div class="daily-meta-info">
          <span>${t('文件路径: {p}', { p: escapeHTML(note.path) })}</span>
          <span>${t('字数: {n} 字', { n: note.content ? note.content.length : 0 })}</span>
        </div>
      </div>
      <div class="markdown" id="dailyMarkdownBody">${markdown(cleanContent)}</div>
      <div class="daily-insights-box" id="dailyInsightsBox" data-date="${escapeHTML(note.date)}"></div>
    </div>
  `;

  container.innerHTML = `
    <div class="daily-header-card">
      <div class="daily-nav-row">
        <div class="daily-date-controls">
          <button class="date-nav-btn" id="btnPrevDay" title="${t('前一天 (快捷键: ←)')}">◀ ${t('前一天')}</button>
          <input type="date" class="daily-input-date" id="dailyMainDateInput" value="${note.date}">
          <button class="date-nav-btn" id="btnToday" ${isTodayDate ? 'style="font-weight:600;border-color:var(--accent);color:var(--accent)"' : ''}>${t('回到今天')}</button>
          <button class="date-nav-btn" id="btnNextDay" title="${t('后一天 (快捷键: →)')}">${t('后一天')} ▶</button>
          ${statusBadge}
        </div>
        <div class="daily-actions">
          ${note.exists || note.draft ? `
            <button class="btn btn-secondary" id="btnEditDaily">${t('✏️ 编辑')}</button>
            <button class="btn btn-secondary" id="btnDownloadDaily">${t('↓ 下载 .md')}</button>
          ` : ''}
        </div>
      </div>
    </div>
    ${taskWidgetHtml}
    ${paperBody}
  `;

  loadDailyInsights(note.date);

  // Bind Events for Daily
  $('#btnPrevDay').onclick = () => { const from = currentLoc(); openDaily(prev); recordNav(from); };
  $('#btnNextDay').onclick = () => { const from = currentLoc(); openDaily(next); recordNav(from); };
  $('#btnToday').onclick = () => { const from = currentLoc(); openDaily(today()); recordNav(from); };
  $('#dailyMainDateInput').onchange = (e) => { const from = currentLoc(); openDaily(e.target.value); recordNav(from); };

  const gotoTasks = $('#gotoTasksFromDaily');
  if (gotoTasks) {
    gotoTasks.onclick = (e) => {
      e.preventDefault();
      const from = currentLoc();
      switchMainView('tasks');
      recordNav(from);
    };
  }

  const createBtn = $('#btnCreateDailyFromTpl');
  if (createBtn) {
    createBtn.onclick = () => {
      writeNote({ path: note.path, content: note.content }).then(() => {
        const created = { ...note, generated: false, exists: true, draft: false, title: note.date };
        showToast(t('已成功基于模板创建日记'));
        state.dailyNote = created;
        renderDaily(created);
      }).catch((e) => showToast(e.message));
    };
  }

  const editBtn = $('#btnEditDaily');
  if (editBtn) {
    editBtn.onclick = () => editDailyNote(note);
  }

  const downloadBtn = $('#btnDownloadDaily');
  if (downloadBtn) {
    downloadBtn.onclick = () => download(note.date, note.content);
  }

  const taskWidget = $('#dailyTasksList');
  if (taskWidget) bindTaskEvents(taskWidget);
  bindWikilinks($('#dailyMarkdownBody'));
}

function editDailyNote(note) {
  const container = $('#dailyMarkdownBody');
  if (!container) return;
  container.outerHTML = `
    <div id="dailyEditorWrap" style="margin-top:14px">
      <textarea class="draft-editor" id="dailyDraftEditor">${escapeHTML(note.content)}</textarea>
      <div class="autosave-status" id="dailyAutosaveStatus">${t('输入后会自动保存到临时草稿')}</div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
        <button class="btn btn-secondary" id="btnCancelEditDaily">${t('取消')}</button>
        <button class="btn btn-primary" id="btnSaveEditDaily">${t('💾 保存到知识库')}</button>
      </div>
    </div>
  `;

  const btnEdit = $('#btnEditDaily');
  if (btnEdit) btnEdit.style.display = 'none';

  bindDraftAutosave({
    editor: $('#dailyDraftEditor'),
    note,
    statusEl: $('#dailyAutosaveStatus'),
    onSaved: (saved) => { state.dailyNote = saved; }
  });

  $('#btnCancelEditDaily').onclick = () => renderDaily(note);
  $('#btnSaveEditDaily').onclick = async () => {
    const val = $('#dailyDraftEditor').value;
    cancelPendingDraftAutosave(); // 先取消挂起的自动保存，防止它把刚删除的草稿复活
    try {
      await writeNote({ path: note.path, content: val });
      saveDrafts(drafts().filter((d) => d.path !== note.path));
      showToast(t('日记已成功写回知识库'));
      await openDaily(note.date);
    } catch (e) {
      showToast(e.message);
    }
  };
}

// ==========================================================================
// VIEW 2: ✅ TASKS MANAGEMENT CENTER (待办事项中心)
// ==========================================================================
function renderTasksView() {
  const container = $('#tasksContainer');
  if (!container) return;
  const todayStr = today();

  const allTasks = state.inboxTasks;
  const openTasks = allTasks.filter((task) => !task.done);
  const doneTasks = allTasks.filter((task) => task.done);
  const todayOpen = openTasks.filter((item) => item.due === todayStr);
  const overdueTasks = openTasks.filter((item) => item.due && item.due < todayStr);

  // Update Topbar Crumb
  $('#crumbSection').textContent = t('待办事项');
  $('#crumbTarget').textContent = t('Inbox ({n} 项未完成)', { n: openTasks.length });

  // Quick Stats
  const statsHtml = `
    <div class="task-stats-grid">
      <div class="stat-card stat-today" data-filter="today" style="cursor:pointer">
        <span class="stat-label">${t('今日待办')}</span>
        <div class="stat-val">${todayOpen.length} <small style="font-size:12px;font-weight:normal;color:var(--muted)">${t('项')}</small></div>
      </div>
      <div class="stat-card stat-overdue" data-filter="overdue" style="cursor:pointer">
        <span class="stat-label">${t('已逾期待办')}</span>
        <div class="stat-val">${overdueTasks.length} <small style="font-size:12px;font-weight:normal;color:var(--muted)">${t('项')}</small></div>
      </div>
      <div class="stat-card" data-filter="all" style="cursor:pointer">
        <span class="stat-label">${t('收件箱全部未完')}</span>
        <div class="stat-val">${openTasks.length} <small style="font-size:12px;font-weight:normal;color:var(--muted)">${t('项')}</small></div>
      </div>
      <div class="stat-card stat-completed" data-filter="done" style="cursor:pointer">
        <span class="stat-label">${t('历史已完成')}</span>
        <div class="stat-val">${doneTasks.length} <small style="font-size:12px;font-weight:normal;color:var(--muted)">${t('项')}</small></div>
      </div>
    </div>
  `;

  // Quick Add Card
  const quickTags = computeInboxTaskTags(5);
  const addCardHtml = `
    <div class="task-add-card">
      <div class="task-add-main-row">
        <input type="text" id="taskMainInput" class="task-add-input" placeholder="${t('＋ 添加新待办事项... (输入 #标签 或点击下方快捷插入)')}">
        <input type="date" id="taskMainDueDate" class="task-add-date" value="${todayStr}">
        <button class="btn btn-primary task-add-submit" id="btnSubmitTask">${t('＋ 写回待办文件')}</button>
      </div>
      <div class="task-add-sub-row">
        <div class="quick-tag-pills">
          <span class="tag-label-hint">${t('快捷标签:')}</span>
          ${quickTags.map((tag) => `<button class="quick-tag-btn" data-insert="#${escapeHTML(tag)}">+ #${escapeHTML(tag)}</button>`).join('')}
          <button class="quick-tag-btn" data-insert="🔼">+ 🔼 ${t('优先级')}</button>
        </div>
      </div>
    </div>
  `;

  // Filter Toolbar（前几个高频标签自动成为过滤器）
  const filterTags = computeInboxTaskTags(4);
  const filterTabs = [
    { id: 'today', label: t('🌟 今日待办'), count: todayOpen.length },
    { id: 'overdue', label: t('⚠️ 逾期待办'), count: overdueTasks.length },
    { id: 'all', label: t('📋 全部未完成'), count: openTasks.length },
    ...filterTags.map((tag) => ({
      id: `tag:${tag}`,
      label: `#${tag}`,
      count: openTasks.filter((x) => x.text.toLowerCase().includes(`#${tag.toLowerCase()}`)).length
    })),
    { id: 'done', label: t('✅ 已完成'), count: doneTasks.length }
  ];
  if (state.taskFilter.startsWith('tag:') && !filterTabs.some((tab) => tab.id === state.taskFilter)) {
    state.taskFilter = 'all';
  }

  const toolbarHtml = `
    <div class="task-toolbar">
      <div class="task-filter-tabs">
        ${filterTabs.map((tab) => `
          <button class="task-tab-btn ${state.taskFilter === tab.id ? 'active' : ''}" data-task-tab="${tab.id}">
            ${tab.label} (${tab.count})
          </button>
        `).join('')}
      </div>
      <input type="text" id="taskSearchInput" class="task-search-input" placeholder="${t('搜索待办...')}" value="${escapeHTML(state.taskQuery)}">
    </div>
  `;

  // Filter Tasks by tab & query
  let filtered = [];
  if (state.taskFilter === 'today') {
    filtered = openTasks.filter((x) => x.due === todayStr);
  } else if (state.taskFilter === 'overdue') {
    filtered = overdueTasks;
  } else if (state.taskFilter === 'all') {
    filtered = openTasks;
  } else if (state.taskFilter.startsWith('tag:')) {
    const tagLower = state.taskFilter.slice(4).toLowerCase();
    filtered = openTasks.filter((x) => x.text.toLowerCase().includes(`#${tagLower}`));
  } else if (state.taskFilter === 'done') {
    filtered = doneTasks;
  }

  if (state.taskQuery) {
    const q = state.taskQuery.toLowerCase();
    filtered = filtered.filter((x) => x.text.toLowerCase().includes(q));
  }

  // Structured Task List Display
  let taskListHtml = '';
  if (state.taskFilter === 'all' && !state.taskQuery) {
    // Show Grouped
    const overdueList = openTasks.filter((x) => x.due && x.due < todayStr);
    const todayList = openTasks.filter((x) => x.due === todayStr);
    const futureList = openTasks.filter((x) => x.due && x.due > todayStr);
    const nodueList = openTasks.filter((x) => !x.due);

    taskListHtml = `
      ${overdueList.length ? `
        <div class="task-group-section">
          <div class="task-group-head">
            <span class="task-group-title" style="color:var(--danger)">⚠️ ${t('逾期未完成事项')}</span>
            <span class="task-group-count">${t('{n} 项', { n: overdueList.length })}</span>
          </div>
          <div class="task-card-list">${overdueList.map(renderTaskCard).join('')}</div>
        </div>
      ` : ''}

      ${todayList.length ? `
        <div class="task-group-section">
          <div class="task-group-head">
            <span class="task-group-title" style="color:var(--accent)">📅 ${t('今日到期事项')}</span>
            <span class="task-group-count">${t('{n} 项', { n: todayList.length })}</span>
          </div>
          <div class="task-card-list">${todayList.map(renderTaskCard).join('')}</div>
        </div>
      ` : ''}

      ${futureList.length ? `
        <div class="task-group-section">
          <div class="task-group-head">
            <span class="task-group-title">🗓 ${t('未来排期事项')}</span>
            <span class="task-group-count">${t('{n} 项', { n: futureList.length })}</span>
          </div>
          <div class="task-card-list">${futureList.map(renderTaskCard).join('')}</div>
        </div>
      ` : ''}

      ${nodueList.length ? `
        <div class="task-group-section">
          <div class="task-group-head">
            <span class="task-group-title">📥 ${t('收件箱待办池 (未设定日期)')}</span>
            <span class="task-group-count">${t('{n} 项', { n: nodueList.length })}</span>
          </div>
          <div class="task-card-list">${nodueList.map(renderTaskCard).join('')}</div>
        </div>
      ` : ''}
    `;
  } else {
    // Normal List Display
    taskListHtml = `
      <div class="task-card-list" style="margin-top:12px">
        ${filtered.length ? filtered.map(renderTaskCard).join('') : `<div class="task-empty-card">${t('当前分类下没有匹配的事项')}</div>`}
      </div>
    `;
  }

  container.innerHTML = `
    <div class="tasks-header">
      <div class="tasks-header-top">
        <div class="tasks-title-wrap">
          <div class="eyebrow">TASK & INBOX MANAGER</div>
          <h1>${t('待办事项与任务流')}</h1>
        </div>
        <div class="tasks-source-tag">${t('数据源: {s}', { s: escapeHTML(state.taskSource) })}</div>
      </div>
    </div>
    ${statsHtml}
    ${addCardHtml}
    ${toolbarHtml}
    <div id="tasksListContainer">${taskListHtml}</div>
  `;

  // Bind Events in Tasks View
  const mainInput = $('#taskMainInput');
  const mainDueDate = $('#taskMainDueDate');
  const submitBtn = $('#btnSubmitTask');

  const handleAddTask = async () => {
    // 防止双击/连按 Enter 在写回完成前重复提交，向 Inbox.md 追加重复任务
    if (taskAddInFlight) return;
    const text = mainInput.value.trim();
    if (!text) return;
    const due = mainDueDate.value || '';
    taskAddInFlight = true;
    submitBtn.disabled = true;
    try {
      const result = await writeTask({ action: 'add', text, due });
      mainInput.value = '';
      await refreshTasks();
      showToast(t('待办已写回'));
      renderTasksView();
    } catch (e) {
      showToast(e.message);
    } finally {
      taskAddInFlight = false;
      const freshBtn = $('#btnSubmitTask');
      if (freshBtn) freshBtn.disabled = false;
    }
  };

  submitBtn.onclick = handleAddTask;
  mainInput.onkeydown = (e) => {
    if (e.key === 'Enter') handleAddTask();
  };

  // Quick tag insertion
  $$('.quick-tag-btn').forEach((btn) => {
    btn.onclick = () => {
      const tag = btn.dataset.insert;
      if (tag && !mainInput.value.includes(tag)) {
        mainInput.value = `${mainInput.value.trim()} ${tag} `.trimStart();
        mainInput.focus();
      }
    };
  });

  // Stat Card click to filter
  $$('.stat-card').forEach((card) => {
    card.onclick = () => {
      const f = card.dataset.filter;
      if (f) {
        state.taskFilter = f;
        renderTasksView();
      }
    };
  });

  // Filter Tabs click
  $$('.task-tab-btn').forEach((btn) => {
    btn.onclick = () => {
      state.taskFilter = btn.dataset.taskTab;
      renderTasksView();
    };
  });

  // Task Search filter
  const searchInp = $('#taskSearchInput');
  if (searchInp) {
    searchInp.oninput = (e) => {
      state.taskQuery = e.target.value;
      const caret = e.target.selectionStart;
      renderTasksView(); // 整体重渲染会销毁输入框——渲染后恢复焦点与光标，否则每敲一个字符就失焦
      const fresh = $('#taskSearchInput');
      if (fresh) {
        fresh.focus();
        try { fresh.setSelectionRange(caret, caret); } catch { /* 部分类型输入不支持 */ }
      }
    };
  }

  // Bind task row checkboxes & edit buttons
  bindTaskEvents($('#tasksListContainer'));
}

// ==========================================================================
// VIEW 3: 📚 NOTES & EXPLORER (知识库笔记双栏)
// ==========================================================================
async function renderNotesView() {
  $('#crumbSection').textContent = t('知识库笔记');
  const title = state.view === 'recent' ? t('最近更新') : (state.view === 'drafts' ? t('临时草稿') : (state.folder || t('全部笔记')));
  $('#crumbTarget').textContent = state.current ? state.current.title : title;

  await renderNoteList();
  if (state.current) {
    renderNoteReader(state.current, state.current.content);
  }
}

async function renderNoteList() {
  const data = await api(`/api/notes?limit=180&q=${encodeURIComponent(state.query)}&folder=${encodeURIComponent(state.folder)}`);
  state.notes = data.notes || [];

  if (state.view === 'recent') {
    state.notes = [...state.notes].sort((a, b) => b.mtime - a.mtime).slice(0, 40);
  }
  if (state.view === 'drafts') {
    state.notes = drafts().map((d) => ({ ...d, draft: true, mtime: d.mtime || Date.now() }));
  }

  const title = state.view === 'recent' ? t('最近更新') : (state.view === 'drafts' ? t('临时草稿') : (state.folder || t('全部笔记')));
  $('#listTitle').textContent = title;
  $('#resultCount').textContent = state.notes.length + (data.total > 180 ? '+' : '');
  $('#listSub').textContent = state.view === 'drafts' ? t('临时草稿只保存在当前浏览器，不会自动写回 vault') : t('从原始 vault 直接读取，保持文件不变');

  const filterInp = $('#listFilterInput');
  const filterVal = (filterInp ? filterInp.value : '').toLowerCase().trim();

  let listToDisplay = state.notes;
  if (filterVal) {
    listToDisplay = listToDisplay.filter((n) => `${n.title} ${n.path}`.toLowerCase().includes(filterVal));
  }

  const listEl = $('#noteList');
  if (!listEl) return;

  listEl.innerHTML = listToDisplay.length ? listToDisplay.map((n, i) => `
    <article class="note-card ${state.current?.path === n.path ? 'selected' : ''}" data-path="${escapeHTML(n.path)}">
      <div class="note-card-title">${escapeHTML(n.title)}</div>
      <div class="note-card-path">${escapeHTML(n.path)}</div>
      <div class="note-card-meta">
        <span>${n.draft ? t('临时草稿') : time(n.mtime)}</span>
        ${n.tags?.slice(0, 2).map((tag) => `<span class="task-tag">${escapeHTML(tag)}</span>`).join('')}
      </div>
    </article>
  `).join('') : `<div class="empty-reader" style="margin:40px 0"><div class="empty-icon">⌁</div><p>${t('没有找到匹配笔记')}</p></div>`;

  listEl.onclick = (e) => {
    const card = e.target.closest('.note-card');
    if (!card) return;
    const path = card.dataset.path;
    const item = state.notes.find((n) => n.path === path);
    if (item) openNote(item);
  };

  if (filterInp) {
    filterInp.oninput = () => renderNoteList();
  }

  const draftBadge = $('#draftCount');
  if (draftBadge) {
    draftBadge.textContent = drafts().length;
    draftBadge.hidden = drafts().length === 0;
  }
}

async function openWikilink(wikiTarget) {
  const name = String(wikiTarget || '').trim();
  if (!name) return;
  const from = currentLoc();
  const data = await api(`/api/note?wiki=${encodeURIComponent(name)}`);
  if (data.error || !data.path) {
    showToast(t('没有找到对应的笔记「{s}」', { s: name }));
    return;
  }
  if (state.mainView !== 'notes') {
    state.view = 'all';
    state.folder = '';
    switchMainView('notes');
  }
  await openNote({ path: data.path, title: data.title || name });
  recordNav(from);
}

function bindWikilinks(container) {
  if (!container) return;
  container.querySelectorAll('.wikilink').forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openWikilink(a.dataset.wiki);
    };
  });
}

async function openNote(item) {
  if (item.draft) {
    state.current = item;
    renderNoteReader(item, item.content);
    renderNoteList();
    return;
  }
  const data = await api(`/api/note?path=${encodeURIComponent(item.path)}`);
  if (data.error) {
    showToast(t('这篇笔记暂时无法读取'));
    return;
  }
  const local = draftFor(item.path);
  const shown = local ? { ...data, ...local, draft: true } : data;
  state.current = shown;
  $('#crumbTarget').textContent = shown.title;
  renderNoteReader(shown, shown.content);
  renderNoteList();
}

const CANDIDATE_STATUSES = [
  { id: 'pending', label: '待处理', mark: ' ' },
  { id: 'done', label: '完成', mark: 'x' },
  { id: 'cancelled', label: '取消', mark: '\\' },
  { id: 'waiting', label: '等待', mark: '-' }
];
const CANDIDATE_LEGACY_TAG_RE = /\s*【(?:选中|稍后处理|忽略)】\s*/g;

function markToCandidateStatus(mark) {
  const m = String(mark || ' ');
  if (m === 'x' || m === 'X') return 'done';
  if (m === '\\' || m === '/') return 'cancelled'; // [/] 旧写法也当取消
  if (m === '-') return 'waiting';
  return 'pending';
}

function candidateMarkGlyph(status) {
  if (status === 'done') return '☑';
  if (status === 'cancelled') return '☒';
  if (status === 'waiting') return '⊟';
  return '☐';
}

function isTopicCandidateNote(note) {
  const path = String(note?.path || '');
  const title = String(note?.title || '');
  return /gzh-topic-candidates/i.test(path) || /公众号选题候选/.test(title);
}

function mapMdTaskLines(content) {
  const lines = String(content || '').split('\n');
  const hits = [];
  let i = 0;
  if (lines[0] === '---') {
    i = 1;
    while (i < lines.length && lines[i] !== '---') i++;
    if (i < lines.length) i++;
  }
  let inCode = false;
  let inComment = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!inComment && /^```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    if (!inComment && /<!--/.test(line)) {
      if (!/-->/.test(line.slice(line.indexOf('<!--') + 4))) inComment = true;
      continue;
    }
    if (inComment) {
      if (/-->/.test(line)) inComment = false;
      continue;
    }
    if (/^[-*] \[[ xX\\\/\-]\] /.test(line)) hits.push(i);
  }
  return { lines, hits };
}

function applyCandidateStatus(content, index, status) {
  const { lines, hits } = mapMdTaskLines(content);
  const lineNo = hits[index];
  if (lineNo == null) return content;
  const m = lines[lineNo].match(/^([-*]) \[[ xX\\\/\-]\] (.*)$/);
  if (!m) return content;
  const spec = CANDIDATE_STATUSES.find((s) => s.id === status) || CANDIDATE_STATUSES[0];
  const clean = m[2].replace(CANDIDATE_LEGACY_TAG_RE, '').trimEnd();
  lines[lineNo] = `${m[1]} [${spec.mark}] ${clean}`;
  return lines.join('\n');
}

let candidateWriteLock = false;
async function persistCandidateStatus(note, content, index, status) {
  const nextContent = applyCandidateStatus(content, index, status);
  if (nextContent === content) return;
  if (candidateWriteLock) return;
  candidateWriteLock = true;
  const reader = $('#noteReader');
  const scrollTop = reader ? reader.scrollTop : 0;
  try {
    await writeNote({ path: note.path, content: nextContent });
    saveDrafts(drafts().filter((d) => d.path !== note.path));
    const next = { ...note, content: nextContent, draft: false };
    state.current = next;
    renderNoteReader(next, nextContent);
    renderNoteList();
    if (reader) reader.scrollTop = scrollTop;
    const spec = CANDIDATE_STATUSES.find((s) => s.id === status);
    showToast(t('已标记为{s}', { s: t(spec ? spec.label : '待处理') }));
  } finally {
    candidateWriteLock = false;
  }
}

function bindCandidateTasks(container, note, content) {
  if (!container || !note?.path || note.wiki || !isTopicCandidateNote(note)) return;
  const { lines, hits } = mapMdTaskLines(content);
  container.querySelectorAll('.md-task-row').forEach((row) => {
    const idx = Number(row.dataset.mdTask);
    const raw = hits[idx] != null ? lines[hits[idx]] : '';
    const markMatch = raw.match(/^[-*] \[([ xX\\\/\-])\] /);
    const status = markToCandidateStatus(markMatch ? markMatch[1] : ' ');
    row.classList.remove('is-done', 'md-task-pending', 'md-task-done', 'md-task-cancelled', 'md-task-waiting', 'md-task-selected', 'md-task-later', 'md-task-ignored');
    row.classList.add(`md-task-${status}`);

    const titleEl = row.querySelector('.task-title-text');
    if (titleEl) titleEl.textContent = titleEl.textContent.replace(CANDIDATE_LEGACY_TAG_RE, '').trim();

    const markEl = row.querySelector('.md-task-mark');
    if (markEl) markEl.textContent = candidateMarkGlyph(status);

    const wrap = row.querySelector('.task-content-wrap');
    if (wrap && !row.querySelector('.md-task-chips')) {
      const chips = document.createElement('span');
      chips.className = 'md-task-chips';
      chips.innerHTML = CANDIDATE_STATUSES.map((s) =>
        `<button type="button" class="md-task-chip ${s.id === status ? 'active' : ''}" data-status="${s.id}" title="${escapeHTML('[' + s.mark + ']')}">${escapeHTML(t(s.label))}</button>`
      ).join('');
      wrap.appendChild(chips);
    }

    // 点左侧标记：待处理 ↔ 完成；其它状态点一下回到待处理
    if (markEl) {
      markEl.style.cursor = 'pointer';
      markEl.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = status === 'pending' ? 'done' : 'pending';
        try {
          await persistCandidateStatus(note, content, idx, next);
        } catch (err) {
          showToast(err.message);
        }
      };
    }
    row.querySelectorAll('.md-task-chip').forEach((btn) => {
      btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = btn.dataset.status;
        if (!next || next === status) return;
        try {
          await persistCandidateStatus(note, content, idx, next);
        } catch (err) {
          showToast(err.message);
        }
      };
    });
  });
}

function renderNoteReader(note, content) {
  const readerEl = $('#noteReader');
  if (!readerEl) return;
  const isDraft = note.draft;
  const isWiki = !!note.wiki; // LLM Wiki 来源：只读展示，不提供写回入口

  readerEl.innerHTML = `
    <div class="reader-head">
      <div class="reader-head-top">
        <div class="reader-title-area">
          <div class="eyebrow">${isDraft ? 'TEMPORARY DRAFT' : isWiki ? '🌐 LLM WIKI' : 'VAULT NOTE'}</div>
          <h2>${escapeHTML(note.title)}</h2>
          <div class="reader-path">${escapeHTML(note.path || t('本机临时草稿'))}</div>
        </div>
        <div class="reader-actions">
          ${isWiki ? '' : `<button class="btn btn-secondary" id="btnEditNote">${isDraft ? t('继续编辑') : t('✏️ 编辑')}</button>`}
          <button class="btn btn-secondary" id="btnDownloadNote">${t('↓ 下载 .md')}</button>
        </div>
      </div>
    </div>
    <div class="markdown" id="noteMarkdownBody">${markdown(content)}</div>
  `;

  const btnEdit = $('#btnEditNote');
  if (btnEdit) btnEdit.onclick = () => editVaultNote(note, content);
  $('#btnDownloadNote').onclick = () => download(note.title, content);

  bindWikilinks(readerEl);
  bindCandidateTasks($('#noteMarkdownBody'), note, content);
}

function editVaultNote(note, content) {
  const body = $('#noteMarkdownBody');
  if (!body) return;
  body.outerHTML = `
    <div id="noteEditorWrap">
      <textarea class="draft-editor" id="noteDraftEditor">${escapeHTML(content)}</textarea>
      <div class="autosave-status" id="noteAutosaveStatus">${t('输入后会自动保存到临时草稿')}</div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
        <button class="btn btn-secondary" id="btnCancelEditNote">${t('取消')}</button>
        <button class="btn btn-primary" id="btnSaveEditNote">${t('💾 保存到知识库')}</button>
      </div>
    </div>
  `;

  const btnEdit = $('#btnEditNote');
  if (btnEdit) btnEdit.style.display = 'none';

  bindDraftAutosave({
    editor: $('#noteDraftEditor'),
    note,
    statusEl: $('#noteAutosaveStatus'),
    onSaved: (saved) => { state.current = saved; }
  });

  $('#btnCancelEditNote').onclick = () => renderNoteReader(note, content);
  $('#btnSaveEditNote').onclick = async () => {
    const val = $('#noteDraftEditor').value;
    cancelPendingDraftAutosave(); // 先取消挂起的自动保存，防止它把刚删除的草稿复活
    try {
      await writeNote({ path: note.path, content: val });
      saveDrafts(drafts().filter((d) => d.path !== note.path));
      showToast(t('已成功写回知识库'));
      openNote({ path: note.path, title: note.title });
    } catch (e) {
      showToast(e.message);
    }
  };
}

// ==========================================================================
// VIEW SWITCHER CONTROLLER
// ==========================================================================
// ==========================================================================
// VIEW 5: 📡 RSS 资讯聚合
// ==========================================================================
async function postApi(url, payload) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
  return r.json();
}
async function refreshFeeds(force = false) {
  if (state.feeds.loading) return;
  state.feeds.loading = true;
  try {
    if (force) { try { await postApi('/api/feeds/refresh', {}); } catch (e) { /* 忽略 */ } }
    const data = await api('/api/feeds');
    state.feeds.sources = data.sources || [];
    state.feeds.articles = data.articles || [];
  } catch (e) {
    state.feeds.sources = [];
    state.feeds.articles = [];
  }
  state.feeds.loading = false;
  refreshLater().then(() => { if (state.mainView === 'feeds') renderFeedsView(); });
  updateFeedBadges();
  if (state.mainView === 'feeds') renderFeedsView();
}
async function refreshLater() {
  try {
    const data = await api('/api/feed/later');
    state.feeds.later = data.items || [];
  } catch (e) { /* 稍后读文件缺失时保持为空 */ }
}
function updateFeedBadges() {
  const totalUnread = state.feeds.sources.reduce((s, x) => s + (x.unread || 0), 0);
  const sb = $('#sidebarFeedBadge');
  if (sb) {
    sb.textContent = totalUnread;
    sb.hidden = totalUnread === 0;
  }
}
function renderFeedsView() {
  const srcEl = $('#feedSourceList');
  const artEl = $('#feedArticleList');
  if (!srcEl || !artEl) return;
  $('#crumbSection').textContent = t('资讯聚合');
  $('#crumbTarget').textContent = t('RSS 订阅源');
  const { sources, articles } = state.feeds;
  const { unreadOnly, activeKey } = state.feeds;

  const laterItems = state.feeds.later || [];
  const laterUnread = laterItems.filter((i) => !i.done).length;
  const savedLinks = new Set(laterItems.filter((i) => !i.done).map((i) => i.link));
  const totalUnread = sources.reduce((s, x) => s + (x.unread || 0), 0);
  srcEl.innerHTML = `
    <button class="feed-source-item ${activeKey === 'all' ? 'active' : ''}" data-fkey="all">
      <span class="feed-source-name">${t('全部文章')}</span>
      <em class="feed-source-count">${unreadOnly ? `${totalUnread} ${t('未读')}` : `${articles.length} ${t('篇')}`}</em>
    </button>
    <button class="feed-source-item ${activeKey === '__later__' ? 'active' : ''}" data-fkey="__later__">
      <span class="feed-source-name">${t('📥 稍后读')}</span>
      <em class="feed-source-count">${laterUnread > 0 ? `${laterUnread} ${t('待读')}` : (laterItems.length ? '✓' : t('空'))}</em>
    </button>
    ${sources.map((s) => `
      <button class="feed-source-item ${activeKey === s.key ? 'active' : ''} ${s.ok ? '' : 'feed-source-err'}" data-fkey="${escapeHTML(s.key)}">
        <span class="feed-source-name">${escapeHTML(s.name)}${s.ok ? '' : ' ⚠️'}</span>
        <em class="feed-source-count">${(s.unread || 0) > 0 ? `${s.unread} ${t('未读')}` : '✓'}${!s.ok ? ` ${escapeHTML(s.error || '')}` : ''}</em>
      </button>
    `).join('')}
  `;

  if (activeKey === '__later__') {
    artEl.innerHTML = laterItems.length ? `
      <div class="feed-article-scroll">
        ${laterItems.map((i) => `
          <article class="feed-article-card ${i.done ? 'is-read' : 'is-unread'}" data-link="${escapeHTML(i.link)}">
            <div class="feed-article-main">
              <div class="feed-article-title">${escapeHTML(i.title)}</div>
              <div class="feed-article-meta">
                <span class="feed-article-source">${escapeHTML(i.source)}</span>
                <span class="feed-saved-tag ${i.done ? 'is-done' : ''}">${i.done ? t('已读完') : t('待读')}</span>
              </div>
            </div>
            <div class="feed-article-actions">
              <button class="btn btn-secondary feed-later-done" data-line="${i.line}" title="${t('切换读完状态')}">${i.done ? t('↺ 恢复') : t('✓ 读完')}</button>
              <button class="btn btn-secondary feed-later-remove" data-line="${i.line}" title="${t('从稍后读移除')}">🗑</button>
            </div>
          </article>
        `).join('')}
      </div>
      <div class="feed-article-foot">${t('共 {n} 条 · 保存在 vault 的 read-later.md，Obsidian 同样可见 · 点击文章在新标签打开', { n: laterItems.length })}</div>
    ` : `<div class="empty-reader" style="margin:60px 0"><div class="empty-icon">📥</div><p>${t('暂无稍后读条目，在文章上点「📥 稍后读」收藏')}</p></div>`;
  } else {
  let list = articles;
  if (activeKey !== 'all') list = list.filter((a) => a.key === activeKey);
  if (unreadOnly) list = list.filter((a) => !a.read);

  artEl.innerHTML = list.length ? `
    <div class="feed-article-scroll">
      ${list.map((a) => {
        const saved = savedLinks.has(a.link);
        return `
        <article class="feed-article-card ${a.read ? 'is-read' : 'is-unread'}" data-id="${escapeHTML(a.id)}" data-key="${escapeHTML(a.key)}" data-link="${escapeHTML(a.link || '')}" data-title="${escapeHTML(a.title)}" data-source="${escapeHTML(a.source)}">
          <div class="feed-article-main">
            <div class="feed-article-title">${escapeHTML(a.title)}</div>
            <div class="feed-article-meta">
              <span class="feed-article-source">${escapeHTML(a.source)}</span>
              <span class="feed-article-time">${a.pubDate ? time(new Date(a.pubDate).getTime()) : ''}</span>
              ${saved ? `<span class="feed-saved-tag">${t('已存')}</span>` : ''}
            </div>
            ${a.summary ? `<div class="feed-article-summary">${escapeHTML(a.summary)}</div>` : ''}
          </div>
          <div class="feed-article-actions">
            <button class="btn btn-secondary feed-save-btn" ${saved ? `disabled title="${t('已在稍后读')}"` : `title="${t('存入稍后读')}"`}>${saved ? `✓ ${t('已存')}` : t('📥 稍后读')}</button>
            <button class="btn btn-secondary feed-skip-btn" title="${t('标记已读')}">✓</button>
          </div>
        </article>
      `; }).join('')}
    </div>
    <div class="feed-article-foot">${t('共 {n} 篇{suffix} · 点击文章自动标记已读并在新标签打开', { n: list.length, suffix: unreadOnly ? t('（未读）') : '' })}</div>
  ` : `<div class="empty-reader" style="margin:60px 0"><div class="empty-icon">📡</div><p>${unreadOnly ? t('没有未读文章 🎉') : t('暂无文章，点「刷新」拉取')}</p></div>`;
  }

  srcEl.onclick = (e) => {
    const item = e.target.closest('.feed-source-item');
    if (!item) return;
    state.feeds.activeKey = item.dataset.fkey;
    renderFeedsView();
  };

  artEl.onclick = async (e) => {
    if (activeKey === '__later__') {
      const doneBtn = e.target.closest('.feed-later-done');
      if (doneBtn) {
        try {
          await postApi('/api/feed/later', { action: 'done', line: Number(doneBtn.dataset.line) });
          await refreshLater();
          renderFeedsView();
        } catch (err) { showToast(err.message || t('操作失败')); }
        return;
      }
      const rmBtn = e.target.closest('.feed-later-remove');
      if (rmBtn) {
        if (!confirm(t('确定要从稍后读中移除此条目吗？'))) return;
        try {
          await postApi('/api/feed/later', { action: 'remove', line: Number(rmBtn.dataset.line) });
          await refreshLater();
          renderFeedsView();
          showToast(t('已从稍后读移除'));
        } catch (err) { showToast(err.message || t('操作失败')); }
        return;
      }
      const lcard = e.target.closest('.feed-article-card');
      if (lcard && lcard.dataset.link) window.open(lcard.dataset.link, '_blank');
      return;
    }
    const saveBtn = e.target.closest('.feed-save-btn');
    if (saveBtn) {
      const card = saveBtn.closest('.feed-article-card');
      try {
        const r = await postApi('/api/feed/save', { title: card.dataset.title, link: card.dataset.link, source: card.dataset.source });
        if (r && r.items) state.feeds.later = r.items;
        showToast(t('已存入稍后读'));
        renderFeedsView();
      } catch (err) { showToast(t('保存失败')); }
      return;
    }
    const skipBtn = e.target.closest('.feed-skip-btn');
    if (skipBtn) {
      const card = skipBtn.closest('.feed-article-card');
      await markArticleRead(card.dataset.key, card.dataset.id);
      return;
    }
    const card = e.target.closest('.feed-article-card');
    if (card && card.dataset.link) {
      await markArticleRead(card.dataset.key, card.dataset.id);
      window.open(card.dataset.link, '_blank');
    }
  };
}
async function markArticleRead(key, id) {
  try { await postApi('/api/feed/read', { key, id }); await refreshFeeds(false); } catch (e) { /* 忽略 */ }
}

const settingsFields = () => [
  { key: 'OBSIDIAN_VAULT_ROOT', label: t('Vault 根目录'), placeholder: '/absolute/path/to/vault', hint: t('本机 Markdown vault（如 Obsidian 库）的绝对路径，启动后会在其中扫描笔记。修改后需重启服务。可直接填写，也可点"选择…"弹窗浏览目录。'), picker: true },
  { key: 'VAULT_INBOX_PATH', label: t('待办文件'), placeholder: 'Inbox.md', hint: t('Vault 内相对路径。事项清单读写此文件，第一次新增待办时会自动创建。可直接填写，也可点"选择…"弹窗选目录，文件名自动保留。'), picker: true, pickerFile: 'Inbox.md' },
  { key: 'VAULT_DAILY_PATH_PATTERN', label: t('每日笔记路径'), placeholder: 'Daily/{YYYY}-{MM}-{DD}.md', hint: t('必须包含 {YYYY}、{MM}、{DD}。决定每日日记在 vault 中的位置。可直接填写，也可点"选择…"弹窗选目录，文件名模板自动保留。'), picker: true, pickerFile: '{YYYY}-{MM}-{DD}.md' },
  { key: 'VAULT_DAILY_TEMPLATE_FILE', label: t('日记模板文件（可选）'), placeholder: '00_META/templates/daily_note_template.md', hint: t('填写 vault 内的模板文件后，新建每日笔记优先使用它（支持 Obsidian 的 {{date:YYYY-MM-DD}} 格式占位符）；文件缺失时回退到「每日笔记模板」编辑器的内容。可直接填写，也可点"选择…"弹窗选目录，文件名自动保留。'), picker: true, pickerFile: 'daily_note_template.md' },
  { key: 'VAULT_RSS_READ_LATER_PATH', label: t('RSS 稍后读文件'), placeholder: 'read-later.md', hint: t('在「资讯聚合」中保存条目时写入的 Markdown 文件。') },
  { key: 'VAULT_CHAT_SAVE_PATH_PATTERN', label: t('问答保存路径'), placeholder: 'answers/{YYYY}-{MM}-{DD}-answer-{slug}.md', hint: t('点击「保存为笔记」时问答内容的存放位置。必须包含 {slug}，可使用 {YYYY}、{MM}、{DD}、{date}。') },
  { key: 'LMSTUDIO_BASE_URL', label: t('本地模型服务地址（LM Studio）'), placeholder: 'http://127.0.0.1:1234/v1', hint: t('知识问答与语义索引通过此 OpenAI 兼容接口调用本机大模型。装有 LM Studio 时保持默认即可；只用 Ollama 或 DeepSeek 时可忽略本项。') },
  { key: 'DEFAULT_LLM_MODEL', label: t('默认模型'), placeholder: t('留空 = 自动选择（LM Studio 优先）'), hint: t('知识问答默认使用此模型，问答页仍可临时切换。可从下拉建议中选择本机或自定义服务的模型；所选服务离线时自动回退到其它可用模型。'), datalist: 'defaultModelOptions' },
  { key: 'KB_SEARCH_SCRIPT', label: t('关键词检索脚本（可选）'), placeholder: t('留空 = 使用内置检索'), hint: t('知识问答默认使用内置关键词检索，零配置可用。若自备了检索脚本（如基于 ripgrep 的 kb-search.py），填绝对路径即可替换内置实现；脚本缺失或出错时自动回退内置检索。') },
  { key: 'QDRANT_URL', label: t('Qdrant 向量数据库（可选加速）'), placeholder: 'http://127.0.0.1:6333', hint: t('留空 = 使用内置检索。配置后语义检索改走 Qdrant 的向量索引（52 万块从约 1 秒降到毫秒级），首次会自动把已有向量同步过去（约几分钟）。本机启动：docker run -d --name qdrant -p 127.0.0.1:6333:6333 qdrant/qdrant') },
  { key: 'LLM_WIKI_BASE_URL', label: t('LLM Wiki 服务地址（可选）'), placeholder: 'http://127.0.0.1:19828', hint: t('填写 LLM Wiki 桌面应用开放的本地 API 地址（留空 = 不启用）。启用后知识问答会把 Wiki 项目的检索命中并入参考素材，来源可在阅读器中只读打开。') },
  { key: 'LLM_WIKI_API_TOKEN', label: t('LLM Wiki 访问令牌'), placeholderFn: (v) => (v && v.hasWikiToken ? t('已配置，留空保持不变') : t('可留空（未开启访问控制时不需要）')), password: true, hint: t('LLM Wiki 开启 API 访问控制时必填。令牌只写入本机配置文件，不会回显或上传。') },
  { key: 'LLM_WIKI_PROJECT', label: t('LLM Wiki 项目'), placeholder: 'current', hint: t('检索哪个 Wiki 项目：填项目 id，或保持 current 使用 LLM Wiki 中当前打开的项目。') },
  { key: 'HOST', label: t('监听地址'), placeholder: '127.0.0.1', hint: t('默认仅本机访问；只建议在可信局域网内改为 0.0.0.0。') },
  { key: 'PORT', label: t('端口'), placeholder: '4177', hint: t('1-65535 的数字，默认 4177。') }
];

// 设置页标签：9 个配置项 + 语义索引按用途拆成 5 个标签，避免单页堆满
const settingsTabs = () => [
  { id: 'vault', title: t('知识库'), icon: '📚', desc: t('VaultDesk 读取和写入笔记的位置。'), fields: ['OBSIDIAN_VAULT_ROOT', 'VAULT_INBOX_PATH', 'VAULT_DAILY_PATH_PATTERN', 'VAULT_DAILY_TEMPLATE_FILE'] },
  { id: 'save', title: t('保存位置'), icon: '💾', desc: t('问答内容保存到 vault 时使用的路径，为 vault 内相对路径。'), fields: ['VAULT_CHAT_SAVE_PATH_PATTERN'] },
  { id: 'feeds', title: t('资讯聚合'), icon: '📡', desc: t('「资讯聚合」模块订阅的 RSS 源与稍后读保存位置。'), fields: ['VAULT_RSS_READ_LATER_PATH'] },
  { id: 'ai', title: t('AI 大模型'), icon: '🤖', desc: t('知识问答的对话模型来源。本机没有安装任何模型服务时，除知识问答外的功能不受影响。'), fields: ['DEFAULT_LLM_MODEL', 'LMSTUDIO_BASE_URL'] },
  { id: 'search', title: t('知识检索'), icon: '🔍', desc: t('问答取材方式：内置关键词检索默认生效、无需配置；自备脚本、语义向量检索与 LLM Wiki 知识库均为可选增强。'), fields: ['KB_SEARCH_SCRIPT', 'QDRANT_URL', 'LLM_WIKI_BASE_URL', 'LLM_WIKI_API_TOKEN', 'LLM_WIKI_PROJECT'] },
  { id: 'import', title: t('文档导入'), icon: '📥', desc: t('把外部文件夹中的文档转换为 Markdown 导入 vault，可添加多个文件夹并定时监控增量导入。'), fields: [] },
  { id: 'server', title: t('服务地址'), icon: '⚙️', desc: t('VaultDesk 网页服务监听的本机地址与端口。'), fields: ['HOST', 'PORT'] }
];

const SETTINGS_TAB_KEY = 'vaultdesk-settings-tab';

function savedSettingsTab() {
  try { return localStorage.getItem(SETTINGS_TAB_KEY) || 'vault'; } catch { return 'vault'; }
}

function rememberSettingsTab(id) {
  try { localStorage.setItem(SETTINGS_TAB_KEY, id); } catch { /* 存储不可用时忽略 */ }
}

async function refreshLLMStatus() {
  const el = $('#llmStatusText');
  if (!el) return;
  try {
    const data = await api('/api/llm/models');
    const models = data.models || [];
    state.settingsModels = models;
    // 顺带填充"默认模型"设置项的下拉建议（与模型列表同源）
    const dmOptions = $('#defaultModelOptions');
    if (dmOptions) {
      dmOptions.innerHTML = models.map((m) => `<option value="${escapeHTML(m.id)}">${escapeHTML(m.name)}</option>`).join('');
    }
    // 默认模型输入框显示「供应商 · 模型名」而不是裸 id（如 custom:xxx:yyy）；提交时反查 id
    const dmInput = $('#settingsForm [name="DEFAULT_LLM_MODEL"]');
    if (dmInput) {
      dmInput.onchange = () => {
        const m = models.find((x) => x.id === dmInput.value.trim());
        if (m) dmInput.value = m.name;
      };
      const cur = models.find((x) => x.id === dmInput.value.trim());
      if (cur && document.activeElement !== dmInput) dmInput.value = cur.name;
    }
    const localCount = models.filter((m) => m.provider === 'lmstudio' || m.provider === 'ollama').length;
    const cloud = models.some((m) => m.provider === 'deepseek');
    const customCount = new Set(models.filter((m) => String(m.provider || '').startsWith('custom:')).map((m) => m.provider)).size;
    if (!models.length) {
      el.textContent = t('未检测到大模型服务，知识问答暂不可用。可安装并启动 LM Studio 或 Ollama，配置 DeepSeek，或在设置中添加自定义模型服务。');
      el.className = 'llm-status is-off';
    } else {
      const parts = [];
      if (localCount) parts.push(t('本机可用模型 {n} 个', { n: localCount }));
      if (cloud) parts.push(t('DeepSeek 云端已配置'));
      if (customCount) parts.push(t('自定义服务 {n} 个', { n: customCount }));
      el.textContent = t('已连接 · {s}', { s: parts.join(' · ') });
      el.className = 'llm-status is-ok';
    }
  } catch (err) {
    el.textContent = t('检测失败：{e}', { e: err.message });
    el.className = 'llm-status is-off';
  }
}

// LLM Wiki 连接状态（设置页"知识检索"标签）：随配置现读，保存后无需重启即可重新检测
async function refreshWikiStatus() {
  const el = $('#wikiStatusText');
  if (!el) return;
  try {
    const d = await api('/api/wiki/status');
    if (!d.configured) {
      el.textContent = t('未配置：填写上方服务地址即启用');
      el.className = 'llm-status is-off';
      return;
    }
    if (!d.ok) {
      el.textContent = d.error || t('连接失败');
      el.className = 'llm-status is-off';
      return;
    }
    const current = (d.projects || []).find((p) => p.current);
    const bits = [
      d.version ? `v${d.version}` : '',
      (d.projects || []).length ? t('{n} 个项目', { n: d.projects.length }) : '',
      current ? t('当前：{s}', { s: current.name }) : '',
      d.hasToken ? '' : t('未设令牌')
    ].filter(Boolean);
    el.textContent = t('已连接 · {s}', { s: bits.join(' · ') });
    el.className = 'llm-status is-ok';
  } catch (err) {
    el.textContent = t('检测失败：{e}', { e: err.message });
    el.className = 'llm-status is-off';
  }
}

// 一键重启 VaultDesk 服务：POST /api/restart 后轮询等待新进程就绪，再重读配置
async function restartServerFlow(btn) {
  if (!confirm(t('确定重启 VaultDesk 服务吗？重启后页面会自动恢复。'))) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('正在重启…');
  try { await postApi('/api/restart', {}); } catch { /* 服务断开是预期行为 */ }
  const deadline = Date.now() + 30000;
  let back = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try { await api('/api/stats'); back = true; break; } catch { /* 新进程还没就绪 */ }
  }
  showToast(back ? t('服务已重启') : t('重启失败：服务未能在 30 秒内恢复。'));
  btn.disabled = false;
  btn.textContent = original;
  state.settings = null;
  await renderSettingsView();
}

function settingsFieldHtml(field, values, defaults) {
  const listAttr = field.datalist ? ` list="${field.datalist}"` : '';
  const typeAttr = field.password ? ' type="password" autocomplete="new-password"' : ' autocomplete="off"';
  const placeholder = typeof field.placeholderFn === 'function' ? field.placeholderFn(values) : (defaults[field.key] || field.placeholder);
  const input = `<input name="${escapeHTML(field.key)}"${listAttr} value="${escapeHTML(values[field.key] || '')}" placeholder="${escapeHTML(placeholder)}"${typeAttr}>`;
  const datalist = field.datalist ? `<datalist id="${field.datalist}"></datalist>` : '';
  return `
    <label class="settings-field">
      <span>${escapeHTML(field.label)}</span>
      ${field.picker ? `<div class="settings-input-row">${input}<button type="button" class="btn btn-secondary btn-pick-dir" data-pick-for="${escapeHTML(field.key)}">${t('选择…')}</button></div>` : input}
      ${datalist}
      <small>${escapeHTML(field.hint)}</small>
    </label>
  `;
}

// 自定义模型服务卡片：API Key 永不回显，留空 = 保持已保存的值
function customProviderCardHtml(p) {
  return `
    <div class="custom-provider-card" data-id="${escapeHTML(p.id || '')}">
      <div class="provider-grid">
        <label class="settings-field"><span>${t('名称')}</span><input class="cp-name" value="${escapeHTML(p.name || '')}" placeholder="${t('例如 DeepSeek 官方')}" autocomplete="off"></label>
        <label class="settings-field"><span>${t('服务地址（Base URL）')}</span><input class="cp-url" value="${escapeHTML(p.baseUrl || '')}" placeholder="https://api.deepseek.com/v1" autocomplete="off"></label>
        <label class="settings-field"><span>${t('API Key')}</span><input class="cp-key" type="password" value="" placeholder="${p.hasKey ? t('已配置，留空保持不变') : t('可留空（本地服务通常不需要）')}" autocomplete="new-password"></label>
        <label class="settings-field"><span>${t('模型名称（多个用逗号分隔）')}</span><input class="cp-models" value="${escapeHTML((p.models || []).join(', '))}" placeholder="deepseek-chat, deepseek-reasoner" autocomplete="off"></label>
      </div>
      <div class="cp-actions">
        <button type="button" class="btn btn-secondary cp-test">${t('测试连通性')}</button>
        <button type="button" class="btn btn-secondary cp-del">${t('删除')}</button>
        <span class="cp-status"></span>
      </div>
    </div>
  `;
}

function collectProvidersFromDOM() {
  return Array.from(document.querySelectorAll('#customProvidersList .custom-provider-card')).map((card) => ({
    id: card.dataset.id || '',
    name: card.querySelector('.cp-name').value.trim(),
    baseUrl: card.querySelector('.cp-url').value.trim(),
    apiKey: card.querySelector('.cp-key').value,
    models: card.querySelector('.cp-models').value
  }));
}

async function renderSettingsView() {
  const container = $('#settingsContainer');
  if (!container) return;
  $('#crumbSection').textContent = t('系统设置');
  $('#crumbTarget').textContent = t('VaultDesk 配置');
  if (!state.settings || state.settingsLoading) {
    container.innerHTML = `<div class="settings-loading">${t('正在读取配置…')}</div>`;
    try {
      state.settingsLoading = true;
      state.settings = await api('/api/settings');
    } catch (err) {
      container.innerHTML = `<div class="settings-loading">${t('配置读取失败：{e}', { e: escapeHTML(err.message) })}</div>`;
      return;
    } finally {
      state.settingsLoading = false;
    }
  }

  const cfg = state.settings || {};
  const values = cfg.values || {};
  const effective = cfg.effective || {};
  const defaults = cfg.defaults || {};
  const dailyTemplate = cfg.dailyTemplate || {};
  const notice = cfg.requiresRestart ? `<div class="settings-notice is-warning">${t('配置已保存，重启 VaultDesk 后生效。')} <button type="button" class="btn btn-secondary btn-restart-inline">${t('立即重启')}</button></div>` : '';
  const tabs = settingsTabs();
  const activeTab = tabs.some((tab) => tab.id === savedSettingsTab()) ? savedSettingsTab() : 'vault';
  const fieldHtmlFor = (key) => settingsFieldHtml(settingsFields().find((f) => f.key === key), { ...values, hasWikiToken: !!cfg.hasWikiToken }, defaults);
  const tabsHtml = tabs.map((tab) => `
    <button type="button" class="settings-tab${tab.id === activeTab ? ' is-active' : ''}" data-tab="${tab.id}" role="tab">${tab.icon} ${escapeHTML(tab.title)}</button>
  `).join('');
  const panelsHtml = tabs.map((tab) => `
    <div class="settings-tab-panel" data-panel="${tab.id}" role="tabpanel"${tab.id === activeTab ? '' : ' hidden'}>
      <p class="settings-group-desc">${escapeHTML(tab.desc)}</p>
      ${tab.fields.map(fieldHtmlFor).join('')}
      ${tab.id === 'feeds' ? `
        <div class="settings-field settings-template-field">
          <span>${t('RSS 源列表（每行一个：名称 | URL | 每源条数，名称和条数可省略）')}</span>
          <textarea name="rssFeeds" id="rssFeedsInput" class="settings-template-editor" rows="9">${escapeHTML(cfg.rssFeeds?.text || '')}</textarea>
          <small>${cfg.rssFeeds?.custom ? t('当前使用上面的自定义源；') : t('当前使用内置默认源；')}${t('清空保存即恢复内置默认。示例：少数派 | https://sspai.com/feed | 10。保存后新增源会自动抓取，也可在「资讯聚合」页手动刷新。')}</small>
        </div>
      ` : ''}
      ${tab.id === 'ai' ? `
        <div class="settings-field">
          <span>${t('服务状态')}</span>
          <div id="llmStatusText" class="llm-status is-checking">${t('正在检测本机模型服务…')}</div>
        </div>
        <h2 class="settings-subhead">${t('内置本地服务')}</h2>
        <div class="builtin-providers">
          <div class="builtin-provider-row">
            <div class="bp-info"><strong>Ollama</strong><small>${t('固定连接本机 127.0.0.1:11434，自动检测')}</small></div>
            <button type="button" class="btn btn-secondary" data-fetch-models="ollama">${t('获取本地模型')}</button>
          </div>
          <div class="builtin-provider-row">
            <div class="bp-info"><strong>LM Studio</strong><small>${t('使用上方「本地模型服务地址」连接')}</small></div>
            <button type="button" class="btn btn-secondary" data-fetch-models="lmstudio">${t('获取本地模型')}</button>
          </div>
          <div class="provider-models-out" id="builtinModelsOut" hidden></div>
        </div>
        <h2 class="settings-subhead">${t('自定义模型服务（OpenAI 兼容）')}</h2>
        <p class="settings-group-desc">${t('接入任意 OpenAI 兼容服务（DeepSeek 官方、第三方中转、vLLM 等）。保存后，其模型会出现在问答模型下拉和「知识检索」的嵌入服务中。')}</p>
        <div id="customProvidersList"></div>
        <button type="button" class="btn btn-secondary" id="btnAddProvider">${t('＋ 添加服务')}</button>
      ` : ''}
      ${tab.id === 'vault' ? `
        <label class="settings-field settings-template-field">
          <span>${t('每日笔记模板')}</span>
          <textarea name="dailyTemplate" id="dailyTemplateInput" class="settings-template-editor" rows="8">${escapeHTML(dailyTemplate.content || '')}</textarea>
          <small>${t('新建每日笔记时使用的模板，保存到应用自己的 data/daily-template.md。支持 {{date}}、{{YYYY}}、{{MM}}、{{DD}} 及 Obsidian 风格的 {{date:YYYY-MM-DD}}。配置上方「日记模板文件」后优先使用该文件。')}</small>
          <small class="settings-template-source">${dailyTemplate.source === 'vault'
            ? t('当前生效：vault 模板文件（{f}）', { f: dailyTemplate.vaultFile })
            : (dailyTemplate.vaultFile ? t('配置的模板文件不存在或不可读，当前生效：内置模板') : t('当前生效：内置模板'))}</small>
        </label>
      ` : ''}
      ${tab.id === 'search' ? `
        <h2 class="settings-subhead">${t('LLM Wiki 知识库（可选）')}</h2>
        <div class="settings-field">
          <span>${t('连接状态')}</span>
          <div class="settings-input-row">
            <div id="wikiStatusText" class="llm-status is-checking">${t('正在检测 LLM Wiki…')}</div>
            <button type="button" class="btn btn-secondary" id="btnWikiTest">${t('测试连接')}</button>
          </div>
          <small>${t('连接 LLM Wiki 桌面应用的本地 API。启用后知识问答会并入其项目的检索结果，来源在阅读器中只读打开，不会写入 vault。')}</small>
        </div>
        <h2 class="settings-subhead">${t('向量化语义搜索（可选）')}</h2>
        <div class="settings-current" id="vectorSummary">
          <div><span>${t('索引状态')}</span><strong id="vecSummaryText">${t('正在读取…')}</strong></div>
        </div>
        <div class="vector-form">
          <label class="settings-field">
            <span>${t('向量化的目录（vault 内相对路径，可添加多个；留空 = 整个 vault）')}</span>
            <div class="settings-input-row">
              <input id="vecRoot" list="vecRootOptions" placeholder="${t('例如 notes、Daily')}" autocomplete="off">
              <button type="button" class="btn btn-secondary" id="btnVecRootAdd">${t('添加')}</button>
              <button type="button" class="btn btn-secondary" id="btnPickVecRoot">${t('选择…')}</button>
            </div>
            <datalist id="vecRootOptions"></datalist>
            <div class="vec-root-chips" id="vecRootChips"></div>
            <small>${t('可添加多个目录后一次性建立索引；目录内 .md/.txt 的新增与修改会被监控并自动增量更新。列表为空时索引整个 vault。目录选择会自动保存在本机浏览器，无需点保存。')}</small>
          </label>
          <label class="settings-field">
            <span>${t('嵌入服务')}</span>
            <select id="vecProvider" class="chat-select">
              <option value="ollama">${t('Ollama（本机 11434）')}</option>
              <option value="lmstudio">${t('LM Studio（OpenAI 兼容接口）')}</option>
            </select>
            <small>${t('对目录分块后调用本机嵌入模型生成向量，全部数据保存在应用 data/ 目录。')}</small>
          </label>
          <label class="settings-field">
            <span>${t('嵌入模型')}</span>
            <input id="vecModel" class="chat-select" list="vecModelOptions" placeholder="${t('正在读取嵌入模型…')}" autocomplete="off" spellcheck="false">
            <datalist id="vecModelOptions"></datalist>
            <small>${t('可从下拉建议中选择，也可直接输入嵌入服务里已有的任意模型 id（如 qwen3-embedding、bge-m3、nomic-embed-text）。')}</small>
          </label>
        </div>
        <div class="vector-progress-wrap" id="vecProgressWrap" hidden>
          <div class="vector-progress-bar"><div class="vector-progress-fill" id="vecProgressFill"></div></div>
          <div class="vector-progress-text" id="vecStatusText"></div>
        </div>
        <div class="settings-error" id="vecError" hidden></div>
        <div class="settings-actions">
          <button type="button" class="btn btn-primary" id="btnVecStart">${t('开始向量化')}</button>
          <button type="button" class="btn btn-secondary" id="btnVecStop" hidden>${t('停止')}</button>
          <button type="button" class="btn btn-secondary" id="btnVecClear">${t('清空索引')}</button>
        </div>
      ` : ''}
      ${tab.id === 'import' ? `
        <h2 class="settings-subhead">${t('转换环境')}</h2>
        <div class="settings-field">
          <span>${t('Python 转换环境')}</span>
          <div class="settings-input-row">
            <div id="importPyStatus" class="llm-status is-checking">${t('正在检测…')}</div>
            <button type="button" class="btn btn-secondary" id="btnImportPyRefresh">${t('重新检测')}</button>
          </div>
          <small>${t('文档转换使用装有 firecrawl-anydoc 的 Python 环境（自动探测，也可在 .env 用 DOC_IMPORT_PYTHON 指定解释器）。未探测到时仅能导入 .md/.txt/.csv。')}</small>
        </div>
        <h2 class="settings-subhead">${t('导入源')}</h2>
        <div class="settings-current">
          <div><span>${t('导入状态')}</span><strong id="importSummaryText">${t('正在读取…')}</strong></div>
        </div>
        <div class="vector-progress-wrap" id="importProgressWrap" hidden>
          <div class="vector-progress-bar"><div class="vector-progress-fill" id="importProgressFill"></div></div>
          <div class="vector-progress-text" id="importProgressText"></div>
        </div>
        <div class="settings-error" id="importError" hidden></div>
        <div id="importSourcesList"></div>
        <div class="settings-field">
          <span>${t('添加导入源')}</span>
          <div class="settings-input-row">
            <input id="importSrcDir" placeholder="${t('源文件夹绝对路径，如 /Users/you/Documents')}" autocomplete="off">
            <button type="button" class="btn btn-secondary" id="btnPickImportSrc">${t('选择…')}</button>
          </div>
          <div class="settings-input-row">
            <input id="importTargetDir" placeholder="${t('vault 内目标文件夹（留空 = vault 根目录）')}" autocomplete="off">
            <button type="button" class="btn btn-secondary" id="btnPickImportTarget">${t('选择…')}</button>
          </div>
          <div class="settings-input-row">
            <label class="import-watch-row"><input type="checkbox" id="importWatch"> ${t('定时监控该文件夹')}</label>
            <select id="importInterval" class="chat-select">
              <option value="300">${t('每 5 分钟')}</option>
              <option value="900">${t('每 15 分钟')}</option>
              <option value="1800">${t('每 30 分钟')}</option>
              <option value="3600">${t('每 1 小时')}</option>
            </select>
          </div>
          <small>${t('递归扫描源文件夹的子文件夹，把支持的格式（doc/docx/wps/xls/xlsx/pptx/pdf/txt/csv/md）转换为 Markdown，按子目录结构保存到目标文件夹。开启监控后，新增或编辑的文件会按计划自动增量导入。可添加多个导入源。')}</small>
          <div class="settings-actions">
            <button type="button" class="btn btn-primary" id="btnImportAdd">${t('添加导入源')}</button>
          </div>
        </div>
      ` : ''}
    </div>
  `).join('');

  container.innerHTML = `
    <section class="settings-panel">
      <div class="settings-head">
        <div>
          <div class="eyebrow">APP SETTINGS</div>
          <h1>${t('系统设置')}</h1>
        </div>
        <button class="btn btn-secondary" id="btnReloadSettings">${t('重新读取')}</button>
        <button class="btn btn-secondary" id="btnRestartServer">${t('重启服务')}</button>
      </div>
      <div class="settings-current">
        <div><span>${t('当前 vault')}</span><strong>${escapeHTML(effective.OBSIDIAN_VAULT_ROOT || '')}</strong></div>
        <div><span>${t('配置文件')}</span><strong>${escapeHTML(cfg.envPath || '')}</strong></div>
      </div>
      ${notice}
      <div class="settings-tabs" role="tablist">${tabsHtml}</div>
      <form id="settingsForm" class="settings-form">
        ${panelsHtml}
        <div class="settings-error" id="settingsError" hidden></div>
        <div class="settings-actions">
          <button type="button" class="btn btn-secondary" id="btnUseDefaults">${t('填入默认值')}</button>
          <button type="button" class="btn btn-secondary" id="btnResetDailyTemplate">${t('恢复默认模板')}</button>
          <button type="submit" class="btn btn-primary">${t('保存设置')}</button>
        </div>
      </form>
    </section>
  `;

  const switchSettingsTab = (id) => {
    container.querySelectorAll('.settings-tab').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.tab === id));
    container.querySelectorAll('.settings-tab-panel').forEach((panel) => { panel.hidden = panel.dataset.panel !== id; });
    rememberSettingsTab(id);
  };
  container.querySelectorAll('.settings-tab').forEach((btn) => {
    btn.onclick = () => switchSettingsTab(btn.dataset.tab);
  });

  container.querySelectorAll('.btn-pick-dir').forEach((btn) => {
    btn.onclick = () => {
      const input = $(`#settingsForm [name="${btn.dataset.pickFor}"]`);
      if (!input) return;
      const field = settingsFields().find((f) => f.key === btn.dataset.pickFor);
      // vault 内文件路径（待办文件/每日笔记模板）：弹窗选目录，文件名保留
      if (field?.pickerFile) {
        // 以"Vault 根目录"输入框的当前值为基准——允许尚未保存/重启的新根目录；
        // 若用运行中的旧根目录校验，改过根目录还没重启时选什么都会被误判越界
        const rootInput = $(`#settingsForm [name="OBSIDIAN_VAULT_ROOT"]`);
        const vaultRoot = String((rootInput && rootInput.value.trim()) || (state.settings && state.settings.effective?.OBSIDIAN_VAULT_ROOT) || '').replace(/\/+$/, '');
        if (!vaultRoot) { showToast(t('请先设置 Vault 根目录，再选择文件位置')); return; }
        const current = input.value.trim().replace(/\\/g, '/');
        const base = current.split('/').pop() || '';
        const fileName = base && (base.includes('{') || /\.md$/i.test(base)) ? base : field.pickerFile;
        const dirPart = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
        openDirPicker({
          initial: `${vaultRoot}${dirPart ? `/${dirPart}` : ''}`,
          onPick: (p) => {
            if (p !== vaultRoot && !p.startsWith(`${vaultRoot}/`)) { showToast(t('路径需要位于 vault 内，请重新选择')); return; }
            const rel = p === vaultRoot ? '' : p.slice(vaultRoot.length + 1).replace(/^[/\\]/, '');
            input.value = rel ? `${rel}/${fileName}` : fileName;
          }
        });
        return;
      }
      openDirPicker({ initial: input.value.trim(), onPick: (p) => { input.value = p; } });
    };
  });
  $('#btnPickVecRoot').onclick = () => {
    const input = $('#vecRoot');
    const rootInput = $('#settingsForm [name="OBSIDIAN_VAULT_ROOT"]');
    const vaultRoot = String((rootInput && rootInput.value.trim()) || (state.settings && state.settings.effective?.OBSIDIAN_VAULT_ROOT) || '').trim();
    openDirPicker({
      initial: vaultRoot || input.value.trim(),
      onPick: (p) => {
        if (!vaultRoot) { input.value = p; return; }
        if (p !== vaultRoot && !p.startsWith(`${vaultRoot}/`)) { showToast(t('语义索引目录需要位于 vault 内，请重新选择')); return; }
        input.value = p === vaultRoot ? '' : p.slice(vaultRoot.length + 1).replace(/^[/\\]/, ''); // 选中 vault 根目录时为空串 = 整个 vault
      }
    });
  };

  $('#btnReloadSettings').onclick = async () => {
    state.settings = null;
    await renderSettingsView();
  };
  $('#btnRestartServer').onclick = (e) => restartServerFlow(e.currentTarget);
  container.querySelectorAll('.btn-restart-inline').forEach((b) => { b.onclick = (e) => restartServerFlow(e.currentTarget); });
  $('#btnUseDefaults').onclick = () => {
    settingsFields().forEach((field) => {
      const input = $(`#settingsForm [name="${field.key}"]`);
      if (input) input.value = defaults[field.key] || '';
    });
  };
  $('#btnResetDailyTemplate').onclick = () => {
    const input = $('#dailyTemplateInput');
    if (input) input.value = dailyTemplate.defaultContent || '# {{date}}\n\n## Notes\n';
  };
  $('#settingsForm').onsubmit = async (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const valuesToSave = Object.fromEntries(settingsFields().map(field => [field.key, String(form.get(field.key) || '').trim()]));
    // 默认模型输入框显示的是模型名称（含自定义服务名），提交前反查回真实模型 id
    const dmRaw = valuesToSave.DEFAULT_LLM_MODEL;
    if (dmRaw && state.settingsModels) {
      const byName = state.settingsModels.find((m) => m.name === dmRaw);
      if (byName) valuesToSave.DEFAULT_LLM_MODEL = byName.id;
    }
    const templateToSave = String(form.get('dailyTemplate') || '');
    const feedsToSave = String(form.get('rssFeeds') ?? '');
    const errorBox = $('#settingsError');
    errorBox.hidden = true;
    try {
      await postApi('/api/llm/custom-providers', { providers: collectProvidersFromDOM() });
      state.settings = await saveSettings(valuesToSave, templateToSave, feedsToSave);
      showToast(t('设置已保存'));
      renderSettingsView();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  };
  // ---- AI 标签页：内置服务“获取本地模型” ----
  container.querySelectorAll('[data-fetch-models]').forEach((btn) => {
    btn.onclick = async () => {
      const out = $('#builtinModelsOut');
      if (!out) return;
      out.hidden = false;
      out.textContent = t('正在获取…');
      try {
        const d = await api(`/api/llm/local-models?provider=${btn.dataset.fetchModels}`);
        if (!d.ok) { out.textContent = `${t('获取失败')}：${d.error}`; return; }
        if (!d.models.length) { out.textContent = t('连接成功，但未发现已下载的模型。'); return; }
        const label = btn.dataset.fetchModels === 'ollama' ? 'Ollama' : 'LM Studio';
        out.innerHTML = `<strong>${t('{label}（{n} 个）：', { label, n: d.models.length })}</strong>` +
          d.models.map((m) => `<code>${escapeHTML(m.id)}</code>${m.size ? `<small>(${escapeHTML(m.size)})</small>` : ''}`).join(' ');
      } catch (err) {
        out.textContent = `${t('获取失败')}：${err.message}`;
      }
    };
  });

  // ---- AI 标签页：自定义模型服务（卡片增删/测试/保存） ----
  let customProviders = [];
  try {
    customProviders = (await api('/api/llm/custom-providers')).providers || [];
  } catch { /* 读取失败按空列表处理 */ }
  // await 期间视图可能已被重渲染（重新读取/切语言）——重新取活动 DOM 上的元素，避免写入已脱离的旧节点
  const providerListEl = $('#customProvidersList');
  if (providerListEl) {
    providerListEl.innerHTML = customProviders.map(customProviderCardHtml).join('');
    $('#btnAddProvider').onclick = () => {
      providerListEl.insertAdjacentHTML('beforeend', customProviderCardHtml({}));
      providerListEl.lastElementChild.querySelector('.cp-name').focus();
    };
    providerListEl.onclick = async (e) => {
      const card = e.target.closest('.custom-provider-card');
      if (!card) return;
      const status = card.querySelector('.cp-status');
      if (e.target.classList.contains('cp-test')) {
        status.className = 'cp-status is-checking';
        status.textContent = t('正在测试…');
        try {
          const d = await postApi('/api/llm/providers/test', {
            baseUrl: card.querySelector('.cp-url').value.trim(),
            apiKey: card.querySelector('.cp-key').value
          });
          if (!d.ok) { status.className = 'cp-status is-bad'; status.textContent = `✗ ${d.error}`; return; }
          const names = d.models.slice(0, 6).join(', ');
          status.className = 'cp-status is-ok';
          status.textContent = t('✓ 连通成功，{n} 个模型{s}', { n: d.models.length, s: names ? `：${names}${d.models.length > 6 ? ' …' : ''}` : '' });
        } catch (err) {
          status.className = 'cp-status is-bad';
          status.textContent = `✗ ${err.message}`;
        }
        return;
      }
      if (e.target.classList.contains('cp-del')) {
        if (card.dataset.id) {
          try {
            await postApi('/api/llm/custom-providers', { providers: collectProvidersFromDOM().filter((p) => p.id !== card.dataset.id) });
            showToast(t('已删除该自定义服务'));
            refreshLLMStatus();
          } catch (err) { showToast(`${t('删除失败')}：${err.message}`); return; }
        }
        card.remove();
      }
    };
  }

  // 嵌入服务下拉追加自定义服务选项（需在 initVectorPanel 之前完成）
  const vecProviderSel = $('#vecProvider');
  if (vecProviderSel) {
    for (const p of customProviders) {
      const opt = document.createElement('option');
      opt.value = `custom:${p.id}`;
      opt.textContent = t('自定义：{s}', { s: p.name });
      vecProviderSel.appendChild(opt);
    }
  }

  initVectorPanel();
  initImportPanel();
  refreshLLMStatus();
  const btnWikiTest = $('#btnWikiTest');
  if (btnWikiTest) btnWikiTest.onclick = async () => {
    // 立即给出反馈：检测最长可花数秒（健康检查+项目列表串行请求），期间显示检测中并禁用按钮
    const el = $('#wikiStatusText');
    if (el) { el.textContent = t('正在检测 LLM Wiki…'); el.className = 'llm-status is-checking'; }
    btnWikiTest.disabled = true;
    try { await refreshWikiStatus(); } finally { btnWikiTest.disabled = false; }
  };
  refreshWikiStatus();
}

// ===================== 🧠 向量化语义搜索面板 =====================
const VECTOR_ACTIVE_PHASES = ['starting', 'scanning', 'embedding', 'saving', 'incremental'];
let vecPanelToken = 0;
let vecPollAbort = false;
// 待索引目录列表（vault 内相对路径；空数组 = 整个 vault）。
// 选择会即时写入 localStorage：设置保存/视图重渲染/刷新页面都不会丢
let vecRoots = [];
const VEC_ROOTS_KEY = 'vaultdesk-vec-roots';

function saveVecRootsPref() {
  try { localStorage.setItem(VEC_ROOTS_KEY, JSON.stringify(vecRoots)); } catch { /* 隐私模式等场景忽略 */ }
}

function loadVecRootsPref() {
  try {
    const raw = localStorage.getItem(VEC_ROOTS_KEY);
    if (raw === null) return null;
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((r) => typeof r === 'string' && r.trim()) : null;
  } catch { return null; }
}

function renderVecRootChips() {
  const host = $('#vecRootChips');
  if (!host) return;
  if (!vecRoots.length) {
    host.innerHTML = `<span class="vec-root-chip is-all">${t('整个 vault')}</span>`;
    return;
  }
  host.innerHTML = vecRoots.map((r, i) =>
    `<span class="vec-root-chip">${escapeHTML(r)}<button type="button" class="vec-root-chip-x" data-i="${i}" title="${t('移除')}" aria-label="${t('移除')}">×</button></span>`
  ).join('');
  host.querySelectorAll('.vec-root-chip-x').forEach((btn) => {
    btn.onclick = () => { vecRoots.splice(Number(btn.dataset.i), 1); saveVecRootsPref(); renderVecRootChips(); };
  });
}

function addVecRoot(raw) {
  const rel = String(raw || '').trim().replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  if (rel && !vecRoots.includes(rel)) vecRoots.push(rel);
  saveVecRootsPref();
  renderVecRootChips();
}

function collectFolderPaths(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.path) out.push(node.path);
    if (node.children?.length) collectFolderPaths(node.children, out);
  }
  return out;
}

function vecPhaseLabel(phase) {
  const map = {
    starting: t('正在启动'),
    scanning: t('正在扫描目录'),
    embedding: t('正在生成向量'),
    saving: t('正在保存索引'),
    incremental: t('增量更新中'),
    done: t('已完成'),
    stopped: t('已停止'),
    error: t('出错'),
    idle: t('空闲')
  };
  return map[phase] || phase || t('空闲');
}

async function refreshVectorStatusOnce() {
  try { return await api('/api/vector/status'); } catch { return null; }
}

function renderVectorStatus(payload) {
  const summary = $('#vecSummaryText');
  if (!summary) return null; // 面板已被重新渲染
  const wrap = $('#vecProgressWrap');
  const fill = $('#vecProgressFill');
  const statusText = $('#vecStatusText');
  const errBox = $('#vecError');
  const btnStart = $('#btnVecStart');
  const btnStop = $('#btnVecStop');

  if (!payload) {
    summary.textContent = t('状态读取失败');
    return payload;
  }
  const s = payload.status || {};
  const active = VECTOR_ACTIVE_PHASES.includes(s.phase);
  if (payload.config && payload.chunks > 0) {
    const cfgRoots = payload.config.roots || [];
    const rootsLabel = cfgRoots.length > 1
      ? t('{n} 个目录', { n: cfgRoots.length })
      : (cfgRoots[0] || t('整个 vault'));
    summary.textContent = t('已索引 {f} 个文件 · {c} 块 · {r} · 模型 {m}{w}', { f: payload.files, c: payload.chunks, r: rootsLabel, m: `${payload.config.provider}/${payload.config.model}`, w: payload.watching ? ` · ${t('目录监控中')}` : '' });
  } else if (active) {
    summary.textContent = `${t('索引进行中')}：${vecPhaseLabel(s.phase)}`;
  } else {
    summary.textContent = t('未建立索引 —— 选择目录与嵌入模型后开始');
  }
  wrap.hidden = !active && !(s.phase === 'done' && s.filesTotal > 0);
  if (fill) {
    const pct = s.filesTotal > 0 ? Math.min(100, Math.round((s.filesDone / s.filesTotal) * 100)) : (active ? 5 : 100);
    fill.style.width = `${pct}%`;
  }
  if (statusText) {
    statusText.textContent = active
      ? t('{phase} · 文件 {d}/{tot} · 本轮生成 {c} 块{cur}', { phase: vecPhaseLabel(s.phase), d: s.filesDone, tot: s.filesTotal, c: s.chunksDone, cur: s.currentFile ? ` · ${t('当前')}: ${s.currentFile}` : '' })
      : (s.error ? '' : (s.phase === 'stopped'
        ? t('已停止：任务已中止，已嵌入的内容已保存。重新点「开始向量化」可从上次进度继续。')
        : (s.phase === 'done'
          ? t('完成：共 {f} 个文件 / {c} 块', { f: payload.files, c: payload.chunks }) + ((s.skipped && s.skipped.length) ? t('（{k} 个文件嵌入失败已跳过）', { k: s.skipped.length }) : '')
          : '')));
  }
  if (errBox) {
    if (s.error) {
      errBox.hidden = false;
      errBox.textContent = s.error;
    } else if (!active && s.skipped && s.skipped.length) {
      errBox.hidden = false;
      const lines = s.skipped.slice(0, 5).map((k) => `${k.rel}：${k.error}`);
      errBox.textContent = `${t('以下 {n} 个文件嵌入失败已跳过（不影响其它文件的检索）：', { n: s.skipped.length })}\n${lines.join('\n')}${s.skipped.length > 5 ? '\n…' : ''}`;
    } else {
      errBox.hidden = true;
      errBox.textContent = '';
    }
  }
  btnStart.disabled = active;
  btnStart.textContent = active ? t('向量化运行中…') : (payload.chunks > 0 ? t('重建索引') : t('开始向量化'));
  btnStop.hidden = !active;
  return payload;
}

async function pollVectorLoop(token) {
  while (!vecPollAbort && token === vecPanelToken && $('#vecStatusText')) {
    const payload = await refreshVectorStatusOnce();
    const rendered = renderVectorStatus(payload);
    const phase = rendered?.status?.phase;
    if (!phase || !VECTOR_ACTIVE_PHASES.includes(phase)) break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  // 结束后再刷新一次终态
  if (token === vecPanelToken && $('#vecStatusText')) {
    renderVectorStatus(await refreshVectorStatusOnce());
    updateChatVectorBadge();
  }
}

async function loadVectorModels(provider, preferred) {
  const input = $('#vecModel');
  const datalist = $('#vecModelOptions');
  if (!input || !datalist) return;
  input.placeholder = t('正在读取嵌入模型…');
  try {
    const data = await api('/api/vector/models');
    const models = (data.models || []).filter(m => m.provider === provider);
    if (!models.length) {
      const hint = provider === 'ollama'
        ? t('未检测到嵌入模型，可手动输入模型 id（Ollama 中执行 ollama pull qwen3-embedding 或 bge-m3）')
        : provider === 'lmstudio'
          ? t('未检测到嵌入模型，可手动输入模型 id（在 LM Studio 加载 embedding 模型）')
          : t('该服务未检测到嵌入模型，可手动输入模型 id');
      datalist.innerHTML = '';
      input.value = '';
      input.placeholder = hint;
      return;
    }
    datalist.innerHTML = models.map(m => `<option value="${escapeHTML(m.id)}">${escapeHTML(m.name)}</option>`).join('');
    input.placeholder = t('可从建议中选择，或直接输入模型 id');
    input.value = (preferred && models.some(m => m.id === preferred)) ? preferred : (models[0]?.id || '');
  } catch (err) {
    datalist.innerHTML = '';
    input.value = '';
    input.placeholder = t('模型列表读取失败：{e}，可手动输入模型 id', { e: err.message });
  }
}

function initVectorPanel() {
  const token = ++vecPanelToken;
  vecPollAbort = false;

  // 目录联想列表
  const datalist = $('#vecRootOptions');
  if (datalist) {
    datalist.innerHTML = ['<option value=""></option>']
      .concat(collectFolderPaths(state.folderTree).map(p => `<option value="${escapeHTML(p)}"></option>`))
      .join('');
  }

  const providerSel = $('#vecProvider');
  if (providerSel) {
    providerSel.onchange = () => loadVectorModels(providerSel.value, '');
  }

  $('#btnVecRootAdd').onclick = () => {
    const input = $('#vecRoot');
    const v = (input?.value || '').trim();
    if (!v) { showToast(t('请先输入或选择一个目录')); return; }
    addVecRoot(v);
    input.value = '';
  };

  $('#btnPickVecRoot').onclick = () => {
    const rootInput = $(`#settingsForm [name="OBSIDIAN_VAULT_ROOT"]`);
    const vaultRoot = String((rootInput && rootInput.value.trim()) || (state.settings && state.settings.effective?.OBSIDIAN_VAULT_ROOT) || '').replace(/\/+$/, '');
    if (!vaultRoot) { showToast(t('请先设置 Vault 根目录')); return; }
    openDirPicker({
      initial: vaultRoot,
      onPick: (p) => {
        // 以 Vault 根目录输入框当前值为基准换算相对路径（允许尚未重启的新根目录）
        if (p === vaultRoot) { vecRoots = []; saveVecRootsPref(); renderVecRootChips(); return; }
        if (!p.startsWith(`${vaultRoot}/`)) { showToast(t('路径需要位于 vault 内，请重新选择')); return; }
        addVecRoot(p.slice(vaultRoot.length + 1).replace(/^[/\\]/, ''));
      }
    });
  };

  $('#btnVecStart').onclick = async () => {
    const errBox = $('#vecError');
    errBox.hidden = true;
    const model = ($('#vecModel')?.value || '').trim();
    if (!model) { errBox.textContent = t('请先选择或输入一个嵌入模型'); errBox.hidden = false; return; }
    try {
      const r = await postApi('/api/vector/index', { roots: vecRoots.slice(), provider: providerSel.value, model });
      if (r.ok === false) throw new Error(r.error || t('启动失败'));
      showToast(t('向量化任务已启动，完成后知识问答将自动启用语义检索'));
      pollVectorLoop(token);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  };

  $('#btnVecStop').onclick = async () => {
    try { await postApi('/api/vector/stop', {}); showToast(t('已发送停止指令')); } catch {}
  };

  $('#btnVecClear').onclick = async () => {
    if (!confirm(t('确定清空向量索引？语义检索将退回关键词模式。'))) return;
    try {
      const r = await postApi('/api/vector/clear', {});
      if (r.ok === false) throw new Error(r.error || t('清空失败'));
      showToast(t('向量索引已清空'));
      renderVectorStatus(await refreshVectorStatusOnce());
      updateChatVectorBadge();
    } catch (err) {
      const errBox = $('#vecError');
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  };

  refreshVectorStatusOnce().then(payload => {
    if (token !== vecPanelToken || !$('#vecStatusText')) return;
    renderVectorStatus(payload);
    // 目录选择优先取本机保存的（用户最近一次意图，含「清空 = 整个 vault」）；
    // 从未选过才用已建索引的目录做初始展示
    const stored = loadVecRootsPref();
    vecRoots = stored !== null ? stored : (payload?.config?.roots || []).filter(r => r !== '');
    saveVecRootsPref();
    renderVecRootChips();
    if (payload?.config?.provider) {
      providerSel.value = payload.config.provider;
      loadVectorModels(payload.config.provider, payload.config.model);
    } else if (providerSel) {
      loadVectorModels(providerSel.value, '');
    }
    const phase = payload?.status?.phase;
    if (phase && VECTOR_ACTIVE_PHASES.includes(phase)) pollVectorLoop(token);
  });
}
// ===================== 📥 文档导入面板 =====================
let importPanelToken = 0;

function importSourceCardHtml(s, running) {
  const isActive = !!(running && running.sourceId === s.id);
  const last = s.lastRun;
  const lastText = last
    ? ` · ${t('上次：{n} 文件（转 {ok}/跳 {sk}/败 {f}）· {time}', { n: last.total || 0, ok: last.ok || 0, sk: last.skipped || 0, f: last.failed || 0, time: new Date(last.at).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) })}`
    : '';
  return `<div class="import-source-card">
    <div class="import-source-head">📁 ${escapeHTML(s.dir)} <span class="import-source-arrow">→</span> ${escapeHTML(s.target || t('vault 根目录'))}</div>
    <div class="import-source-meta">${s.watch ? t('监控中 · 每 {n} 分钟', { n: Math.max(1, Math.round((s.interval || 300) / 60)) }) : t('未监控')} · ${t('已导入 {n} 个文件', { n: s.indexed || 0 })}${s.broken ? ` · ${t('{n} 个失败', { n: s.broken })}` : ''}${lastText}</div>
    <div class="import-source-actions">
      <button type="button" class="btn btn-primary" data-import-run="${s.id}" ${running ? 'disabled' : ''}>${t('立即导入')}</button>
      ${isActive ? `<button type="button" class="btn btn-secondary" id="btnImportStop">${t('停止')}</button>` : ''}
      <button type="button" class="btn btn-secondary" data-import-watch="${s.id}" data-watch-on="${s.watch ? '1' : ''}">${s.watch ? t('停止监控') : t('开启监控')}</button>
      <button type="button" class="btn btn-secondary" data-import-remove="${s.id}">${t('删除')}</button>
    </div>
  </div>`;
}

function renderImportPanel(data) {
  const pyEl = $('#importPyStatus');
  if (pyEl) {
    if (!data.python || !data.python.path) {
      pyEl.textContent = t('未检测到 Python —— 仅能导入 .md/.txt/.csv');
      pyEl.className = 'llm-status is-off';
    } else if (data.python.anydoc) {
      pyEl.textContent = t('可用 · anydoc 已安装（{p}）', { p: data.python.path });
      pyEl.className = 'llm-status is-ok';
    } else {
      pyEl.textContent = t('Python 可用但未安装 anydoc —— 仅能导入 .md/.txt/.csv');
      pyEl.className = 'llm-status is-off';
    }
  }
  const summary = $('#importSummaryText');
  const running = data.running;
  if (summary) {
    summary.textContent = running
      ? t('导入进行中：{phase}', { phase: running.phase === 'scanning' ? t('正在扫描文件夹') : `${running.filesDone}/${running.filesTotal}` })
      : (data.sources.length ? t('已配置 {n} 个导入源', { n: data.sources.length }) : t('未配置导入源'));
  }
  const wrap = $('#importProgressWrap');
  const fill = $('#importProgressFill');
  const text = $('#importProgressText');
  if (wrap) wrap.hidden = !running;
  if (running && fill) {
    const pct = running.filesTotal > 0 ? Math.min(100, Math.round((running.filesDone / running.filesTotal) * 100)) : 5;
    fill.style.width = `${pct}%`;
    if (text) text.textContent = t('文件 {d}/{tot} · 转换 {c} · 跳过 {sk} · 失败 {f}{cur}', { d: running.filesDone, tot: running.filesTotal, c: running.converted, sk: running.skipped, f: running.failed, cur: running.currentFile ? ` · ${t('当前')}: ${running.currentFile}` : '' });
  }
  const errBox = $('#importError');
  if (errBox) {
    const errs = running ? (running.errors || []) : [];
    if (running && running.phase === 'stopped') {
      errBox.hidden = false;
      errBox.textContent = t('导入已停止：已转换的文件已保存。');
    } else if (errs.length) {
      errBox.hidden = false;
      errBox.textContent = `${t('{n} 个文件转换失败：', { n: running ? running.failed : errs.length })}\n` + errs.slice(0, 5).map((e) => `${e.rel}：${e.error}`).join('\n') + (errs.length > 5 ? '\n…' : '');
    } else {
      errBox.hidden = true;
      errBox.textContent = '';
    }
  }
  const list = $('#importSourcesList');
  if (list) {
    list.innerHTML = data.sources.length
      ? data.sources.map((s) => importSourceCardHtml(s, running)).join('')
      : `<div class="import-source-empty">${t('还没有导入源——在下方添加一个文件夹开始导入。')}</div>`;
    list.querySelectorAll('[data-import-run]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          const r = await postApi('/api/doc-import/run', { id: btn.dataset.importRun });
          if (r.ok === false) throw new Error(r.error || t('启动失败'));
          showToast(t('导入任务已启动'));
          pollImportLoop(importPanelToken);
        } catch (err) { showToast(err.message); }
      };
    });
    const stopBtn = $('#btnImportStop');
    if (stopBtn) stopBtn.onclick = async () => {
      try { await postApi('/api/doc-import/stop', {}); showToast(t('已发送停止指令')); } catch {}
    };
    list.querySelectorAll('[data-import-watch]').forEach((btn) => {
      btn.onclick = async () => {
        const on = !btn.dataset.watchOn;
        try {
          const r = await postApi('/api/doc-import/sources', { action: 'update', source: { id: btn.dataset.importWatch, watch: on } });
          if (r.ok === false) throw new Error(r.error || t('更新失败'));
          await reloadImportPanel();
        } catch (err) { showToast(err.message); }
      };
    });
    list.querySelectorAll('[data-import-remove]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(t('删除该导入源？只移除导入关系与记录，已导入 vault 的笔记文件会保留。'))) return;
        try {
          const r = await postApi('/api/doc-import/sources', { action: 'remove', source: { id: btn.dataset.importRemove } });
          if (r.ok === false) throw new Error(r.error || t('删除失败'));
          await reloadImportPanel();
        } catch (err) { showToast(err.message); }
      };
    });
  }
}

async function reloadImportPanel() {
  try {
    const data = await api('/api/doc-import');
    if (!$('#importSourcesList')) return null; // 面板已被重新渲染
    renderImportPanel(data);
    return data;
  } catch { return null; }
}

async function pollImportLoop(token) {
  while (token === importPanelToken && $('#importSourcesList')) {
    const data = await reloadImportPanel();
    if (!data || !data.running) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (token === importPanelToken && $('#importSourcesList')) await reloadImportPanel();
}

function initImportPanel() {
  const token = ++importPanelToken;

  const pickSrc = $('#btnPickImportSrc');
  if (pickSrc) pickSrc.onclick = () => {
    openDirPicker({
      initial: '',
      onPick: (p) => { const inp = $('#importSrcDir'); if (inp) inp.value = p; }
    });
  };
  const pickTarget = $('#btnPickImportTarget');
  if (pickTarget) pickTarget.onclick = () => {
    const rootInput = $(`#settingsForm [name="OBSIDIAN_VAULT_ROOT"]`);
    const vaultRoot = String((rootInput && rootInput.value.trim()) || (state.settings && state.settings.effective?.OBSIDIAN_VAULT_ROOT) || '').replace(/\/+$/, '');
    if (!vaultRoot) { showToast(t('请先设置 Vault 根目录')); return; }
    openDirPicker({
      initial: vaultRoot,
      onPick: (p) => {
        const inp = $('#importTargetDir');
        if (!inp) return;
        if (p === vaultRoot) { inp.value = ''; return; }
        if (!p.startsWith(`${vaultRoot}/`)) { showToast(t('路径需要位于 vault 内，请重新选择')); return; }
        inp.value = p.slice(vaultRoot.length + 1).replace(/^[/\\]/, '');
      }
    });
  };

  const addBtn = $('#btnImportAdd');
  if (addBtn) addBtn.onclick = async () => {
    const dir = ($('#importSrcDir')?.value || '').trim();
    const target = ($('#importTargetDir')?.value || '').trim().replace(/^\/+|\/+$/g, '');
    if (!dir) { showToast(t('请填写或选择源文件夹')); return; }
    try {
      const r = await postApi('/api/doc-import/sources', {
        action: 'add',
        source: { dir, target, watch: !!$('#importWatch')?.checked, interval: Number($('#importInterval')?.value || 300) }
      });
      if (r.ok === false) throw new Error(r.error || t('添加失败'));
      showToast(t('导入源已添加'));
      const src = $('#importSrcDir'); if (src) src.value = '';
      const tg = $('#importTargetDir'); if (tg) tg.value = '';
      const w = $('#importWatch'); if (w) w.checked = false;
      await reloadImportPanel();
    } catch (err) { showToast(err.message); }
  };

  const pyBtn = $('#btnImportPyRefresh');
  if (pyBtn) pyBtn.onclick = async () => {
    const el = $('#importPyStatus');
    if (el) { el.textContent = t('正在检测…'); el.className = 'llm-status is-checking'; }
    try {
      const data = await api('/api/doc-import?refresh=1');
      if ($('#importSourcesList')) renderImportPanel(data);
    } catch { /* 保持现状 */ }
  };

  reloadImportPanel().then((data) => {
    if (token !== importPanelToken || !$('#importSourcesList')) return;
    if (data && data.running) pollImportLoop(token);
  });
}

async function updateChatVectorBadge() {
  const host = document.querySelector('.chat-header-left');
  if (!host) return;
  let badge = $('#chatVectorBadge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'chatVectorBadge';
    badge.className = 'chat-vector-badge';
    host.appendChild(badge);
  }
  try {
    const s = await api('/api/vector/status');
    if (!s.config || !s.chunks) {
      badge.textContent = t('🧠 语义检索未启用（可在设置中向量化目录）');
      badge.classList.add('is-off');
    } else {
      badge.textContent = t('🧠 语义检索 · {f} 文件 / {c} 块 · {m}{w}{q}', {
        f: s.files,
        c: s.chunks,
        m: s.config.model,
        w: s.watching ? ` · ${t('监控中')}` : '',
        q: s.qdrant && s.qdrant.configured ? (s.qdrant.ok ? ' · Qdrant ✓' : ' · Qdrant ✗') : ''
      });
      badge.classList.remove('is-off');
    }
  } catch {
    badge.textContent = t('🧠 语义检索不可用');
    badge.classList.add('is-off');
  }
}

// ==========================================================================
// 应用内浏览历史：顶栏 ←/→ 返回/前进上一个浏览页
// 记录粒度 = 浏览“页面”（主视图 + 笔记子视图/文件夹 + 日记日期）
// ==========================================================================
const navBackStack = [];
const navForwardStack = [];
let navCurrentLoc = null; // 最近一次已提交的浏览位置（回退时作为“当前页”压入前进栈）

function currentLoc() {
  return {
    mainView: state.mainView,
    view: state.view || '',
    folder: state.folder || '',
    dailyDate: state.dailyDate || '',
  };
}

function sameLoc(a, b) {
  return !!a && !!b &&
    a.mainView === b.mainView && a.view === b.view &&
    a.folder === b.folder && a.dailyDate === b.dailyDate;
}

// 用户完成一次页面跳转后调用：prevLoc 为跳转前位置；若页面确实变了则压入返回栈并清空前向栈
function recordNav(prevLoc) {
  const next = currentLoc();
  if (sameLoc(prevLoc, next)) return;
  navBackStack.push(prevLoc);
  navForwardStack.length = 0;
  navCurrentLoc = next;
  updateNavButtons();
}

// 恢复到历史位置（不产生新记录）
function applyNavLoc(loc) {
  state.mainView = loc.mainView;
  if (loc.mainView === 'daily') {
    state.dailyDate = loc.dailyDate;
    $('#sideDailyDate').value = loc.dailyDate;
  } else if (loc.mainView === 'notes') {
    state.view = loc.view;
    state.folder = loc.folder;
  }
  switchMainView(loc.mainView);
}

function goNavBack() {
  if (!navBackStack.length) return;
  navForwardStack.push(navCurrentLoc);
  const loc = navBackStack.pop();
  navCurrentLoc = loc;
  applyNavLoc(loc);
  updateNavButtons();
}

function goNavForward() {
  if (!navForwardStack.length) return;
  navBackStack.push(navCurrentLoc);
  const loc = navForwardStack.pop();
  navCurrentLoc = loc;
  applyNavLoc(loc);
  updateNavButtons();
}

function updateNavButtons() {
  const back = $('#btnNavBack');
  const fwd = $('#btnNavForward');
  if (back) back.disabled = navBackStack.length === 0;
  if (fwd) fwd.disabled = navForwardStack.length === 0;
}

function switchMainView(targetView) {
  const fromSettings = state.mainView === 'settings';
  state.mainView = targetView;
  // 移动端/竖屏：切换视图后自动收起侧栏抽屉
  if (window.innerWidth <= 1024) setDrawer(false);

  // Toggle Panes
  $('#paneDaily').classList.toggle('active', targetView === 'daily');
  $('#paneTasks').classList.toggle('active', targetView === 'tasks');
  $('#paneNotes').classList.toggle('active', targetView === 'notes');
  const paneChat = $('#paneChat');
  if (paneChat) paneChat.classList.toggle('active', targetView === 'chat');
  const paneFeeds = $('#paneFeeds');
  if (paneFeeds) paneFeeds.classList.toggle('active', targetView === 'feeds');
  const paneSettings = $('#paneSettings');
  if (paneSettings) paneSettings.classList.toggle('active', targetView === 'settings');

  // Sync Sidebar Active Nav
  $$('.nav-item').forEach((nav) => nav.classList.remove('active'));
  if (targetView === 'daily') {
    $('#navDaily').classList.add('active');
    openDaily(state.dailyDate || today());
  } else if (targetView === 'tasks') {
    $('#navTasks').classList.add('active');
    renderTasksView();
  } else if (targetView === 'notes') {
    if (state.view === 'drafts' && $('#navDrafts')) $('#navDrafts').classList.add('active');
    else $('#navAll').classList.add('active');
    renderNotesView();
    renderFolderTree();
  } else if (targetView === 'chat') {
    $('#navChat')?.classList.add('active');
    $('#crumbSection').textContent = t('知识问答');
    $('#crumbTarget').textContent = t('RAG 智能对话');
    loadChatModels({ force: fromSettings }); // 同步最新的默认模型与自定义服务模型（刚从设置页回来时强制刷新）
    renderChatView();
    updateChatVectorBadge();
  } else if (targetView === 'feeds') {
    $('#navFeeds')?.classList.add('active');
    renderFeedsView();
    if (!state.feeds.articles.length) refreshFeeds(false);
  } else if (targetView === 'settings') {
    $('#navSettings')?.classList.add('active');
    renderSettingsView();
  }
}

// ==========================================================================
// VIEW 4: 💬 KNOWLEDGE BASE CHAT & RAG (知识库智能问答)
// ==========================================================================
let chatModelsFetchedAt = 0;

function chatModelDisplayName(id) {
  const m = (state.availableLLMs || []).find((x) => x.id === id);
  return m ? m.name : id;
}

// 拉取模型列表并同步输入框显示。30 秒 TTL：设置里改了默认模型/新增自定义服务后，
// 切回问答视图即可看到最新结果；用户手动选过的模型不被覆盖（除非它已失效）
async function loadChatModels({ force = false } = {}) {
  if (!force && chatModelsFetchedAt && Date.now() - chatModelsFetchedAt < 30000 && state.availableLLMs.length) return;
  let data;
  try {
    data = await api('/api/llm/models');
  } catch (e) {
    console.error('Failed to load LLM models:', e);
    const modelInput = $('#chatModelInput');
    if (modelInput && !state.availableLLMs.length) {
      modelInput.value = '';
      modelInput.placeholder = t('模型列表读取失败');
    }
    return;
  }
  chatModelsFetchedAt = Date.now();
  state.availableLLMs = data.models || [];
  const modelInput = $('#chatModelInput');
  if (!modelInput) return;
  if (!state.availableLLMs.length) {
    modelInput.value = '';
    modelInput.placeholder = t('未检测到大模型服务（LM Studio / Ollama / DeepSeek）');
    return;
  }
  modelInput.placeholder = t('点击选择或输入名称过滤');
  const current = state.selectedModel;
  const stillValid = current && state.availableLLMs.some((m) => m.id === current);
  const followDefault = state.chatModelIsDefault !== false; // 未手动改过时跟随默认模型
  if (!current || followDefault || !stillValid) {
    const def = (data.defaultModel && state.availableLLMs.some((m) => m.id === data.defaultModel))
      ? data.defaultModel
      : state.availableLLMs[0].id;
    state.selectedModel = def;
    state.chatModelIsDefault = true;
    modelInput.value = chatModelDisplayName(def);
  } else {
    modelInput.value = chatModelDisplayName(current);
  }
}

function renderChatModelDropdown() {
  const dd = $('#chatModelDropdown');
  const input = $('#chatModelInput');
  if (!dd || !input) return;
  // 只有用户真正键入后才按输入过滤；聚焦时显示全部模型
  const q = (input.dataset.typed ? input.value : '').trim().toLowerCase();
  const focused = document.activeElement === input;
  const list = (state.availableLLMs || []).filter((m) =>
    !focused || !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  if (!list.length || !focused) { dd.hidden = true; return; }
  dd.innerHTML = list.map((m) =>
    `<div class="chat-model-option${m.id === state.selectedModel ? ' is-selected' : ''}" data-model-id="${escapeHTML(m.id)}">${escapeHTML(m.name)}</div>`
  ).join('');
  dd.hidden = false;
  dd.querySelectorAll('.chat-model-option').forEach((el) => {
    el.onmousedown = (e) => {
      e.preventDefault(); // 先于 input 失焦生效
      const id = el.dataset.modelId;
      state.selectedModel = id;
      state.chatModelIsDefault = false;
      input.value = chatModelDisplayName(id);
      input.dataset.typed = '';
      dd.hidden = true;
    };
  });
}

async function initChatModule() {
  await loadChatModels({ force: true });
  const modelInput = $('#chatModelInput');
  if (modelInput) {
    modelInput.onfocus = () => {
      modelInput.dataset.typed = ''; // 聚焦即展示全部，输入才开始过滤
      renderChatModelDropdown();
      setTimeout(() => { try { modelInput.select(); } catch { /* 忽略 */ } }, 0);
    };
    modelInput.oninput = (e) => {
      modelInput.dataset.typed = '1';
      const text = e.target.value.trim();
      // 与已知模型名称或 id 完全一致视为选中；否则按手动输入的模型 id 处理
      const hit = state.availableLLMs.find((m) => m.id === text || m.name === text);
      if (hit) { state.selectedModel = hit.id; state.chatModelIsDefault = false; }
      else state.selectedModel = text;
      renderChatModelDropdown();
    };
    document.addEventListener('mousedown', (e) => {
      const dd = $('#chatModelDropdown');
      if (dd && !dd.hidden && !dd.contains(e.target) && e.target !== modelInput) dd.hidden = true;
    });
  }

  const scopeSelect = $('#chatScopeSelect');
  if (scopeSelect) {
    scopeSelect.onchange = (e) => {
      state.selectedScope = e.target.value;
    };
  }

  const clearBtn = $('#btnClearChat');
  if (clearBtn) {
    clearBtn.onclick = () => {
      if (state.chatHistory.length && !confirm(t('确定要清空当前对话记录吗？'))) return;
      state.chatHistory = [];
      renderChatView();
    };
  }

  const form = $('#chatInputForm');
  const input = $('#chatInputText');
  if (form && input) {
    form.onsubmit = (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q || state.chatLoading || state.chatAbort) return;
      input.value = '';
      input.style.height = 'auto';
      sendChatMessage(q);
    };

    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    };

    input.oninput = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    };
  }

  // Suggestion pills
  $$('.sug-pill').forEach((pill) => {
    pill.onclick = () => {
      const prompt = pill.dataset.prompt;
      if (prompt && input) {
        input.value = prompt;
        form.requestSubmit();
      }
    };
  });
}

function renderChatView() {
  const container = $('#chatMessages');
  if (!container) return;

  if (state.chatHistory.length === 0 && !state.chatLoading) {
    container.innerHTML = `
      <div class="chat-welcome-state">
        <div class="chat-welcome-icon">◈</div>
        <h3>${t('基于知识库的智能对话助手')}</h3>
        <p>${t('提问后系统会先在本地 Markdown vault 中检索相关素材，再由大模型基于真实内容进行总结与解答，支持连续追问与来源溯源。')}</p>
        <div class="chat-quick-cards">
          <div class="quick-prompt-card" data-prompt="总结最近一周的重点笔记">
            <strong>${t('📋 周重点总结')}</strong>
            <span>${t('检索近期笔记并整理主要事项、结论和后续动作')}</span>
          </div>
          <div class="quick-prompt-card" data-prompt="列出最近需要跟进的待办事项">
            <strong>${t('✅ 待办跟进')}</strong>
            <span>${t('从知识库中提取近期任务、截止日期和未完成事项')}</span>
          </div>
          <div class="quick-prompt-card" data-prompt="根据当前知识库整理一个主题索引">
            <strong>${t('🧭 主题索引')}</strong>
            <span>${t('按主题聚合相关笔记，生成可继续扩展的索引')}</span>
          </div>
        </div>
      </div>
    `;

    container.querySelectorAll('.quick-prompt-card').forEach((card) => {
      card.onclick = () => {
        const prompt = card.dataset.prompt;
        if (prompt) sendChatMessage(prompt);
      };
    });
    return;
  }

  let html = '';
  state.chatHistory.forEach((msg, idx) => {
    if (msg.role === 'user') {
      html += `
        <div class="chat-msg-row user-row">
          <div class="chat-bubble">
            <p>${escapeHTML(msg.content).replace(/\n/g, '<br>')}</p>
          </div>
          <div class="chat-avatar">${t('我')}</div>
        </div>
      `;
    } else {
      // Assistant Message
      let sourcesWidget = '';
      if (msg.sources && msg.sources.length) {
        // 耗时标注：让「慢在哪」可见——检索含嵌入+向量扫描，生成是对话模型耗时（通常远大于检索）
        let timingLabel = '';
        if (msg.timings) {
          const parts = [];
          if (msg.timings.searchMs != null) parts.push(t('检索 {s} 秒', { s: (msg.timings.searchMs / 1000).toFixed(1) }));
          if (msg.timings.llmMs != null) parts.push(t('生成 {s} 秒', { s: (msg.timings.llmMs / 1000).toFixed(1) }));
          if (parts.length) timingLabel = ` · ${parts.join(' · ')}`;
        }
        sourcesWidget = `
          <details class="chat-sources-widget">
            <summary class="chat-sources-summary">
              <span>${t('🔍 知识库检索素材 ({n} 篇参考依据)', { n: msg.sources.length })}${timingLabel}</span>
              <span>▾</span>
            </summary>
            <div class="chat-sources-list">
              ${msg.sources.map((s) => `
                <div class="chat-source-item">
                  <div class="chat-source-item-head">
                    <a href="javascript:void(0)" class="chat-source-link" data-path="${escapeHTML(s.path)}">
                      ${s.scope === 'llm-wiki' ? '🌐' : '📄'} ${escapeHTML(s.title || s.path)}
                    </a>
                    <span class="chat-source-score">${t('匹配分: {s} · 行: {l}', { s: s.score, l: s.line })}</span>
                  </div>
                  <div class="chat-source-excerpt">${escapeHTML(s.excerpt || s.preview || '')}</div>
                </div>
              `).join('')}
            </div>
          </details>
        `;
      }

      html += `
        <div class="chat-msg-row assistant-row">
          <div class="chat-avatar">AI</div>
          <div class="chat-bubble">
            <div class="chat-answer-body markdown"${msg.streaming ? ' id="chatStreamBody"' : ''}>${markdown(msg.content)}</div>
            ${sourcesWidget}
            ${msg.streaming ? `<div class="chat-msg-actions"><button class="chat-action-btn" id="btnStopChat">${t('■ 停止生成')}</button></div>` : `
            <div class="chat-msg-actions">
              <button class="chat-action-btn btn-copy-chat" data-chat-idx="${idx}">${t('📋 复制回答')}</button>
              <button class="chat-action-btn btn-save-chat" data-chat-idx="${idx}">${t('💾 保存为 Wiki 笔记')}</button>
            </div>`}
          </div>
        </div>
      `;
    }
  });

  if (state.chatLoading) {
    html += `
      <div class="chat-msg-row assistant-row">
        <div class="chat-avatar">AI</div>
        <div class="chat-bubble">
          <div class="chat-loading-bubble">
            <div class="chat-spinner"></div>
            <span>${t('正在知识库中 RAG 检索相关素材并深入思考中...')}</span>
            <button class="chat-action-btn" id="btnStopChat">${t('■ 停止生成')}</button>
          </div>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;

  // Bind Stop button (loading / streaming phase)
  const stopBtn = $('#btnStopChat');
  if (stopBtn) {
    stopBtn.onclick = () => {
      if (state.chatAbort) state.chatAbort.abort();
    };
  }

  // Bind Source links to open Note Reader
  container.querySelectorAll('.chat-source-link').forEach((link) => {
    link.onclick = (e) => {
      e.preventDefault();
      const targetPath = link.dataset.path;
      if (targetPath) {
        const from = currentLoc();
        switchMainView('notes');
        openNote({ path: targetPath, title: targetPath.split('/').pop().replace(/\.md$/i, '') });
        recordNav(from);
      }
    };
  });

  // Bind Action buttons
  container.querySelectorAll('.btn-copy-chat').forEach((btn) => {
    btn.onclick = () => {
      const idx = Number(btn.dataset.chatIdx);
      const msg = state.chatHistory[idx];
      if (msg) {
        navigator.clipboard.writeText(msg.content).then(() => showToast(t('回答内容已复制到剪贴板')));
      }
    };
  });

  container.querySelectorAll('.btn-save-chat').forEach((btn) => {
    btn.onclick = async () => {
      const idx = Number(btn.dataset.chatIdx);
      const msg = state.chatHistory[idx];
      const prevUserMsg = state.chatHistory.slice(0, idx).reverse().find((m) => m.role === 'user');
      const question = prevUserMsg ? prevUserMsg.content : t('知识库问答');
      if (!msg) return;

      btn.disabled = true;
      btn.textContent = t('保存中...');
      try {
        const res = await fetch('/api/chat/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            answer: msg.content,
            sources: msg.sources || [],
            model: state.selectedModel
          })
        }).then((r) => r.json());

        if (res.ok) {
          showToast(t('已成功保存为 Wiki 笔记'));
          btn.textContent = t('✓ 已保存');
        } else {
          showToast(res.error || t('保存失败'));
          btn.disabled = false;
          btn.textContent = t('💾 保存为 Wiki 笔记');
        }
      } catch (e) {
        showToast(e.message);
        btn.disabled = false;
        btn.textContent = t('💾 保存为 Wiki 笔记');
      }
    };
  });
}

// 解析 SSE 响应流 → 逐事件产出 { event, data }
async function* chatSSEEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      yield { event, data: parsed };
    }
  }
}

async function sendChatMessage(question) {
  if (!question || state.chatLoading || state.chatAbort) return;

  // Add user message
  state.chatHistory.push({
    role: 'user',
    content: question,
    timestamp: Date.now()
  });

  state.chatLoading = true;
  renderChatView();

  // Format history for backend
  const history = state.chatHistory.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.content
  }));

  const model = state.selectedModel || 'deepseek-chat';
  const path_prefix = state.selectedScope || '';

  const sendBtn = $('#btnSendChat');
  if (sendBtn) sendBtn.disabled = true;

  const controller = new AbortController();
  state.chatAbort = controller;
  // 流式阶段挂在历史中的那条消息（收到 meta 事件后才入列并逐字填充）
  let pending = null;

  const finalize = (stopped) => {
    if (pending) {
      pending.streaming = false;
      if (stopped && pending.content) pending.content += `\n\n_${t('（已停止）')}_`;
      if (!pending.errorText && !pending.content.trim()) {
        pending.content = t('⚠️ 模型未返回有效回答（素材已检索到，见下方来源）。请检查所选模型服务是否正常，或换一个模型重试。');
      }
      if (pending.errorText && !pending.content.trim()) {
        pending.content = `${t('⚠️ **问答失败**')}: ${pending.errorText}`;
      }
    }
    state.chatAbort = null;
  };

  const paintStream = (force) => {
    if (!pending || !pending.streaming) return;
    if (!force && Date.now() - (pending._lastPaint || 0) < 80) return;
    pending._lastPaint = Date.now();
    const el = $('#chatStreamBody');
    if (el) el.innerHTML = markdown(pending.content);
    const container = $('#chatMessages');
    if (container) container.scrollTop = container.scrollHeight;
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history, model, path_prefix, limit: 5, stream: true }),
      signal: controller.signal
    });
    const ctype = res.headers.get('content-type') || '';

    if (!res.ok || !ctype.includes('text/event-stream')) {
      // 非流式响应：服务端错误（400/500）或旧版服务——按整体 JSON 处理
      const data = await res.json();
      state.chatHistory.push({
        role: 'assistant',
        content: (!res.ok || data.ok === false)
          ? `${t('⚠️ **问答失败**')}: ${data.error || t('无法从模型获取回答')}`
          : (String(data.answer || '').trim() || t('⚠️ 模型未返回有效回答（素材已检索到，见下方来源）。请检查所选模型服务是否正常，或换一个模型重试。')),
        sources: data.sources || [],
        timings: data.timings,
        timestamp: Date.now()
      });
    } else {
      for await (const evt of chatSSEEvents(res)) {
        if (evt.event === 'meta') {
          pending = { role: 'assistant', content: '', sources: evt.data.sources || [], streaming: true, timestamp: Date.now() };
          state.chatHistory.push(pending);
          state.chatLoading = false;
          renderChatView();
        } else if (evt.event === 'delta') {
          pending && (pending.content += evt.data.text || '');
          paintStream();
        } else if (evt.event === 'done') {
          if (pending) {
            pending.content = String(evt.data.answer || '') || pending.content;
            pending.timings = evt.data.timings || null;
          }
        } else if (evt.event === 'error') {
          if (pending) pending.errorText = evt.data.error || '未知错误';
        }
      }
      finalize(false);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      finalize(true);
      if (!pending) {
        state.chatHistory.push({ role: 'assistant', content: t('（已停止）'), sources: [], timestamp: Date.now() });
      }
    } else {
      finalize(false);
      state.chatHistory.push({
        role: 'assistant',
        content: `${t('⚠️ **网络或接口异常**')}: ${err.message}`,
        sources: pending ? pending.sources : [],
        timestamp: Date.now()
      });
    }
  } finally {
    state.chatLoading = false;
    state.chatAbort = null;
    if (sendBtn) sendBtn.disabled = false;
    renderChatView();
  }
}

// ==========================================================================
// INITIALIZATION & BASE DATA
// ==========================================================================
function renderFolderTree() {
  const container = $('#folders');
  if (!container) return;
  const renderNode = (node, depth = 0) => {
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const expanded = state.expandedFolders.has(node.path);
    const selected = state.folder === node.path;
    return `
      <div class="folder-tree-node">
        <div class="folder ${selected ? 'selected' : ''}" data-folder="${escapeHTML(node.path)}" style="--depth:${depth}">
          <button class="folder-toggle ${expanded ? 'is-open' : ''}" data-folder-toggle="${escapeHTML(node.path)}" ${hasChildren ? '' : 'disabled'} title="${hasChildren ? t('展开或收起') : ''}">▸</button>
          <span class="folder-name">${escapeHTML(node.name)}</span>
          <small>${node.count}</small>
        </div>
        ${hasChildren && expanded ? `<div class="folder-children">${node.children.map(child => renderNode(child, depth + 1)).join('')}</div>` : ''}
      </div>
    `;
  };
  container.innerHTML = state.folderTree.length
    ? state.folderTree.map(node => renderNode(node)).join('')
    : `<div class="folder-empty">${t('暂无目录')}</div>`;
}

// 侧栏底部显示 vault 目录名（悬停 title 展示完整路径）；语言切换会重写 data-i18n 文本，需要重设
function updateVaultFootLabel() {
  const el = $('#vaultNameLabel');
  if (!el) return;
  const rootPath = String(state.vaultRoot || '');
  if (rootPath) {
    el.textContent = rootPath.split('/').filter(Boolean).pop() || rootPath;
    el.title = rootPath;
  } else {
    el.textContent = t('Markdown vault');
    el.title = t('Markdown vault');
  }
}

async function loadBase() {
  initTaskModal();
  initNoteModal();
  initDirPicker();
  initChatModule();
  state.dailyDate = today();

  let stats, folderTreeData, dates, taskData;
  try {
    [stats, folderTreeData, dates, taskData] = await Promise.all([
      api('/api/stats'),
      api('/api/folder-tree'),
      api('/api/daily-dates'),
      api('/api/tasks')
    ]);
  } catch (err) {
    // 初始化接口失败（常见于服务重启窗口期刷新页面）：给出可见提示和重试入口，而不是静默瘫痪
    const host = document.querySelector('.main') || document.body;
    host.innerHTML = `<div style="padding:60px 24px;text-align:center;color:var(--muted)">
      <h2 style="margin-bottom:12px">${t('初始化失败')}</h2>
      <p style="margin-bottom:20px">${t('无法读取应用数据：服务可能正在重启或暂时不可用。')}</p>
      <button type="button" class="btn btn-primary" id="btnInitRetry">${t('重试')}</button>
    </div>`;
    const retry = $('#btnInitRetry');
    if (retry) retry.onclick = () => location.reload();
    return;
  }

  $('#allCount').textContent = stats.notes.toLocaleString();
  $('#syncTime').textContent = t('{mb} MB · {n} 目录', { mb: (stats.markdownBytes / 1024 / 1024).toFixed(0), n: folderTreeData.total || 0 });
  state.vaultRoot = String(stats.root || '');
  updateVaultFootLabel();
  state.dates = dates || [];
  state.inboxTasks = taskData.tasks || [];
  state.folderTree = folderTreeData.folders || [];
  updateTaskBadges();
  populateVaultFolderSelects();

  // Render Folder List in Sidebar
  renderFolderTree();

  $('#folders').onclick = (e) => {
    const toggle = e.target.closest('[data-folder-toggle]');
    if (toggle && !toggle.disabled) {
      const folder = toggle.dataset.folderToggle;
      if (state.expandedFolders.has(folder)) state.expandedFolders.delete(folder);
      else state.expandedFolders.add(folder);
      renderFolderTree();
      return;
    }
    const el = e.target.closest('.folder');
    if (el) {
      const from = currentLoc();
      state.folder = el.dataset.folder;
      state.view = 'folder';
      switchMainView('notes');
      renderFolderTree();
      recordNav(from);
    }
  };

  // Sidebar Nav Items Click
  $$('.nav-item').forEach((b) => {
    b.onclick = () => {
      const from = currentLoc();
      const navTarget = b.dataset.nav;
      if (navTarget === 'daily') {
        switchMainView('daily');
      } else if (navTarget === 'tasks') {
        switchMainView('tasks');
      } else if (navTarget === 'chat') {
        switchMainView('chat');
      } else if (navTarget === 'feeds') {
        switchMainView('feeds');
      } else if (navTarget === 'settings') {
        switchMainView('settings');
      } else {
        state.view = navTarget;
        state.folder = '';
        switchMainView('notes');
      }
      recordNav(from);
    };
  });

  // Sidebar Calendar Widget
  $('#sideDailyDate').value = state.dailyDate;
  $('#sideDailyDate').onchange = (e) => {
    const from = currentLoc();
    state.dailyDate = e.target.value;
    switchMainView('daily');
    recordNav(from);
  };
  $('#sideTodayBtn').onclick = () => {
    const from = currentLoc();
    state.dailyDate = today();
    $('#sideDailyDate').value = state.dailyDate;
    switchMainView('daily');
    recordNav(from);
  };

  // Global Search
  $('#search').oninput = (e) => {
    const from = currentLoc();
    state.query = e.target.value;
    state.view = 'all';
    state.folder = '';
    if (state.mainView !== 'notes') {
      switchMainView('notes');
      recordNav(from);
    } else {
      renderNoteList();
    }
  };

  $('#search').onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (state.notes[0]) openNote(state.notes[0]);
    }
  };

  // Top Actions（移动端抽屉）
  $('#menu').onclick = () => setDrawer(!$('#sidebar').classList.contains('open'));
  $('#sidebarBackdrop').onclick = () => setDrawer(false);
  $('#toggleTheme').onclick = () => document.body.classList.toggle('warm');
  $('#toggleFocus').onclick = () => document.body.classList.toggle('focus');

  // 浏览历史 ←/→ 按钮
  $('#btnNavBack').onclick = goNavBack;
  $('#btnNavForward').onclick = goNavForward;
  updateNavButtons();

  // Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#search').focus();
    }
    // 日记视图 ←/→ 翻页（输入框聚焦时不触发）
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && state.mainView === 'daily' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      const base = state.dailyDate || today();
      const d = new Date(`${base}T00:00:00`);
      if (Number.isNaN(d.getTime())) return;
      d.setDate(d.getDate() + (e.key === 'ArrowLeft' ? -1 : 1));
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const from = currentLoc();
      openDaily(iso);
      recordNav(from);
    }
    if (e.key === 'Escape') {
      if (document.body.classList.contains('focus')) {
        document.body.classList.remove('focus');
      }
    }
  });

  // 📡 Feeds 静态控件
  const btnRefreshFeed = $('#btnRefreshFeeds');
  if (btnRefreshFeed) btnRefreshFeed.onclick = async () => { btnRefreshFeed.disabled = true; await refreshFeeds(true); btnRefreshFeed.disabled = false; };
  const btnFeedUnread = $('#btnFeedUnread');
  if (btnFeedUnread) btnFeedUnread.onclick = () => { state.feeds.unreadOnly = !state.feeds.unreadOnly; btnFeedUnread.classList.toggle('active', state.feeds.unreadOnly); renderFeedsView(); };
  const btnFeedAllRead = $('#btnFeedAllRead');
  if (btnFeedAllRead) btnFeedAllRead.onclick = async () => { await postApi('/api/feed/read', { all: true }); await refreshFeeds(false); showToast(t('已全部标记为已读')); };
  const feedAddInput = $('#feedAddInput');
  const btnAddFeed = $('#btnAddFeed');
  const doAddFeed = async () => {
    if (!feedAddInput || !feedAddInput.value.trim()) return;
    try {
      const r = await postApi('/api/feeds/add', { url: feedAddInput.value.trim() });
      if (r.error) { showToast(r.error); return; }
      feedAddInput.value = '';
      showToast(t('已添加 {n}，正在拉取…', { n: r.name }));
      await refreshFeeds(true);
    } catch (e) { showToast(t('添加失败')); }
  };
  if (btnAddFeed) btnAddFeed.onclick = doAddFeed;
  if (feedAddInput) feedAddInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doAddFeed(); } };

  // 预热资讯未读徽标
  refreshFeeds(false);

  // Initial View
  switchMainView('daily');
  navCurrentLoc = currentLoc();
  updateNavButtons();
}

// ========== 新建笔记 Modal & 移动端抽屉 ==========
function setDrawer(open) {
  const sb = $('#sidebar');
  if (!sb) return;
  sb.classList.toggle('open', open);
  const bk = $('#sidebarBackdrop');
  if (bk) bk.classList.toggle('show', open);
}
// ===================== 📂 目录选择弹窗 =====================
const dirPickerCtx = { path: null, parent: null, home: '', onPick: null };

function initDirPicker() {
  const modal = $('#dirPickerModal');
  if (!modal) return;
  const close = () => {
    if (typeof modal.close === 'function') modal.close();
    else modal.removeAttribute('open');
  };
  $('#closeDirPicker').onclick = close;
  $('#dirPickerCancel').onclick = close;
  $('#dirPickerUp').onclick = () => loadDirListing(dirPickerCtx.parent);
  $('#dirPickerHome').onclick = () => loadDirListing(dirPickerCtx.home);
  $('#dirPickerSelect').onclick = () => {
    const picked = dirPickerCtx.path;
    const cb = dirPickerCtx.onPick;
    if (!picked || !cb) return;
    close();
    cb(picked);
  };
}

async function loadDirListing(target) {
  if (!target) {
    // 未给起点时取用户主目录（如「文档导入」选择 vault 外的源文件夹）
    try { target = (await api('/api/browse-dir')).path; } catch { return; }
    if (!target) return;
  }
  const listEl = $('#dirPickerList');
  if (!listEl) return;
  listEl.innerHTML = `<div class="dir-picker-empty">${t('正在读取…')}</div>`;
  try {
    const data = await api(`/api/browse-dir?path=${encodeURIComponent(target)}`);
    dirPickerCtx.path = data.path;
    dirPickerCtx.parent = data.parent;
    dirPickerCtx.home = data.home;
    const pathEl = $('#dirPickerPath');
    pathEl.textContent = data.path;
    pathEl.title = data.path;
    listEl.innerHTML = data.dirs.length
      ? data.dirs.map((d) => `<button type="button" class="dir-picker-row" data-path="${escapeHTML(d.path)}"><span>📁</span><span>${escapeHTML(d.name)}</span></button>`).join('')
      : `<div class="dir-picker-empty">${t('此目录下没有可见子目录，可直接「选择此目录」')}</div>`;
    listEl.querySelectorAll('.dir-picker-row').forEach((row) => {
      row.onclick = () => loadDirListing(row.dataset.path);
    });
  } catch (err) {
    listEl.innerHTML = `<div class="dir-picker-empty">${escapeHTML(err.message)}</div>`;
  }
}

function openDirPicker({ initial = '', onPick }) {
  dirPickerCtx.onPick = onPick;
  const modal = $('#dirPickerModal');
  if (typeof modal.showModal === 'function') modal.showModal();
  else modal.setAttribute('open', '');
  loadDirListing(initial);
}

function initNoteModal() {
  const modal = $('#noteModal');
  if (!modal) return;
  const open = () => {
    $('#noteTitleInput').value = '';
    $('#noteBodyInput').value = '';
    if (typeof modal.showModal === 'function') modal.showModal();
    else modal.setAttribute('open', '');
  };
  const close = () => {
    if (typeof modal.close === 'function') modal.close();
    else modal.removeAttribute('open');
  };
  $('#newNoteBtn').onclick = open;
  $('#btnNewNote').onclick = open;
  $('#closeNoteModal').onclick = close;
  $('#cancelNoteModal').onclick = close;
  $('#noteModalForm').onsubmit = async (e) => {
    e.preventDefault();
    const title = $('#noteTitleInput').value.trim();
    const body = $('#noteBodyInput').value.trim();
    if (!title) { showToast(t('请填写标题')); return; }
    const folder = $('#noteFolderSelect').value;
    const date = today();
    const slug = title.replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'note';
    const path = `${folder}/${date}-${slug}.md`;
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const content = `# ${title}\n\n> Created at ${date} ${timeStr} · VaultDesk\n\n${body}\n`;
    const from = currentLoc();
    try {
      await writeNote({ path, content });
      showToast(t('笔记已创建'));
      close();
      state.view = 'all';
      state.folder = folder;
      switchMainView('notes');
      openNote({ path, title });
      recordNav(from);
    } catch (err) { showToast(err.message); }
  };
}

// 语言切换器 + 静态界面文本首次应用
const langSel = $('#langSelect');
if (langSel) {
  langSel.value = LANG;
  langSel.onchange = (e) => setLang(e.target.value);
}
applyStaticI18n();
loadBase();

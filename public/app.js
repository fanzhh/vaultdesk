const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// Application State
const state = {
  mainView: 'daily', // 'daily' | 'tasks' | 'notes' | 'chat' | 'feeds'
  feeds: { sources: [], articles: [], activeKey: 'all', unreadOnly: false, loading: false },
  notes: [],
  current: null, // Current note in Notes view
  folder: '',
  view: 'all', // 'all' | 'recent' | 'drafts' | 'folder'
  query: '',
  listFilter: '',
  dates: [],
  dailyDate: '',
  dailyNote: null,
  inboxTasks: [],
  taskFilter: 'today', // 'today' | 'all' | 'overdue' | 'work' | 'learning' | 'reading' | 'personal' | 'done'
  taskQuery: '',
  editingTaskLine: null,
  chatHistory: [],
  chatLoading: false,
  availableLLMs: [],
  selectedModel: 'qwen3.5-2b',
  selectedScope: ''
};

// Storage Keys
const draftsKey = 'vaultdesk-drafts';
const drafts = () => JSON.parse(localStorage.getItem(draftsKey) || '[]');
const saveDrafts = (value) => localStorage.setItem(draftsKey, JSON.stringify(value));
const draftFor = (path) => drafts().find((d) => d.path === path);

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

// Markdown Renderer
function markdown(md) {
  if (!md) return '';
  let text = escapeHTML(md).replace(/^---[\s\S]*?---\s*/, '');
  const blocks = [];
  text = text.replace(/&lt;!--[\s\S]*?--&gt;/g, '');

  // Code & Dataview blocks
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    if (lang === 'dataview') {
      blocks.push(`<div class="dataview-block"><span>📊</span><div><strong style="color:var(--accent)">Dataview 动态查询</strong><div style="font-size:11px;opacity:0.85;margin-top:2px;font-family:ui-monospace,monospace">${code.trim().replace(/\n/g, '<br>')}</div></div></div>`);
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
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<span class="task-tag" style="background:#f0ece5">🖼 图片：$1</span>');

  // Standard Markdown links: [Text](URL)
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Wikilinks
  text = text.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, link, alias) => {
    const label = alias || link;
    return `<a class="wikilink" href="javascript:void(0)" data-wiki="${escapeHTML(link)}">${escapeHTML(label)}</a>`;
  });

  // Task check items in markdown
  text = text.replace(/^[-*] \[( |x|X|\/)\] (.*)$/gm, (_, mark, body) => {
    const isDone = mark.toLowerCase() === 'x';
    return `<div class="task-card-row ${isDone ? 'is-done' : ''}" style="margin:4px 0;padding:6px 10px"><div class="task-checkbox-wrap"><input type="checkbox" class="task-checkbox" disabled ${isDone ? 'checked' : ''}></div><div class="task-content-wrap"><span class="task-title-text">${body}</span></div></div>`;
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
  if (!r.ok) throw new Error(data.error || '待办写回失败');
  return data;
}

async function writeNote(payload) {
  const r = await fetch('/api/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '笔记写回失败');
  return data;
}

async function refreshTasks() {
  const data = await api('/api/tasks');
  state.inboxTasks = data.tasks || [];
  updateTaskBadges();
}

function updateTaskBadges() {
  const t = today();
  const openTasks = state.inboxTasks.filter((task) => !task.done);
  const count = openTasks.length;
  
  const topBadge = $('#topTaskBadge');
  if (topBadge) {
    topBadge.textContent = count;
    topBadge.className = `tab-badge ${count === 0 ? 'empty' : ''}`;
  }

  const sideBadge = $('#sidebarTaskBadge');
  if (sideBadge) {
    sideBadge.textContent = count;
  }
}

// Task Parsing & Formatting Helper
function formatTaskTitle(rawTitle) {
  if (!rawTitle) return '';
  let text = escapeHTML(rawTitle);

  // Standard Markdown Link: [Text](URL)
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|[^\s)]+)\)/g, 
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="task-inline-link" onclick="event.stopPropagation()">$1 ↗</a>');

  // Wikilinks: [[target|alias]] or [[target]]
  text = text.replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, link, alias) => {
    const label = alias || link;
    return `<a class="wikilink" href="javascript:void(0)" data-wiki="${escapeHTML(link)}" onclick="event.stopPropagation()">${escapeHTML(label)}</a>`;
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
  if (lower.includes('紧急') || lower.includes('整改') || lower.includes('报销')) return 'tag-urgent';
  return '';
}

// Render individual task card row
function renderTaskCard(task) {
  const parts = taskParts(task);
  const t = today();
  const isOverdue = !task.done && parts.due && parts.due < t;
  const isTodayDue = parts.due === t;

  let dueBadge = '';
  if (parts.due) {
    const label = parts.due === t ? `今日 (${parts.due})` : parts.due;
    const cls = isOverdue ? 'is-overdue' : (isTodayDue ? 'is-today' : '');
    dueBadge = `<span class="task-due-badge ${cls}">📅 ${escapeHTML(label)}</span>`;
  }

  let doneBadge = '';
  if (task.done && parts.doneDate) {
    doneBadge = `<span class="task-done-badge">✅ ${escapeHTML(parts.doneDate)} 完成</span>`;
  }

  const priorityPill = parts.priority ? `<span class="task-tag" style="background:#fee2e2;color:#b91c1c">${parts.priority} 优先</span>` : '';

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
        <button class="task-row-btn btn-edit-task" data-task-line="${task.line}" title="编辑事项">✎ 编辑</button>
        <button class="task-row-btn btn-delete-task" data-task-line="${task.line}" title="删除此事项">🗑 删除</button>
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
        showToast(isDone ? '待办已标记完成' : '已恢复为未完成');
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
      const previewText = parts.title || item.text || '此事项';
      if (!confirm(`确定要从 Inbox.md 中删除此待办事项吗？\n\n"${previewText}"`)) return;
      try {
        await writeTask({ action: 'delete', line });
        await refreshTasks();
        showToast('待办事项已从 Inbox.md 删除');
        if (state.mainView === 'tasks') renderTasksView();
        if (state.mainView === 'daily') renderDaily(state.dailyNote);
      } catch (err) {
        showToast(err.message);
      }
    };
  });
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
      const previewText = parts.title || item?.text || '此事项';
      if (!confirm(`确定要从 Inbox.md 中删除此待办事项吗？\n\n"${previewText}"`)) return;
      try {
        await writeTask({ action: 'delete', line });
        await refreshTasks();
        closeModal();
        showToast('待办事项已从 Inbox.md 删除');
        if (state.mainView === 'tasks') renderTasksView();
        if (state.mainView === 'daily') renderDaily(state.dailyNote);
      } catch (err) {
        showToast(err.message);
      }
    };
  }

  // Tag chip click to append
  $$('.modal-tag').forEach((el) => {
    el.onclick = () => {
      const tag = el.dataset.tag;
      if (tag && !input.value.includes(tag)) {
        input.value = `${input.value.trim()} ${tag} `.trimStart();
        input.focus();
      }
    };
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (state.editingTaskLine === null) return;
    const text = input.value.trim();
    if (!text) return;
    try {
      const result = await writeTask({ action: 'edit', line: state.editingTaskLine, text });
      await refreshTasks();
      closeModal();
      showToast('待办已更新');
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
async function openDaily(date) {
  state.dailyDate = date;
  $('#sideDailyDate').value = date;
  $('#crumbSection').textContent = '每日日记';
  $('#crumbTarget').textContent = date === today() ? `今日 (${date})` : date;

  const data = await api(`/api/daily?date=${encodeURIComponent(date)}`);
  if (data.error) {
    showToast('日记加载失败');
    return;
  }
  const local = draftFor(data.path);
  const shown = local ? { ...data, ...local, draft: true, generated: false, exists: true } : data;
  state.dailyNote = shown;
  renderDaily(shown);
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
    statusBadge = '<span class="badge badge-draft">✎ 浏览器草稿</span>';
  } else if (note.exists) {
    statusBadge = '<span class="badge badge-success">✓ 知识库已归档</span>';
  } else {
    statusBadge = '<span class="badge badge-warning">◌ 当日未建档</span>';
  }

  // Linked Today Tasks
  const linkedTasks = state.inboxTasks.filter((t) => t.due === note.date);
  const openTasks = linkedTasks.filter((t) => !t.done);
  const doneTasks = linkedTasks.filter((t) => t.done);

  const taskWidgetHtml = `
    <details class="daily-tasks-widget" ${openTasks.length ? 'open' : ''}>
      <summary class="daily-tasks-summary">
        <div class="summary-left">
          <span>📅</span>
          <span>当日到期待办事项</span>
          <span class="badge badge-draft" style="font-size:10px">${openTasks.length} 项未完成</span>
          ${doneTasks.length ? `<span class="badge badge-success" style="font-size:10px">${doneTasks.length} 项已完成</span>` : ''}
        </div>
        <div class="summary-right">
          <a href="javascript:void(0)" class="goto-tasks-link" id="gotoTasksFromDaily">打开待办中心 ➔</a>
          <span>▾</span>
        </div>
      </summary>
      <div class="daily-tasks-body">
        <div class="daily-tasks-quick-list" id="dailyTasksList">
          ${linkedTasks.length ? linkedTasks.map(renderTaskCard).join('') : '<div style="color:var(--muted);font-size:12px;padding:8px 0">当天没有排期的待办事项</div>'}
        </div>
      </div>
    </details>
  `;

  // Note Body
  let paperBody = '';
  if (note.generated) {
    paperBody = `
      <div class="daily-paper">
        <div class="daily-empty-state">
          <div class="daily-empty-icon">◌</div>
          <h3>${escapeHTML(note.date)} 暂无日记记录</h3>
          <p>当前 Vault 中尚未创建这一天的日记文件，你可以基于默认模版快速生成。</p>
          <button class="btn btn-primary" id="btnCreateDailyFromTpl" style="padding:9px 18px">＋ 基于模板一键创建</button>
        </div>
      </div>
    `;
  } else {
    const cleanContent = note.content
      .replace(/^## 今日待办[\s\S]*?(?=^## 健康)/m, '')
      .replace(/^## 今日完成\s*\n```dataview[\s\S]*?```\s*/m, '')
      .replace(/```dataview[\s\S]*?```/g, '\n')
      .replace(/\n---\s*\n\*模板版本:[\s\S]*$/, '');

    paperBody = `
      <div class="daily-paper">
        <div class="daily-paper-head">
          <div class="eyebrow" style="margin-bottom:4px">DAILY JOURNAL</div>
          <h1 class="daily-paper-title">${escapeHTML(note.date)} 每日手记</h1>
          <div class="daily-meta-info">
            <span>文件路径: ${escapeHTML(note.path)}</span>
            <span>字数: ${note.content ? note.content.length : 0} 字</span>
          </div>
        </div>
        <div class="markdown" id="dailyMarkdownBody">${markdown(cleanContent)}</div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="daily-header-card">
      <div class="daily-nav-row">
        <div class="daily-date-controls">
          <button class="date-nav-btn" id="btnPrevDay" title="前一天 (快捷键: ←)">◀ 前一天</button>
          <input type="date" class="daily-input-date" id="dailyMainDateInput" value="${note.date}">
          <button class="date-nav-btn" id="btnToday" ${isTodayDate ? 'style="font-weight:600;border-color:var(--accent);color:var(--accent)"' : ''}>回到今天</button>
          <button class="date-nav-btn" id="btnNextDay" title="后一天 (快捷键: →)">后一天 ▶</button>
          ${statusBadge}
        </div>
        <div class="daily-actions">
          ${note.exists || note.draft ? `
            <button class="btn btn-secondary" id="btnEditDaily">✏️ 浏览器内编辑</button>
            <button class="btn btn-secondary" id="btnDownloadDaily">↓ 下载 .md</button>
          ` : ''}
        </div>
      </div>
    </div>
    ${taskWidgetHtml}
    ${paperBody}
  `;

  // Bind Events for Daily
  $('#btnPrevDay').onclick = () => openDaily(prev);
  $('#btnNextDay').onclick = () => openDaily(next);
  $('#btnToday').onclick = () => openDaily(today());
  $('#dailyMainDateInput').onchange = (e) => openDaily(e.target.value);

  const gotoTasks = $('#gotoTasksFromDaily');
  if (gotoTasks) {
    gotoTasks.onclick = (e) => {
      e.preventDefault();
      switchMainView('tasks');
    };
  }

  const createBtn = $('#btnCreateDailyFromTpl');
  if (createBtn) {
    createBtn.onclick = () => {
      writeNote({ path: note.path, content: note.content }).then(() => {
        const created = { ...note, generated: false, exists: true, draft: false, title: note.date };
        showToast('已成功基于模板创建日记');
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
}

function editDailyNote(note) {
  const container = $('#dailyMarkdownBody');
  if (!container) return;
  container.outerHTML = `
    <div id="dailyEditorWrap" style="margin-top:14px">
      <textarea class="draft-editor" id="dailyDraftEditor">${escapeHTML(note.content)}</textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
        <button class="btn btn-secondary" id="btnCancelEditDaily">取消</button>
        <button class="btn btn-primary" id="btnSaveEditDaily">💾 保存到知识库</button>
      </div>
    </div>
  `;

  const btnEdit = $('#btnEditDaily');
  if (btnEdit) btnEdit.style.display = 'none';

  $('#btnCancelEditDaily').onclick = () => renderDaily(note);
  $('#btnSaveEditDaily').onclick = async () => {
    const val = $('#dailyDraftEditor').value;
    try {
      await writeNote({ path: note.path, content: val });
      saveDrafts(drafts().filter((d) => d.path !== note.path));
      showToast('日记已成功写回知识库');
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
  const t = today();

  const allTasks = state.inboxTasks;
  const openTasks = allTasks.filter((t) => !t.done);
  const doneTasks = allTasks.filter((t) => t.done);
  const todayOpen = openTasks.filter((item) => item.due === t);
  const overdueTasks = openTasks.filter((item) => item.due && item.due < t);

  // Update Topbar Crumb
  $('#crumbSection').textContent = '待办事项';
  $('#crumbTarget').textContent = `Inbox (${openTasks.length} 项未完成)`;

  // Quick Stats
  const statsHtml = `
    <div class="task-stats-grid">
      <div class="stat-card stat-today" data-filter="today" style="cursor:pointer">
        <span class="stat-label">今日待办</span>
        <div class="stat-val">${todayOpen.length} <small style="font-size:12px;font-weight:normal;color:var(--muted)">项</small></div>
      </div>
      <div class="stat-card stat-overdue" data-filter="overdue" style="cursor:pointer">
        <span class="stat-label">已逾期待办</span>
        <div class="stat-val">${overdueTasks.length} <small style="font-size:12px;font-weight:normal;color:var(--muted)">项</small></div>
      </div>
      <div class="stat-card" data-filter="all" style="cursor:pointer">
        <span class="stat-label">收件箱全部未完</span>
        <div class="stat-val">${openTasks.length} <small style="font-size:12px;font-weight:normal;color:var(--muted)">项</small></div>
      </div>
      <div class="stat-card stat-completed" data-filter="done" style="cursor:pointer">
        <span class="stat-label">历史已完成</span>
        <div class="stat-val">${doneTasks.length} <small style="font-size:12px;font-weight:normal;color:var(--muted)">项</small></div>
      </div>
    </div>
  `;

  // Quick Add Card
  const addCardHtml = `
    <div class="task-add-card">
      <div class="task-add-main-row">
        <input type="text" id="taskMainInput" class="task-add-input" placeholder="＋ 添加新待办事项... (输入 #work 或点击下方标签快捷插入)">
        <input type="date" id="taskMainDueDate" class="task-add-date" value="${t}">
        <button class="btn btn-primary task-add-submit" id="btnSubmitTask">＋ 写回 Inbox.md</button>
      </div>
      <div class="task-add-sub-row">
        <div class="quick-tag-pills">
          <span class="tag-label-hint">快捷标签:</span>
          <button class="quick-tag-btn" data-insert="#work">+ #work</button>
          <button class="quick-tag-btn" data-insert="#learning">+ #learning</button>
          <button class="quick-tag-btn" data-insert="#reading">+ #reading</button>
          <button class="quick-tag-btn" data-insert="#personal">+ #personal</button>
          <button class="quick-tag-btn" data-insert="#study">+ #study</button>
          <button class="quick-tag-btn" data-insert="#整改">+ #整改</button>
          <button class="quick-tag-btn" data-insert="#报销">+ #报销</button>
          <button class="quick-tag-btn" data-insert="🔼">+ 🔼 优先级</button>
        </div>
      </div>
    </div>
  `;

  // Filter Toolbar
  const filterTabs = [
    { id: 'today', label: '🌟 今日待办', count: todayOpen.length },
    { id: 'overdue', label: '⚠️ 逾期待办', count: overdueTasks.length },
    { id: 'all', label: '📋 全部未完成', count: openTasks.length },
    { id: 'work', label: '🏢 #work', count: openTasks.filter((x) => x.text.includes('#work')).length },
    { id: 'learning', label: '📖 #learning', count: openTasks.filter((x) => /#learning|#study|#学习/i.test(x.text)).length },
    { id: 'reading', label: '📚 #reading', count: openTasks.filter((x) => /#reading|#books|#阅读/i.test(x.text)).length },
    { id: 'personal', label: '👤 #personal', count: openTasks.filter((x) => x.text.includes('#personal') || x.text.includes('#个人')).length },
    { id: 'done', label: '✅ 已完成', count: doneTasks.length }
  ];

  const toolbarHtml = `
    <div class="task-toolbar">
      <div class="task-filter-tabs">
        ${filterTabs.map((tab) => `
          <button class="task-tab-btn ${state.taskFilter === tab.id ? 'active' : ''}" data-task-tab="${tab.id}">
            ${tab.label} (${tab.count})
          </button>
        `).join('')}
      </div>
      <input type="text" id="taskSearchInput" class="task-search-input" placeholder="搜索待办..." value="${escapeHTML(state.taskQuery)}">
    </div>
  `;

  // Filter Tasks by tab & query
  let filtered = [];
  if (state.taskFilter === 'today') {
    filtered = openTasks.filter((x) => x.due === t);
  } else if (state.taskFilter === 'overdue') {
    filtered = overdueTasks;
  } else if (state.taskFilter === 'all') {
    filtered = openTasks;
  } else if (state.taskFilter === 'work') {
    filtered = openTasks.filter((x) => x.text.includes('#work'));
  } else if (state.taskFilter === 'learning') {
    filtered = openTasks.filter((x) => /#learning|#study|#学习/i.test(x.text));
  } else if (state.taskFilter === 'reading') {
    filtered = openTasks.filter((x) => /#reading|#books|#阅读/i.test(x.text));
  } else if (state.taskFilter === 'personal') {
    filtered = openTasks.filter((x) => x.text.includes('#personal') || x.text.includes('#个人'));
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
    const overdueList = openTasks.filter((x) => x.due && x.due < t);
    const todayList = openTasks.filter((x) => x.due === t);
    const futureList = openTasks.filter((x) => x.due && x.due > t);
    const nodueList = openTasks.filter((x) => !x.due);

    taskListHtml = `
      ${overdueList.length ? `
        <div class="task-group-section">
          <div class="task-group-head">
            <span class="task-group-title" style="color:var(--danger)">⚠️ 逾期未完成事项</span>
            <span class="task-group-count">${overdueList.length} 项</span>
          </div>
          <div class="task-card-list">${overdueList.map(renderTaskCard).join('')}</div>
        </div>
      ` : ''}

      ${todayList.length ? `
        <div class="task-group-section">
          <div class="task-group-head">
            <span class="task-group-title" style="color:var(--accent)">📅 今日到期事项</span>
            <span class="task-group-count">${todayList.length} 项</span>
          </div>
          <div class="task-card-list">${todayList.map(renderTaskCard).join('')}</div>
        </div>
      ` : ''}

      ${futureList.length ? `
        <div class="task-group-section">
          <div class="task-group-head">
            <span class="task-group-title">🗓 未来排期事项</span>
            <span class="task-group-count">${futureList.length} 项</span>
          </div>
          <div class="task-card-list">${futureList.map(renderTaskCard).join('')}</div>
        </div>
      ` : ''}

      ${nodueList.length ? `
        <div class="task-group-section">
          <div class="task-group-head">
            <span class="task-group-title">📥 收件箱待办池 (未设定日期)</span>
            <span class="task-group-count">${nodueList.length} 项</span>
          </div>
          <div class="task-card-list">${nodueList.map(renderTaskCard).join('')}</div>
        </div>
      ` : ''}
    `;
  } else {
    // Normal List Display
    taskListHtml = `
      <div class="task-card-list" style="margin-top:12px">
        ${filtered.length ? filtered.map(renderTaskCard).join('') : '<div class="task-empty-card">当前分类下没有匹配的事项</div>'}
      </div>
    `;
  }

  container.innerHTML = `
    <div class="tasks-header">
      <div class="tasks-header-top">
        <div class="tasks-title-wrap">
          <div class="eyebrow">TASK & INBOX MANAGER</div>
          <h1>待办事项与任务流</h1>
        </div>
        <div class="tasks-source-tag">数据源: 01_AREAS/Inbox.md</div>
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
    const text = mainInput.value.trim();
    if (!text) return;
    const due = mainDueDate.value || '';
    try {
      const result = await writeTask({ action: 'add', text, due });
      mainInput.value = '';
      await refreshTasks();
      showToast('待办已写回 Inbox.md');
      renderTasksView();
    } catch (e) {
      showToast(e.message);
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
      renderTasksView();
    };
  }

  // Bind task row checkboxes & edit buttons
  bindTaskEvents($('#tasksListContainer'));
}

// ==========================================================================
// VIEW 3: 📚 NOTES & EXPLORER (知识库笔记双栏)
// ==========================================================================
async function renderNotesView() {
  $('#crumbSection').textContent = '知识库笔记';
  const title = state.view === 'recent' ? '最近更新' : (state.view === 'drafts' ? '浏览器草稿' : (state.folder || '全部笔记'));
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

  const title = state.view === 'recent' ? '最近更新' : (state.view === 'drafts' ? '浏览器草稿' : (state.folder || '全部笔记'));
  $('#listTitle').textContent = title;
  $('#resultCount').textContent = state.notes.length + (data.total > 180 ? '+' : '');
  $('#listSub').textContent = state.view === 'drafts' ? '草稿仅保存在当前浏览器，不会写回原始 vault' : '从原始 vault 直接读取，保持文件不变';

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
        <span>${n.draft ? '本地草稿' : time(n.mtime)}</span>
        ${n.tags?.slice(0, 2).map((t) => `<span class="task-tag">${escapeHTML(t)}</span>`).join('')}
      </div>
    </article>
  `).join('') : '<div class="empty-reader" style="margin:40px 0"><div class="empty-icon">⌁</div><p>没有找到匹配笔记</p></div>';

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

  $('#draftCount').textContent = drafts().length;
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
    showToast('这篇笔记暂时无法读取');
    return;
  }
  const local = draftFor(item.path);
  const shown = local ? { ...data, ...local, draft: true } : data;
  state.current = shown;
  $('#crumbTarget').textContent = shown.title;
  renderNoteReader(shown, shown.content);
  renderNoteList();
}

function renderNoteReader(note, content) {
  const readerEl = $('#noteReader');
  if (!readerEl) return;
  const isDraft = note.draft;

  readerEl.innerHTML = `
    <div class="reader-head">
      <div class="reader-head-top">
        <div class="reader-title-area">
          <div class="eyebrow">${isDraft ? 'BROWSER LOCAL DRAFT' : 'VAULT NOTE'}</div>
          <h2>${escapeHTML(note.title)}</h2>
          <div class="reader-path">${escapeHTML(note.path || '本地浏览器草稿')}</div>
        </div>
        <div class="reader-actions">
          <button class="btn btn-secondary" id="btnEditNote">${isDraft ? '继续编辑' : '✏️ 浏览器内编辑'}</button>
          <button class="btn btn-secondary" id="btnDownloadNote">↓ 下载 .md</button>
        </div>
      </div>
    </div>
    <div class="markdown" id="noteMarkdownBody">${markdown(content)}</div>
  `;

  $('#btnEditNote').onclick = () => editVaultNote(note, content);
  $('#btnDownloadNote').onclick = () => download(note.title, content);

  // Wikilink clicks inside markdown
  readerEl.querySelectorAll('.wikilink').forEach((a) => {
    a.onclick = () => {
      const wikiTarget = a.dataset.wiki;
      state.query = wikiTarget;
      state.view = 'all';
      state.folder = '';
      $('#search').value = wikiTarget;
      renderNoteList();
    };
  });
}

function editVaultNote(note, content) {
  const body = $('#noteMarkdownBody');
  if (!body) return;
  body.outerHTML = `
    <div id="noteEditorWrap">
      <textarea class="draft-editor" id="noteDraftEditor">${escapeHTML(content)}</textarea>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
        <button class="btn btn-secondary" id="btnCancelEditNote">取消</button>
        <button class="btn btn-primary" id="btnSaveEditNote">💾 保存到知识库</button>
      </div>
    </div>
  `;

  const btnEdit = $('#btnEditNote');
  if (btnEdit) btnEdit.style.display = 'none';

  $('#btnCancelEditNote').onclick = () => renderNoteReader(note, content);
  $('#btnSaveEditNote').onclick = async () => {
    const val = $('#noteDraftEditor').value;
    try {
      await writeNote({ path: note.path, content: val });
      saveDrafts(drafts().filter((d) => d.path !== note.path));
      showToast('已成功写回知识库');
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
  updateFeedBadges();
  if (state.mainView === 'feeds') renderFeedsView();
}
function updateFeedBadges() {
  const totalUnread = state.feeds.sources.reduce((s, x) => s + (x.unread || 0), 0);
  const sb = $('#sidebarFeedBadge'); if (sb) sb.textContent = totalUnread;
  const tb = $('#topFeedBadge'); if (tb) tb.textContent = totalUnread;
}
function renderFeedsView() {
  const srcEl = $('#feedSourceList');
  const artEl = $('#feedArticleList');
  if (!srcEl || !artEl) return;
  $('#crumbSection').textContent = '资讯聚合';
  $('#crumbTarget').textContent = 'RSS 订阅源';
  const { sources, articles } = state.feeds;
  const { unreadOnly, activeKey } = state.feeds;

  const totalUnread = sources.reduce((s, x) => s + (x.unread || 0), 0);
  srcEl.innerHTML = `
    <button class="feed-source-item ${activeKey === 'all' ? 'active' : ''}" data-fkey="all">
      <span class="feed-source-name">全部文章</span>
      <em class="feed-source-count">${unreadOnly ? `${totalUnread} 未读` : `${articles.length} 篇`}</em>
    </button>
    ${sources.map((s) => `
      <button class="feed-source-item ${activeKey === s.key ? 'active' : ''} ${s.ok ? '' : 'feed-source-err'}" data-fkey="${escapeHTML(s.key)}">
        <span class="feed-source-name">${escapeHTML(s.name)}${s.ok ? '' : ' ⚠️'}</span>
        <em class="feed-source-count">${(s.unread || 0) > 0 ? `${s.unread} 未读` : '✓'}${!s.ok ? ` ${escapeHTML(s.error || '')}` : ''}</em>
      </button>
    `).join('')}
  `;

  let list = articles;
  if (activeKey !== 'all') list = list.filter((a) => a.key === activeKey);
  if (unreadOnly) list = list.filter((a) => !a.read);

  artEl.innerHTML = list.length ? `
    <div class="feed-article-scroll">
      ${list.map((a) => `
        <article class="feed-article-card ${a.read ? 'is-read' : 'is-unread'}" data-id="${escapeHTML(a.id)}" data-key="${escapeHTML(a.key)}" data-link="${escapeHTML(a.link || '')}" data-title="${escapeHTML(a.title)}" data-source="${escapeHTML(a.source)}">
          <div class="feed-article-main">
            <div class="feed-article-title">${escapeHTML(a.title)}</div>
            <div class="feed-article-meta">
              <span class="feed-article-source">${escapeHTML(a.source)}</span>
              <span class="feed-article-time">${a.pubDate ? time(new Date(a.pubDate).getTime()) : ''}</span>
            </div>
            ${a.summary ? `<div class="feed-article-summary">${escapeHTML(a.summary)}</div>` : ''}
          </div>
          <div class="feed-article-actions">
            <button class="btn btn-secondary feed-save-btn" title="存入稍后读">📥 稍后读</button>
            <button class="btn btn-secondary feed-skip-btn" title="标记已读">✓</button>
          </div>
        </article>
      `).join('')}
    </div>
    <div class="feed-article-foot">共 ${list.length} 篇${unreadOnly ? '（未读）' : ''} · 点击文章自动标记已读并在新标签打开</div>
  ` : `<div class="empty-reader" style="margin:60px 0"><div class="empty-icon">📡</div><p>${unreadOnly ? '没有未读文章 🎉' : '暂无文章，点「刷新」拉取'}</p></div>`;

  srcEl.onclick = (e) => {
    const item = e.target.closest('.feed-source-item');
    if (!item) return;
    state.feeds.activeKey = item.dataset.fkey;
    renderFeedsView();
  };

  artEl.onclick = async (e) => {
    const saveBtn = e.target.closest('.feed-save-btn');
    if (saveBtn) {
      const card = saveBtn.closest('.feed-article-card');
      try {
        await postApi('/api/feed/save', { title: card.dataset.title, link: card.dataset.link, source: card.dataset.source });
        showToast('已存入稍后读 → 01_AREAS/reading/rss-inbox.md');
      } catch (err) { showToast('保存失败'); }
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

function switchMainView(targetView) {
  state.mainView = targetView;
  // 移动端/竖屏：切换视图后自动收起侧栏抽屉
  if (window.innerWidth <= 1024) setDrawer(false);

  // Toggle Topbar Switcher Tabs
  $$('.switcher-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.viewTarget === targetView);
  });

  // Toggle Panes
  $('#paneDaily').classList.toggle('active', targetView === 'daily');
  $('#paneTasks').classList.toggle('active', targetView === 'tasks');
  $('#paneNotes').classList.toggle('active', targetView === 'notes');
  const paneChat = $('#paneChat');
  if (paneChat) paneChat.classList.toggle('active', targetView === 'chat');
  const paneFeeds = $('#paneFeeds');
  if (paneFeeds) paneFeeds.classList.toggle('active', targetView === 'feeds');

  // Sync Sidebar Active Nav
  $$('.nav-item').forEach((nav) => nav.classList.remove('active'));
  if (targetView === 'daily') {
    $('#navDaily').classList.add('active');
    openDaily(state.dailyDate || today());
  } else if (targetView === 'tasks') {
    $('#navTasks').classList.add('active');
    renderTasksView();
  } else if (targetView === 'notes') {
    if (state.view === 'recent') $('#navRecent').classList.add('active');
    else if (state.view === 'drafts') $('#navDrafts').classList.add('active');
    else $('#navAll').classList.add('active');
    renderNotesView();
  } else if (targetView === 'chat') {
    $('#navChat')?.classList.add('active');
    $('#crumbSection').textContent = '知识问答';
    $('#crumbTarget').textContent = 'RAG 智能对话';
    renderChatView();
  } else if (targetView === 'feeds') {
    $('#navFeeds')?.classList.add('active');
    renderFeedsView();
    if (!state.feeds.articles.length) refreshFeeds(false);
  }
}

// ==========================================================================
// VIEW 4: 💬 KNOWLEDGE BASE CHAT & RAG (知识库智能问答)
// ==========================================================================
async function initChatModule() {
  try {
    const data = await api('/api/llm/models');
    state.availableLLMs = data.models || [];
    const select = $('#chatModelSelect');
    if (select && state.availableLLMs.length) {
      select.innerHTML = state.availableLLMs.map((m) => `
        <option value="${escapeHTML(m.id)}" ${m.id === data.defaultModel ? 'selected' : ''}>
          ${escapeHTML(m.name)}${m.size ? ` (${m.size})` : ''}
        </option>
      `).join('');
      state.selectedModel = data.defaultModel || state.availableLLMs[0].id;
    }
  } catch (e) {
    console.error('Failed to load LLM models:', e);
  }

  const modelSelect = $('#chatModelSelect');
  if (modelSelect) {
    modelSelect.onchange = (e) => {
      state.selectedModel = e.target.value;
    };
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
      if (state.chatHistory.length && !confirm('确定要清空当前对话记录吗？')) return;
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
      if (!q || state.chatLoading) return;
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
        <h3>基于知识库的智能对话助手</h3>
        <p>提问后系统将首先在本地 22,000+ 篇文档、工作记录与日记中精准检索 RAG 素材，并由大模型基于真实内容进行总结与解答，支持连续追问与来源溯源。</p>
        <div class="chat-quick-cards">
          <div class="quick-prompt-card" data-prompt="第十一批国家集采中选药品的监督检查总结是什么？">
            <strong>📋 集采中选药品检查总结</strong>
            <span>检索集采监管报告、现场检查缺陷统计与企业台账</span>
          </div>
          <div class="quick-prompt-card" data-prompt="梳理近期关于中药饮片与GAP相关的工作记录">
            <strong>🌿 中药饮片与GAP检查记录</strong>
            <span>总结中药材种植基地延伸检查、专门规定宣讲与企业约谈</span>
          </div>
          <div class="quick-prompt-card" data-prompt="有哪些需要重点关注的药品生产风险隐患？">
            <strong>⚠️ 药品质量安全风险隐患</strong>
            <span>汇总风险会商材料、投诉举报线索与常见缺陷分析</span>
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
          <div class="chat-avatar">我</div>
        </div>
      `;
    } else {
      // Assistant Message
      let sourcesWidget = '';
      if (msg.sources && msg.sources.length) {
        sourcesWidget = `
          <details class="chat-sources-widget" open>
            <summary class="chat-sources-summary">
              <span>🔍 知识库检索素材 (${msg.sources.length} 篇参考依据)</span>
              <span>▾</span>
            </summary>
            <div class="chat-sources-list">
              ${msg.sources.map((s) => `
                <div class="chat-source-item">
                  <div class="chat-source-item-head">
                    <a href="javascript:void(0)" class="chat-source-link" data-path="${escapeHTML(s.path)}">
                      📄 ${escapeHTML(s.title || s.path)}
                    </a>
                    <span class="chat-source-score">匹配分: ${s.score} · 行: ${s.line}</span>
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
            ${sourcesWidget}
            <div class="chat-answer-body markdown">${markdown(msg.content)}</div>
            <div class="chat-msg-actions">
              <button class="chat-action-btn btn-copy-chat" data-chat-idx="${idx}">📋 复制回答</button>
              <button class="chat-action-btn btn-save-chat" data-chat-idx="${idx}">💾 保存为 Wiki 笔记</button>
            </div>
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
            <span>正在知识库中 RAG 检索相关素材并深入思考中...</span>
          </div>
        </div>
      </div>
    `;
  }

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;

  // Bind Source links to open Note Reader
  container.querySelectorAll('.chat-source-link').forEach((link) => {
    link.onclick = (e) => {
      e.preventDefault();
      const targetPath = link.dataset.path;
      if (targetPath) {
        switchMainView('notes');
        openNote({ path: targetPath, title: targetPath.split('/').pop().replace(/\.md$/i, '') });
      }
    };
  });

  // Bind Action buttons
  container.querySelectorAll('.btn-copy-chat').forEach((btn) => {
    btn.onclick = () => {
      const idx = Number(btn.dataset.chatIdx);
      const msg = state.chatHistory[idx];
      if (msg) {
        navigator.clipboard.writeText(msg.content).then(() => showToast('回答内容已复制到剪贴板'));
      }
    };
  });

  container.querySelectorAll('.btn-save-chat').forEach((btn) => {
    btn.onclick = async () => {
      const idx = Number(btn.dataset.chatIdx);
      const msg = state.chatHistory[idx];
      const prevUserMsg = state.chatHistory.slice(0, idx).reverse().find((m) => m.role === 'user');
      const question = prevUserMsg ? prevUserMsg.content : '知识库问答';
      if (!msg) return;

      btn.disabled = true;
      btn.textContent = '保存中...';
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
          showToast('已成功保存为 Wiki 笔记');
          btn.textContent = '✓ 已保存';
        } else {
          showToast(res.error || '保存失败');
          btn.disabled = false;
          btn.textContent = '💾 保存为 Wiki 笔记';
        }
      } catch (e) {
        showToast(e.message);
        btn.disabled = false;
        btn.textContent = '💾 保存为 Wiki 笔记';
      }
    };
  });
}

async function sendChatMessage(question) {
  if (!question || state.chatLoading) return;

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

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        history,
        model,
        path_prefix,
        limit: 5
      })
    });
    const data = await res.json();

    if (!res.ok || data.ok === false) {
      state.chatHistory.push({
        role: 'assistant',
        content: `⚠️ **问答失败**: ${data.error || '无法从模型获取回答'}`,
        sources: data.sources || [],
        timestamp: Date.now()
      });
    } else {
      state.chatHistory.push({
        role: 'assistant',
        content: data.answer,
        sources: data.sources || [],
        timestamp: Date.now()
      });
    }
  } catch (err) {
    state.chatHistory.push({
      role: 'assistant',
      content: `⚠️ **网络或接口异常**: ${err.message}`,
      sources: [],
      timestamp: Date.now()
    });
  } finally {
    state.chatLoading = false;
    if (sendBtn) sendBtn.disabled = false;
    renderChatView();
  }
}

// ==========================================================================
// INITIALIZATION & BASE DATA
// ==========================================================================
async function loadBase() {
  initTaskModal();
  initNoteModal();
  initChatModule();
  state.dailyDate = today();

  const [stats, folders, dates, taskData] = await Promise.all([
    api('/api/stats'),
    api('/api/folders'),
    api('/api/daily-dates'),
    api('/api/tasks')
  ]);

  $('#allCount').textContent = stats.notes.toLocaleString();
  $('#syncTime').textContent = `${(stats.markdownBytes / 1024 / 1024).toFixed(0)} MB · ${folders.length} 目录`;
  state.dates = dates || [];
  state.inboxTasks = taskData.tasks || [];
  updateTaskBadges();

  // Render Folder List in Sidebar
  $('#folders').innerHTML = folders.map((f) => `
    <div class="folder" data-folder="${escapeHTML(f.name)}">
      <span>${escapeHTML(f.name)}</span>
      <small>${f.count}</small>
    </div>
  `).join('');

  $('#folders').onclick = (e) => {
    const el = e.target.closest('.folder');
    if (el) {
      state.folder = el.dataset.folder;
      state.view = 'folder';
      switchMainView('notes');
    }
  };

  // Topbar Switcher Tabs Click
  $$('.switcher-tab').forEach((tab) => {
    tab.onclick = () => {
      switchMainView(tab.dataset.viewTarget);
    };
  });

  // Sidebar Nav Items Click
  $$('.nav-item').forEach((b) => {
    b.onclick = () => {
      const navTarget = b.dataset.nav;
      if (navTarget === 'daily') {
        switchMainView('daily');
      } else if (navTarget === 'tasks') {
        switchMainView('tasks');
      } else if (navTarget === 'chat') {
        switchMainView('chat');
      } else if (navTarget === 'feeds') {
        switchMainView('feeds');
      } else {
        state.view = navTarget;
        state.folder = '';
        switchMainView('notes');
      }
    };
  });

  // Sidebar Calendar Widget
  $('#sideDailyDate').value = state.dailyDate;
  $('#sideDailyDate').onchange = (e) => {
    state.dailyDate = e.target.value;
    switchMainView('daily');
  };
  $('#sideTodayBtn').onclick = () => {
    state.dailyDate = today();
    $('#sideDailyDate').value = state.dailyDate;
    switchMainView('daily');
  };

  // New Note Draft Button
  $('#newDraftBtn').onclick = () => {
    const title = prompt('新建浏览器草稿标题', '未命名笔记');
    if (title) {
      const n = {
        title,
        path: `草稿/${title}.md`,
        content: `# ${title}\n\n`,
        draft: true,
        mtime: Date.now(),
        tags: []
      };
      saveDrafts([n, ...drafts()]);
      state.view = 'drafts';
      switchMainView('notes');
      openNote(n);
    }
  };

  // Global Search
  $('#search').oninput = (e) => {
    state.query = e.target.value;
    state.view = 'all';
    state.folder = '';
    if (state.mainView !== 'notes') {
      switchMainView('notes');
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

  // Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      $('#search').focus();
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
  if (btnFeedAllRead) btnFeedAllRead.onclick = async () => { await postApi('/api/feed/read', { all: true }); await refreshFeeds(false); showToast('已全部标记为已读'); };
  const feedAddInput = $('#feedAddInput');
  const btnAddFeed = $('#btnAddFeed');
  const doAddFeed = async () => {
    if (!feedAddInput || !feedAddInput.value.trim()) return;
    try {
      const r = await postApi('/api/feeds/add', { url: feedAddInput.value.trim() });
      if (r.error) { showToast(r.error); return; }
      feedAddInput.value = '';
      showToast(`已添加 ${r.name}，正在拉取…`);
      await refreshFeeds(true);
    } catch (e) { showToast('添加失败'); }
  };
  if (btnAddFeed) btnAddFeed.onclick = doAddFeed;
  if (feedAddInput) feedAddInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doAddFeed(); } };

  // 预热资讯未读徽标
  refreshFeeds(false);

  // Initial View
  switchMainView('daily');
}

// ========== 新建笔记 Modal & 移动端抽屉 ==========
function setDrawer(open) {
  const sb = $('#sidebar');
  if (!sb) return;
  sb.classList.toggle('open', open);
  const bk = $('#sidebarBackdrop');
  if (bk) bk.classList.toggle('show', open);
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
    if (!title) { showToast('请填写标题'); return; }
    const folder = $('#noteFolderSelect').value;
    const date = today();
    const slug = title.replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'note';
    const path = `${folder}/${date}-${slug}.md`;
    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const content = `# ${title}\n\n> Created at ${date} ${timeStr} · VaultDesk\n\n${body}\n`;
    try {
      await writeNote({ path, content });
      showToast('笔记已创建');
      close();
      state.view = 'all';
      state.folder = folder;
      switchMainView('notes');
      openNote({ path, title });
    } catch (err) { showToast(err.message); }
  };
}

loadBase();

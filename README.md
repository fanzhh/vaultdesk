# VaultDesk

[English](#english) | [中文](#中文)

## 中文

VaultDesk 是一个本地优先的 Markdown 知识库 Web 工作台，适合用来浏览、编辑和检索 Obsidian 风格的本地 vault。它提供笔记浏览、每日笔记、待办管理、RSS 聚合和基于知识库的问答能力。

这个项目面向个人本机使用。默认只监听 `127.0.0.1`，不会主动暴露到局域网。

### 功能特性

- 浏览 Markdown 笔记和每日笔记。
- 在指定目录中新建、编辑 Markdown 笔记。
- 管理一个可配置的 Markdown 待办文件。
- 聚合 RSS 源（可在设置中自定义），记录已读状态，并把稍后读条目写入 vault；应用内「📥 稍后读」入口可回看、标记读完或移除。
- 结合内置关键词检索与可选的语义向量检索，通过 LM Studio、Ollama、DeepSeek 或自定义 OpenAI 兼容服务对知识库进行问答。
- 可选：接入 LLM Wiki 桌面应用的本地 API，作为知识问答的补充知识源——问答素材并入 Wiki 项目的检索命中（🌐 标记），来源在阅读器中只读打开，不会写入 vault。在设置「知识检索」中填入服务地址（默认 `http://127.0.0.1:19828`）即可启用，访问令牌保存于本机 `.env`。
- 文件夹导入：把外部文件夹（含子文件夹）中的文档转换为 Markdown 导入 vault，支持 doc/docx/wps/xls/xlsx/pptx/pdf/txt/csv/md（经本机装有 firecrawl-anydoc 的 Python 环境，自动探测）；可添加多个导入源并定时监控，新增或编辑的文件自动增量导入。
- 可选：选择 vault 内一个或多个目录与本机嵌入模型（Ollama / LM Studio / 自定义服务）建立向量索引，实现语义搜索；目录内容变化会被监控并自动增量向量化。索引任务可随时停止、进度自动保存并可断点续传，个别文件嵌入失败会被跳过而不影响整体。
- 界面支持中文 / English 双语言：侧栏底部 🌐 下拉切换，默认跟随浏览器语言，选择保存在本地；新增语言只需在 `public/app.js` 中增加一个词条表。
- 适配桌面和 iPad/平板竖屏使用。

### 运行要求

- Node.js 20 或更新版本。
- 一个本地 Markdown/Obsidian 兼容 vault。
- 可选：知识问答已内置关键词检索，开箱即用。如想替换为自备脚本（如 `kb-search.py`，需 Python 3），通过 `KB_SEARCH_SCRIPT` 指定绝对路径即可，脚本缺失或出错时自动回退内置实现。
- 可选：LM Studio、Ollama、`DEEPSEEK_API_KEY` 或任意 OpenAI 兼容的自定义模型服务，用于大模型问答。

### 快速开始

```bash
cp .env.example .env
npm start
```

启动前先编辑 `.env`：

```bash
OBSIDIAN_VAULT_ROOT=/absolute/path/to/your/vault
HOST=127.0.0.1
PORT=4177
```

也可以启动后在网页的「设置」页面填写这些配置；保存后会写入 `.env`，重启服务后生效——设置页右上角提供「重启服务」按钮（提示条上也有「立即重启」），点击即可自动重启并恢复页面。每日笔记模板也在「设置」页面编辑（保存到应用自己的 `data/daily-template.md`）；也可以配置 vault 内的模板文件（如 Obsidian 的 `00_META/templates/daily_note_template.md`），配置后优先使用，支持 `{{date:YYYY-MM-DD}}` 格式占位符。

然后打开：

```text
http://localhost:4177
```

### 配置项

服务启动时会自动读取 `.env`。支持的配置如下：

| 变量 | 说明 |
| --- | --- |
| `OBSIDIAN_VAULT_ROOT` | Markdown vault 的绝对路径。默认是 `~/markdown-vault`。 |
| `HOST` | 服务监听地址。默认 `127.0.0.1`。只有在可信局域网中才建议使用 `0.0.0.0`。 |
| `PORT` | 服务端口。默认 `4177`。 |
| `LMSTUDIO_BASE_URL` | LM Studio 的 OpenAI 兼容接口地址，是知识问答与语义索引的本地模型来源之一；只用 Ollama 或 DeepSeek 时可忽略。 |
| `DEFAULT_LLM_MODEL` | 可选，知识问答的默认模型 id（含本机与自定义服务模型）。留空时自动选择（LM Studio 优先）。在设置页修改后立即生效，无需重启。 |
| `DEEPSEEK_API_KEY` | 配置后启用 DeepSeek 云端模型。不要提交到 Git。 |
| `KB_SEARCH_SCRIPT` | 可选。自定义关键词检索脚本的绝对路径，用于替换内置检索；留空使用内置实现，脚本缺失或出错时自动回退。 |
| `VAULT_INBOX_PATH` | 可选，待办文件路径。默认是 `Inbox.md`。 |
| `VAULT_DAILY_PATH_PATTERN` | 可选，每日笔记路径模板。默认是 `Daily/{YYYY}-{MM}-{DD}.md`。 |
| `VAULT_RSS_READ_LATER_PATH` | 可选，RSS 稍后读保存文件。默认是 `read-later.md`。 |
| `VAULT_CHAT_SAVE_PATH_PATTERN` | 可选，问答保存路径模板。默认是 `answers/{YYYY}-{MM}-{DD}-answer-{slug}.md`。 |

### 模型服务

Ollama 与 LM Studio 是内置的本地模型服务：设置页「AI 大模型」标签可一键获取两者已下载的模型列表（Ollama 固定连接本机 11434，LM Studio 使用 `LMSTUDIO_BASE_URL`）。

也可以在「AI 大模型」标签添加任意 OpenAI 兼容的自定义模型服务（DeepSeek 官方、第三方中转、vLLM 等）：填写名称、服务地址、API Key 与模型名称，并可一键测试连通性。保存后其模型会出现在问答模型下拉与「知识检索」的嵌入服务中。自定义服务保存在 `data/llm-providers.json`（本地文件，不进 Git），API Key 不会回显，留空保存表示保持不变。

「默认模型」决定知识问答打开时使用的模型，可从下拉建议中选择（含自定义服务模型），也可在问答页随时临时切换；所选服务离线时自动回退到其它可用模型。

### 安全说明

VaultDesk 不是多用户 Web 应用。它包含能写入本地 vault 的接口：

- `POST /api/note`
- `POST /api/task`
- `POST /api/chat/save`
- `POST /api/feed/save`
- `POST /api/feeds/add`

除非你明确知道风险，否则请保持 `HOST=127.0.0.1`。如果需要在局域网中访问，建议只在可信网络使用，或者放在带认证的反向代理之后。

以下运行期数据默认不会进入 Git：

- `logs/`
- `data/feed-read.json`
- `data/feeds-cache.json`
- `data/feeds.json`（自定义 RSS 源）
- `data/llm-providers.json`（自定义模型服务）
- `data/vector-meta.json` 与 `data/vector-data.bin`（向量索引）
- `.env`
- Python 缓存文件

### RSS 源

RSS 源支持两层配置，优先级从高到低：

1. **自定义源**：在应用「设置 → 📡 资讯聚合」中编辑，保存到 `data/feeds.json`（本地运行状态，已 gitignore）。每行一个源，格式 `名称 | URL | 每源条数`，名称和条数可省略；清空保存即恢复内置默认。
2. **内置默认源**：仓库根目录的 `feeds.json`，仅在无自定义源时生效。

「资讯聚合」页的"添加源"输入框同样写入自定义源列表。点文章卡上的「📥 稍后读」会把 `- [ ] 读：标题（来源）链接 #reading` 追加到 vault 的稍后读文件（默认 `read-later.md`），侧栏「📥 稍后读」入口回读同一文件，支持打开原文、标记读完（`- [x]`）和移除；在 Obsidian 中手工改动也会同步反映到应用里。

已读状态和抓取缓存保存在 `data/` 下，这些文件属于本地运行状态，不应提交到仓库。

如果内置 RSS 抓取能力不够，可以替换为 Miniflux 等专门的 RSS 服务，同时保留现有前端和稍后读写入逻辑。

### 向量化语义搜索

在「设置 → 向量化语义搜索」中：

1. 选择 vault 内要向量化的目录（留空表示整个 vault）；
2. 选择嵌入服务（Ollama、LM Studio 或已保存的自定义服务）与已安装的 embedding 模型（如 `qwen3-embedding`、`bge-m3`、`nomic-embed-text`）；
3. 点击「开始向量化」。任务在后台执行，可随时停止。

索引完成后，「知识问答」会自动把语义检索结果与关键词检索合并；目录内 `.md/.txt` 文件的新增、修改、删除会被监控并自动增量向量化。更换模型或目录后需要重建索引。索引数据保存在应用 `data/` 目录，不会写入 vault。

### 开发

维护与阶段性工作记录见 [docs/worklog-2026-08-27.md](docs/worklog-2026-08-27.md)。

运行语法检查：

```bash
npm run check
```

启动服务：

```bash
npm start
```

如果需要在平板或手机上通过局域网访问：

```bash
HOST=0.0.0.0 npm start
```

然后在设备浏览器中打开：

```text
http://<你的电脑局域网 IP>:4177
```

### 许可证

MIT

## English

VaultDesk is a local-first web workbench for an Obsidian-style Markdown vault. It can browse notes, edit Markdown files, manage inbox tasks, read RSS feeds, and answer questions against a local knowledge base.

The app is designed for personal use on a trusted machine. By default, it only listens on `127.0.0.1`.

### Features

- Browse Markdown notes and daily notes from a vault.
- Create and update Markdown notes in configured folders.
- Manage tasks from a configurable Markdown task file.
- Read RSS feeds (customizable in Settings), track read state, and save read-later items to the vault; an in-app "Read Later" entry lets you revisit, finish, or remove saved items.
- Ask questions against the vault using built-in keyword retrieval plus optional semantic search, with LM Studio, Ollama, DeepSeek, or any OpenAI-compatible custom provider as the model backend.
- Optional: connect the LLM Wiki desktop app's local API as an extra knowledge source for Q&A — retrieval hits from the Wiki project are merged into the answer references (marked 🌐) and open read-only in the reader, never written to the vault. Fill in the URL in Settings → Knowledge Retrieval (default `http://127.0.0.1:19828`); the access token stays in the local `.env`.
- Folder import: convert documents in external folders (including subfolders) to Markdown and import them into the vault — doc/docx/wps/xls/xlsx/pptx/pdf/txt/csv/md via a local Python environment with firecrawl-anydoc (auto-detected). Add multiple sources and watch them on a schedule; new or edited files are imported incrementally.
- Optional: build a vector index over one or more vault folders with a local embedding model (Ollama / LM Studio / custom provider) for semantic search; file changes are watched and indexed incrementally. Index jobs can be stopped at any time — progress is saved automatically and the job resumes where it left off; individual files that fail to embed are skipped without aborting the run.
- The UI speaks Chinese and English: switch via the 🌐 selector at the bottom of the sidebar, defaults to your browser language, and the choice is remembered locally. Adding a language only takes one more dictionary in `public/app.js`.
- Responsive layout for desktop and tablet use.

### Requirements

- Node.js 20 or newer.
- A local Markdown/Obsidian-compatible vault.
- Optional: chat ships with built-in keyword retrieval and works out of the box. To swap in your own script (e.g. `kb-search.py`, requires Python 3), point `KB_SEARCH_SCRIPT` at it; if the script is missing or fails, the built-in search takes over automatically.
- Optional: LM Studio, Ollama, `DEEPSEEK_API_KEY`, or any OpenAI-compatible custom provider for chat.

### Quick Start

```bash
cp .env.example .env
npm start
```

Edit `.env` before starting:

```bash
OBSIDIAN_VAULT_ROOT=/absolute/path/to/your/vault
HOST=127.0.0.1
PORT=4177
```

You can also use the in-app Settings page to write these values to `.env`; restart the server after saving — the Settings page has a "Restart server" button (plus "Restart now" on the pending-changes notice) that restarts the app and recovers the page automatically. The daily note template is edited there too and saved to the app-owned `data/daily-template.md`; you can also point it at a template file inside the vault (e.g. an Obsidian `daily_note_template.md`), which then takes precedence and supports `{{date:YYYY-MM-DD}}` style placeholders.

Open:

```text
http://localhost:4177
```

### Configuration

The server reads `.env` automatically. Supported variables:

| Variable | Purpose |
| --- | --- |
| `OBSIDIAN_VAULT_ROOT` | Absolute path to the Markdown vault. Defaults to `~/markdown-vault`. |
| `HOST` | Bind address. Defaults to `127.0.0.1`. Use `0.0.0.0` only on a trusted LAN. |
| `PORT` | Server port. Defaults to `4177`. |
| `LMSTUDIO_BASE_URL` | OpenAI-compatible LM Studio endpoint; one of the local model sources for chat and semantic indexing. Ignore it if you only use Ollama or DeepSeek. |
| `DEFAULT_LLM_MODEL` | Optional default chat model id (local or custom provider models). When empty the app picks one automatically (LM Studio first). Changing it in Settings takes effect immediately, no restart needed. |
| `DEEPSEEK_API_KEY` | Enables DeepSeek cloud models. Do not commit this value. |
| `KB_SEARCH_SCRIPT` | Optional absolute path to a custom keyword retrieval script that replaces the built-in one. Leave empty to use the built-in search; the app falls back to it if the script is missing or fails. |
| `VAULT_INBOX_PATH` | Optional task file path. Defaults to `Inbox.md`. |
| `VAULT_DAILY_PATH_PATTERN` | Optional daily note path pattern. Defaults to `Daily/{YYYY}-{MM}-{DD}.md`. |
| `VAULT_RSS_READ_LATER_PATH` | Optional RSS read-later file path. Defaults to `read-later.md`. |
| `VAULT_CHAT_SAVE_PATH_PATTERN` | Optional saved-answer path pattern. Defaults to `answers/{YYYY}-{MM}-{DD}-answer-{slug}.md`. |

### Model Providers

Ollama and LM Studio are the built-in local providers: the "AI 大模型" tab in Settings can list the models each one has downloaded (Ollama is always probed at local port 11434; LM Studio uses `LMSTUDIO_BASE_URL`).

You can also add any OpenAI-compatible provider (DeepSeek API, third-party relays, vLLM, etc.) in that tab: enter a name, base URL, API key, and model names, then test the connection with one click. Saved models appear in the chat model picker and in the embedding provider list under "知识检索". Custom providers are stored in `data/llm-providers.json` (a local file, not committed); API keys are never echoed back — leaving the field blank on save keeps the stored key.

The "默认模型" setting decides which model Knowledge Chat uses when opened. Pick one from the suggestions (including custom provider models) or switch models on the fly in the chat page; if the chosen service is offline, the app falls back to another available model.

### Security Notes

VaultDesk is not a multi-user web app. It has endpoints that can write to the configured vault:

- `POST /api/note`
- `POST /api/task`
- `POST /api/chat/save`
- `POST /api/feed/save`
- `POST /api/feeds/add`

Keep `HOST=127.0.0.1` unless you understand the risk. If you expose it on a LAN, only do so on a trusted network or put it behind a reverse proxy with authentication.

Runtime data is intentionally ignored by Git:

- `logs/`
- `data/feed-read.json`
- `data/feeds-cache.json`
- `data/feeds.json` (custom RSS feeds)
- `data/llm-providers.json` (custom model providers)
- `data/vector-meta.json` and `data/vector-data.bin` (vector index)
- `.env`
- Python cache files

### RSS Feeds

Feeds support two layers of configuration, highest priority first:

1. **Custom feeds**: edit them in the app under "Settings → 📡 资讯聚合". They are saved to `data/feeds.json` (local runtime state, gitignored). One feed per line in the form `Name | URL | max items`; name and count are optional. Clear the list and save to restore the built-in defaults.
2. **Built-in defaults**: the repo-level `feeds.json`, used only when no custom feeds exist.

The "add feed" input on the Feeds page writes to the same custom list. The "📥 Read Later" button on an article card appends `- [ ] 读：title (source) link #reading` to the vault read-later file (default `read-later.md`); the "📥 Read Later" sidebar entry reads the same file back, so you can open the article, mark it done (`- [x]`), or remove it — manual edits made in Obsidian show up in the app too.

Read state and cached feed items live under `data/` and should not be committed.

If you outgrow the built-in RSS fetcher, consider replacing the fetch layer with Miniflux while keeping the frontend and read-later bridge.

### Semantic Search (Vectorization)

In "Settings → 向量化语义搜索":

1. Pick a folder inside the vault to index (leave empty for the whole vault);
2. Pick an embedding service (Ollama, LM Studio, or a saved custom provider) and an installed embedding model, e.g. `qwen3-embedding`, `bge-m3`, or `nomic-embed-text`;
3. Click "开始向量化". Indexing runs in the background and can be stopped at any time.

Once indexed, "知识问答" automatically merges semantic retrieval with keyword retrieval. New, modified, or deleted `.md/.txt` files inside the watched folder are re-indexed incrementally. Changing the model or folder requires rebuilding the index. Index data lives in the app's `data/` directory and is never written into the vault.

### Development

Maintenance notes and work logs live in [docs/worklog-2026-08-27.md](docs/worklog-2026-08-27.md).

Run syntax checks:

```bash
npm run check
```

Start the app:

```bash
npm start
```

For LAN testing from a tablet or phone:

```bash
HOST=0.0.0.0 npm start
```

Then open:

```text
http://<your-computer-lan-ip>:4177
```

### License

MIT

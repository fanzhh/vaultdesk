# VaultDesk

[English](#english) | [中文](#中文)

## 中文

VaultDesk 是一个本地优先的 Markdown 知识库 Web 工作台，适合用来浏览、编辑和检索 Obsidian 风格的本地 vault。它提供笔记浏览、每日笔记、待办管理、RSS 聚合和基于知识库的问答能力。

这个项目面向个人本机使用。默认只监听 `127.0.0.1`，不会主动暴露到局域网。

### 功能特性

- 浏览 Markdown 笔记和每日笔记。
- 在指定目录中新建、编辑 Markdown 笔记。
- 管理 `01_AREAS/Inbox.md` 中的待办事项。
- 聚合 RSS 源，记录已读状态，并把稍后读条目写入 vault。
- 通过本地检索脚本和 LM Studio、Ollama 或 DeepSeek 对知识库进行问答。
- 适配桌面和 iPad/平板竖屏使用。

### 运行要求

- Node.js 20 或更新版本。
- 一个本地 Markdown/Obsidian 兼容 vault。
- 可选：Python 3 和 `kb-search.py`，用于知识问答检索。
- 可选：LM Studio、Ollama 或 `DEEPSEEK_API_KEY`，用于大模型问答。

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
| `LMSTUDIO_BASE_URL` | LM Studio 的 OpenAI 兼容接口地址。 |
| `DEEPSEEK_API_KEY` | 配置后启用 DeepSeek 云端模型。不要提交到 Git。 |
| `KB_SEARCH_SCRIPT` | 可选，知识问答使用的 vault 检索脚本路径。 |

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
- `.env`
- Python 缓存文件

### RSS 源

默认 RSS 源配置在 `feeds.json`。已读状态和抓取缓存保存在 `data/` 下，这些文件属于本地运行状态，不应提交到仓库。

如果内置 RSS 抓取能力不够，可以替换为 Miniflux 等专门的 RSS 服务，同时保留现有前端和稍后读写入逻辑。

### 开发

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
- Manage tasks from `01_AREAS/Inbox.md`.
- Read RSS feeds, track read state, and save read-later items to the vault.
- Ask questions against the vault through a local RAG helper and LM Studio, Ollama, or DeepSeek.
- Responsive layout for desktop and tablet use.

### Requirements

- Node.js 20 or newer.
- A local Markdown/Obsidian-compatible vault.
- Optional: Python 3 and a `kb-search.py` script for knowledge Q&A.
- Optional: LM Studio, Ollama, or `DEEPSEEK_API_KEY` for chat.

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
| `LMSTUDIO_BASE_URL` | OpenAI-compatible local LM Studio endpoint. |
| `DEEPSEEK_API_KEY` | Enables DeepSeek cloud models. Do not commit this value. |
| `KB_SEARCH_SCRIPT` | Optional path to the vault search helper used by chat. |

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
- `.env`
- Python cache files

### RSS Feeds

Default feeds are configured in `feeds.json`. Read state and cached feed items live under `data/` and should not be committed.

If you outgrow the built-in RSS fetcher, consider replacing the fetch layer with Miniflux while keeping the frontend and read-later bridge.

### Development

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

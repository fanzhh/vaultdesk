# VaultDesk

A local-first web workbench for an Obsidian-style Markdown vault. It can browse notes, edit Markdown files, manage inbox tasks, read RSS feeds, and answer questions against a local knowledge base.

The app is designed for personal use on a trusted machine. By default it only listens on `127.0.0.1`.

## Features

- Browse Markdown notes and daily notes from a vault.
- Create and update Markdown notes in configured folders.
- Manage tasks from `01_AREAS/Inbox.md`.
- Read RSS feeds, track read state, and save read-later items to the vault.
- Ask questions against the vault through a local RAG helper and LM Studio, Ollama, or DeepSeek.
- Responsive layout for desktop and tablet use.

## Requirements

- Node.js 20 or newer.
- A local Markdown/Obsidian-compatible vault.
- Optional: Python 3 and a `kb-search.py` script for knowledge Q&A.
- Optional: LM Studio, Ollama, or `DEEPSEEK_API_KEY` for chat.

## Quick Start

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

Open <http://localhost:4177>.

## Configuration

The server reads `.env` automatically. Supported variables:

| Variable | Purpose |
| --- | --- |
| `OBSIDIAN_VAULT_ROOT` | Absolute path to the Markdown vault. Defaults to `~/markdown-vault`. |
| `HOST` | Bind address. Defaults to `127.0.0.1`. Use `0.0.0.0` only on a trusted LAN. |
| `PORT` | Server port. Defaults to `4177`. |
| `LMSTUDIO_BASE_URL` | OpenAI-compatible local LM Studio endpoint. |
| `DEEPSEEK_API_KEY` | Enables DeepSeek cloud models. Do not commit this value. |
| `KB_SEARCH_SCRIPT` | Optional path to the vault search helper used by chat. |

## Security Notes

This is not a multi-user web app. It has endpoints that can write to the configured vault:

- `POST /api/note`
- `POST /api/task`
- `POST /api/chat/save`
- `POST /api/feed/save`
- `POST /api/feeds/add`

Keep `HOST=127.0.0.1` unless you understand the risk. If you expose it on a LAN, only do so on a trusted network and consider putting it behind a reverse proxy with authentication.

Runtime data is intentionally ignored by Git:

- `logs/`
- `data/feed-read.json`
- `data/feeds-cache.json`
- `.env`
- Python caches

## RSS Feeds

Default feeds are configured in `feeds.json`. Read state and cached feed items live under `data/` and should not be committed.

If you outgrow the built-in RSS fetcher, consider replacing the fetch layer with Miniflux while keeping the frontend and read-later bridge.

## Development

Run syntax checks:

```bash
npm run check
```

Start the app:

```bash
npm start
```

For LAN testing from a tablet:

```bash
HOST=0.0.0.0 npm start
```

Then open `http://<your-mac-lan-ip>:4177` on the tablet.

## License

MIT

# Hermes EchoLink

A lightweight WebSocket chat server designed for [Hermes Agent](https://github.com/hermesagent/hermes), providing an IM-like messaging interface with real-time communication.

## Features

- 🚀 **Real-time WebSocket** - Instant message delivery with dual WebSocket architecture
- 💬 **Modern Web UI** - Claude.ai-inspired chat interface with dark mode support
- 📝 **Markdown Support** - Client-side markdown rendering for bot responses
- 📚 **Multi-Session** - Independent chat sessions with rename/delete support
- 🔄 **Streaming Response** - Draft message updates for real-time AI thinking
- 🔒 **Production Ready** - Rate limiting, input validation, connection management
- 🧠 **Thinking Display** - Show AI reasoning process (requires Hermes support)

## Architecture

```
┌─────────────────┐
│   Browser UI    │◄── WebSocket #1 (message broadcast)
└─────────────────┘
         ↕
┌─────────────────┐
│ EchoLink Server │
│  • Gateway Hub  │
│  • HTTP Routes  │
│  • Memory Store │
└─────────────────┘
         ↕
┌─────────────────┐
│ Hermes + Plugin │◄── WebSocket #2 (user messages)
│  • Adapter      │──► HTTP POST (bot replies)
│  • Agent Core   │
└─────────────────┘
```

**Two WebSocket Connections:**
- **WS #1** (Browser ↔ EchoLink): Receives all message broadcasts
- **WS #2** (Hermes ↔ EchoLink): Listens for user messages only

**Message Flow:**
1. User sends message → EchoLink receives via HTTP POST
2. EchoLink broadcasts to both WebSockets
3. Hermes receives event via WS #2 → processes → replies via HTTP POST
4. Browser receives reply via WS #1 → renders

## Quick Start

```bash
# 1. Install and run
pnpm install
pnpm dev

# 2. Open browser
open http://127.0.0.1:8787

# 3. Install Hermes plugin
ln -s "$(pwd)/hermes-plugin/echolink-adapter" ~/.hermes/plugins/echolink-adapter

# 4. Configure Hermes (~/.hermes/config.yaml)
platforms:
  echolink:
    enabled: true
    extra:
      token: dev-token
      base_url: http://127.0.0.1:8787
  api_server:
    enabled: false
    extra:
      host: 127.0.0.1
      port: 8642
      key: hermes-echolink-dev-key
      model_name: hermes-agent

# 5. Start Hermes
hermes
/platform enable echolink
```

## Configuration

### EchoLink (`.env`)

```bash
PORT=8787
ECHOLINK_TOKEN=dev-token           # Change in production!
ALLOWED_ORIGINS=http://localhost:8787
HERMES_BOT_ID=hermes
HERMES_BOT_NAME=Hermes
```

### Hermes Plugin

**Method 1: Config File** (Recommended)

```yaml
# ~/.hermes/config.yaml
platforms:
  echolink:
    enabled: true
    extra:
      token: dev-token
      base_url: http://127.0.0.1:8787
  api_server:
    enabled: false
    extra:
      host: 127.0.0.1
      port: 8642
      key: hermes-echolink-dev-key
      model_name: hermes-agent
```

> **Note**: Enable `api_server` only if you want to use HTTP polling mode instead of WebSocket.

**Method 2: Environment Variables**

```bash
export ECHOLINK_TOKEN=dev-token
export ECHOLINK_BASE_URL=http://127.0.0.1:8787
```

## API Reference

### WebSocket Gateway

```javascript
const ws = new WebSocket('ws://127.0.0.1:8787/v1/gateway/connect?token=dev-token');
ws.onmessage = (event) => console.log(JSON.parse(event.data));
```

### HTTP Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/chats/:chatId/messages` | Send user message |
| `POST` | `/v1/messages` | Send bot message (requires auth) |
| `POST` | `/v1/drafts` | Send draft message for streaming |
| `GET` | `/health` | Health check |

**Example: Send User Message**

```bash
curl -X POST http://127.0.0.1:8787/v1/chats/chat_demo/messages \
  -H 'Content-Type: application/json' \
  -d '{"sender_id": "user_demo", "text": "@hermes hello"}'
```

**Example: Send Bot Reply**

```bash
curl -X POST http://127.0.0.1:8787/v1/messages \
  -H 'Authorization: Bearer dev-token' \
  -H 'Content-Type: application/json' \
  -d '{"chat_id": "chat_demo", "sender_id": "hermes", "text": "Hello!"}'
```

## Development

```bash
pnpm dev        # Start dev server (hot reload)
pnpm build      # Build for production
pnpm start      # Start production server
pnpm typecheck  # TypeScript check
pnpm lint       # ESLint check
```

## Project Structure

```
hermes-echolink/
├── src/
│   ├── gateway/          # WebSocket hub
│   ├── http/             # HTTP routes & auth
│   ├── store/            # In-memory storage
│   ├── types/            # TypeScript types
│   └── index.ts          # Entry point
├── public/
│   └── index.html        # Web UI (single file)
├── hermes-plugin/
│   └── echolink-adapter/ # Hermes platform plugin
│       ├── PLUGIN.yaml
│       └── adapter.py
└── .env.example
```

## Tech Stack

- **Backend**: Node.js + TypeScript + Express
- **WebSocket**: ws
- **Validation**: Zod
- **Security**: Helmet + express-rate-limit
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **Package Manager**: pnpm

## Security

- ✅ Rate limiting (100 req/15min)
- ✅ Message size limit (64KB)
- ✅ Connection limit (1000 concurrent)
- ✅ Input validation (Zod schemas)
- ✅ XSS protection (HTML tag filtering)
- ✅ Token authentication (Bearer)
- ✅ CORS whitelist

**Production Checklist:**
- [ ] Change `ECHOLINK_TOKEN` to 32+ character random string
- [ ] Set `ALLOWED_ORIGINS` to your domain
- [ ] Use HTTPS in production
- [ ] Set `LOG_LEVEL=warn` or `error`

## Troubleshooting

**WebSocket connection failed**
- Check EchoLink is running: `curl http://127.0.0.1:8787/health`
- Verify token matches in both `.env` and Hermes config

**Hermes not responding**
- Verify plugin installed: `ls -la ~/.hermes/plugins/echolink-adapter`
- Check Hermes status: `/platform status` in Hermes CLI
- View Hermes logs: `tail -f ~/.hermes/logs/gateway.log`

**Messages from different sessions mixing**
- This was fixed in v0.1.1 - make sure you're on the latest version
- Clear browser cache: Cmd/Ctrl + Shift + R

## Performance

- Max concurrent connections: **1,000**
- Max message size: **64KB**
- Message TTL: **7 days**
- Heartbeat interval: **30s**

## License

MIT

## Contributing

Issues and PRs welcome!

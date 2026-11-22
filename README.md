# ⚡ JanHook

A lightweight, self-hosted **webhook & HTTP request inspector** — an open-source alternative to
[webhook.site](https://webhook.site) and RequestBin. Point any webhook at a JanHook URL and watch
requests land in a clean, dark-mode UI in real time.

No database. No build step. One Node.js process.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                JanHook                                      │
│                                                                             │
│   Sender (Stripe, GitHub, curl, …)          Browser (single page app)       │
│          │                                        │                         │
│          │  POST/GET/PUT/PATCH/DELETE            │  GET /  (static SPA)     │
│          ▼                                        ▼                         │
│  ┌────────────────────────────────────────────────────────────┐              │
│  │                     Express server (Node.js)                │              │
│  │                                                            │              │
│  │   ANY /h/:slug ──────► capture pipeline                     │              │
│  │        │              · raw body preserved (bytes)          │              │
│  │        │              · parsed JSON / form / text           │              │
│  │        │              · headers, query, source IP, size     │              │
│  │        │              · returns configured status + JSON   │              │
│  │        ▼                                                   │              │
│  │   JSON store (./data)                                       │              │
│  │     · endpoints.json          endpoint + response config    │              │
│  │     · requests-<slug>.json    captured requests (newest     │              │
│  │       ┌────────────┐           first, auto-pruned to       │              │
│  │       │ SSE hub    │           MAX_REQUESTS_PER_BIN)       │              │
│  │       └─────┬──────┘                                        │              │
│  │             │ event: request / requests-cleared / …          │              │
│  │   GET /api/events (SSE) ◄──── broadcast ──────┘              │              │
│  └──────────┬──────────────────────────────┬───────────────────┘              │
│             │                              │                                  │
│             ▼                              ▼                                  │
│    GET /h/:slug response          zero-polling UI updates                      │
│    (status + body you            (feed, inspector, badges)                      │
│     configure in the UI)                                                      │
│                                                                             │
│   POST /api/replay ─────────────► forwards captured method,                   │
│                                    headers & body to any target               │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Features

- **Capture everything** — any method, any content type. Raw request bodies are stored alongside
  parsed JSON / form / text so signature headers (Stripe `stripe-signature`,
  GitHub `x-hub-signature-256`, …) can be verified against the exact bytes received.
- **Real-time UI** — Server-Sent Events push every captured request to the browser instantly,
  with zero polling delay.
- **Request inspector** — pretty-printed syntax-highlighted JSON (with Raw/Pretty toggle),
  form-urlencoded and plain-text handling, clean headers & query-parameter tables, one-click copy.
- **Copy as cURL** — reproduce any captured request from your terminal in one click.
- **Replay** — forward a captured request (method + headers + body) to any `localhost` or
  staging URL and inspect the response status & body.
- **Custom responses** — configure the HTTP status code (200 / 201 / 202 / 400 / 500) and JSON
  body that `/h/<slug>` returns to callers.
- **Multiple endpoints** — create as many webhook URLs as you like; switch between them from
  the header. Each keeps its own request history.
- **Bounded disk usage** — each endpoint retains only the newest `MAX_REQUESTS_PER_BIN`
  requests (default 100); older captures are pruned automatically.
- **Zero frontend build** — the UI is a dependency-free static SPA (HTML/CSS/vanilla JS)
  served by Express.
- **Send test webhooks** — fire a sample JSON payload at your endpoint from the UI itself,
  plus a ready-to-copy `curl` command for real senders.

## Quick Start

### Run with Node

```bash
git clone <repo> janhook && cd janhook
npm install
npm start
```

Open **http://localhost:8001** — your first webhook endpoint is created automatically.

### Run with Docker

```bash
docker build -t janhook .
docker run -p 8001:8001 -v janhook-data:/app/data janhook
```

Or persist data to a host directory instead of a named volume:

```bash
docker run -p 8001:8001 -v "$PWD/data:/app/data" janhook
```

### Send your first webhook

Grab the URL from the header bar (`http://localhost:8001/h/<slug>`) and:

```bash
curl -X POST 'http://localhost:8001/h/your-slug' \
  -H 'Content-Type: application/json' \
  --data-raw '{"event":"test.ping","message":"Hello from JanHook!"}'
```

It appears in the UI instantly. Prefer one click? **Send Test Webhook** in the banner does
exactly this from your browser.

## Configuration

All configuration is via environment variables:

| Variable              | Default     | Description                                             |
| --------------------- | ----------- | ------------------------------------------------------- |
| `PORT`                | `8001`      | Port the HTTP server listens on                         |
| `DATA_DIR`            | `./data`    | Directory for the JSON store (endpoints + requests)     |
| `MAX_REQUESTS_PER_BIN`| `100`       | Requests retained per endpoint before oldest are pruned |

```bash
PORT=8080 MAX_REQUESTS_PER_BIN=500 DATA_DIR=/var/lib/janhook npm start
```

## HTTP API

Everything the UI does is available over the API:

| Method   | Path                                   | Description                                     |
| -------- | -------------------------------------- | ----------------------------------------------- |
| `ANY`    | `/h/:slug`                             | Capture a request (returns configured response) |
| `GET`    | `/api/health`                          | Health check                                    |
| `GET`    | `/api/events`                          | SSE stream of live events                       |
| `GET`    | `/api/endpoints`                       | List endpoints                                  |
| `POST`   | `/api/endpoints`                       | Create endpoint                                 |
| `PATCH`  | `/api/endpoints/:slug`                 | Update response config (status + body)          |
| `DELETE` | `/api/endpoints/:slug`                 | Delete endpoint and its history                 |
| `GET`    | `/api/endpoints/:slug/requests`        | List captured requests (newest first)           |
| `DELETE` | `/api/endpoints/:slug/requests`        | Clear all captured requests                     |
| `DELETE` | `/api/requests/:slug/:id`              | Delete a single captured request                |
| `POST`   | `/api/replay`                          | Replay a captured request to a new target       |

## UI Keyboard Shortcuts

| Key   | Action                       |
| ----- | ---------------------------- |
| `/`   | Focus the request filter     |
| `Esc` | Close the replay dialog      |

## Project Layout

```
janhook/
├── server.js          # Express app: capture, SSE hub, API, replay, static
├── lib/
│   └── store.js      # JSON store: atomic writes, debounce, auto-prune
├── public/
│   ├── index.html    # SPA shell
│   ├── app.js        # UI logic (no dependencies, no build)
│   └── style.css     # Dark-mode developer theme
├── data/             # Runtime JSON store (gitignored)
├── Dockerfile
└── README.md
```

## Notes

- **Replay targets** are unrestricted — JanHook will happily forward to any `http(s)` URL,
  which is convenient for local & staging use. If you expose a JanHook instance publicly,
  consider running it behind a trusted proxy and restricting egress at the network level,
  since replay could otherwise be used to relay requests to internal hosts (SSRF).
- **Bodies up to 10 MB** are accepted; replay responses are truncated at 100 KB for display.
- `GET` / `HEAD` captures are stored without a body, matching how senders behave.

## License

[MIT](LICENSE)

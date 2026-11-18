# YukMain

Browser-based screen and tab sharing with a short code. Custom React frontend + Go room API + VDO.Ninja as the WebRTC media engine. No Windows app, OBS, or custom media server is required.

## Quickstart (Docker Compose)

Prerequisites: **Docker Desktop + Docker Compose**, and a browser with working access to `https://vdo.ninja`.

```bash
cp .env.example .env    # optional; Windows users can just skip this

docker compose up -d --build
```

Open **http://localhost:8088** in Chrome or Edge on the host computer.

### Host flow

1. Click **Mulai Berbagi**. YukMain creates a six-digit room code.
2. In the **embedded VDO.Ninja panel**, click **Share your Screen**. Select a Chrome tab, window, or entire screen and confirm the browser prompt. VDO.Ninja's embedded capture controls are intentionally visible; browsers require this interaction.
3. Once the preview is working, click **Tandai Siaran Aktif** (manual status indicator, not a capture verification).
4. Send the room code or invite link to viewers.
5. When done, click **Akhiri Room**.

### Viewer flow

1. Open the same YukMain website; enter the six digits. Or open the invite link.
2. Click **Fullscreen** to enter true browser fullscreen.
3. If audio is muted by autoplay policy, click inside the VDO.Ninja video frame. Desktop/tab audio capture depends on the host's browser, operating system, and selected source.

For a quick local test, open YukMain in two separate browser windows on the **same PC**. On the viewer side, mute audio if feedback occurs. Use headphones when testing captured audio.

## Important: local vs remote access

- Compose binds port **8088 to 127.0.0.1**, so only the current computer can reach the YukMain website by default.
- For friends in another place, you must deploy the web + API with a **public HTTPS domain** (e.g. via Coolify) or use an appropriate HTTPS tunnel. Opening `localhost:8088` on a friend's laptop will not connect to your PC.
- `localhost` is a secure context for browser capture. Ordinary LAN HTTP addresses are generally **not** accepted for screen capture; use HTTPS outside localhost.
- The VDO.Ninja engine itself still needs Internet access even during a local YukMain test. The Go backend only maps room codes to stream IDs; it does not encode, record, or relay video.

## Commands

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f
docker compose down
```

API tests (Go 1.23+):

```bash
cd api
go test ./...
go vet ./...
```

Local frontend development (Node 22+):

```bash
# Terminal 1: API
cd api && go run .

# Terminal 2: frontend
cd web && npm install && npm run dev
# Open http://localhost:5173
```

## Architecture

```text
YukMain React (host)  --POST /api/rooms--> Go API
         |                                  |
         | VDO.Ninja push URL               | code -> stream ID
         +---- WebRTC/P2P via VDO.Ninja -----+ (metadata only)
         |                                  |
YukMain React (viewer) --GET /api/rooms/123456
         |
         +---- iframe with VDO.Ninja view URL
```

No database and no Redis required for this MVP. The Go server keeps rooms in memory (server restart invalidates all rooms). Maximum room lifetime is four hours. Host heartbeat keeps the room accessible; without a heartbeat for ~90 seconds the room expires. Viewer status polling runs every 15 seconds. Multiple viewers are possible, but the host's upload bandwidth and VDO.Ninja's connectivity limit actual performance.

## Security and limitations

- **Not end-to-end access controlled by YukMain.** Six-digit codes are for convenience, **not a high-security secret**. They are rate-limited, but any person with a valid code can obtain the underlying VDO.Ninja viewer identifier. That viewer identifier can be used outside the YukMain UI until the upstream stream stops. Avoid streaming confidential desktop content.
- Only the host receives a separate random 64-character bearer token. The token is kept in `sessionStorage` to survive a reload in the same tab, and is never returned to viewers. Do not share host browser storage or URLs from the publishing iframe.
- VDO.Ninja's infrastructure controls upstream WebRTC connectivity. YukMain cannot revoke access to a previously disclosed upstream stream ID independently of VDO.Ninja. The simplest revocation mechanism is to **stop publishing** (close the host iframe or room).
- `Tandai Siaran Aktif` only indicates that the host clicked the button; it doesn't prove the video is flowing.
- Some browsers restrict display capture or audio in third-party iframes. If embedding fails, click **Buka langsung jika iframe bermasalah** in the host studio to capture through VDO.Ninja in a new browser tab; keep the YukMain host page open for heartbeat.
- Fullscreen API generally requires a viewer click. Autoplay with audio may also require viewer interaction.
- No remote keyboard/mouse/gamepad control, recording, viewer approval, account system, analytics, TURN server, or scalability guarantees in this MVP.
- Google Fonts are referenced from the public Google Fonts CSS endpoint. Remove the `@import` in `styles.css` if an entirely offline UI is required (VDO.Ninja itself still requires Internet).

## Development layout

```text
.
├── api/             # Go 1.23 API + tests, no external modules
├── web/             # React 19, TypeScript, Vite, Nginx
├── compose.yaml
├── .env.example
└── README.md
```

## References

- VDO.Ninja Iframe API: https://docs.vdo.ninja/guides/iframe-api-documentation
- Screenshare2 button for iframes: https://docs.vdo.ninja/advanced-settings/setup-parameters/and-screenshare2
- VDO.Ninja screen share guide: https://docs.vdo.ninja/guides/how-to-screen-share-in-1080p

VDO.Ninja is a third-party open-source project; YukMain is a wrapper and is not affiliated with it.

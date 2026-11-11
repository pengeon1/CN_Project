# LAN Collaborative Whiteboard {{TAG}}

**Course Project:** CS3004 — Computer Networks Practice  
**Architecture:** Offline-first LAN collaborative whiteboard built over raw TCP sockets (`net`) and UDP broadcast discovery (`dgram`) with no cloud backend, WebSockets, or HTTP frameworks.

All release binaries are self-contained and require **no Node.js installation** and **no internet access** at runtime.

---

## Downloads by Platform

| Platform                  | Server Executable               | Desktop Client                                                                                                           |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Windows (x64)**         | `whiteboard-server-win-x64.exe` | Installer: `LAN-Whiteboard-{{VERSION}}-win-x64-nsis.exe`<br/>Portable: `LAN-Whiteboard-{{VERSION}}-win-x64-portable.exe` |
| **macOS (Apple Silicon)** | `whiteboard-server-macos-arm64` | `LAN-Whiteboard-{{VERSION}}-mac-arm64.dmg` / `.zip`                                                                      |
| **macOS (Intel x64)**     | `whiteboard-server-macos-x64`   | `LAN-Whiteboard-{{VERSION}}-mac-x64.dmg` / `.zip`                                                                        |
| **Linux (x64)**           | `whiteboard-server-linux-x64`   | `LAN-Whiteboard-{{VERSION}}-linux-x64.AppImage`                                                                          |
| **Integrity Checksums**   | `SHA256SUMS.txt`                | Covers all uploaded server & client assets                                                                               |

---

## Key Highlights

- **Raw TCP Framing & Reliability**: 4-byte big-endian length-prefixed JSON envelopes with Zod validation, monotonic room sequencing (`seq`), `op_id` idempotency/deduplication, offline client outbox, heartbeat timeouts, session token resumption, and incremental gap resync.
- **Zero-Config LAN Discovery**: UDP broadcast (`45454`) auto-discovers active servers on the local subnet, with full manual IP/port connection fallback.
- **Collaborative Drawing & Diagramming**: Freehand calligraphy strokes (`perfect-freehand`), object-level eraser, rectangles and ellipses with outline + fill color customization and centered inline text, smart orthogonal connectors, arrows, straight lines, text boxes, sticky notes, and chunked image insertion.
- **Session Control & Collaboration**: Live remote cursors, smooth synchronized laser pointer, group chat with unread badge and join/leave system events, Host-driven Presentation Mode, role-based access control (`HOST` / `EDITOR` / `VIEWER`), optional `scrypt`-hashed room passwords, room locking, and Share dialog with LAN IP resolution and password sharing toggle.
- **Persistence, History & Export**: Named Version History snapshots with Host restore, Load Saved Board picker, search across board text (`Ctrl+F`), full keyboard shortcuts reference (`?`), automatic empty-room cleanup, light/dark themes, and PNG / PDF / JSON export.

---

## Quick Start (Offline LAN)

### 1. Start the Server (Host Machine)

- **Windows:** `.\whiteboard-server-win-x64.exe --port 4000 --data-dir ./data`
- **macOS (Apple Silicon / Intel):** `chmod +x ./whiteboard-server-macos-* && ./whiteboard-server-macos-arm64 --port 4000 --data-dir ./data`
- **Linux:** `chmod +x ./whiteboard-server-linux-x64 && ./whiteboard-server-linux-x64 --port 4000 --data-dir ./data`

On startup, the server prints its active LAN IPv4 addresses (for example `192.168.1.x:4000`). Run `--help` for all CLI flags (`--host`, `--port`, `--data-dir`, `--discovery-port`, `--no-discovery`, `-v`).

### 2. Launch Clients (Participants)

1. Open `LAN Whiteboard` on each participant's computer on the same LAN.
2. Select a server from **Find servers on this network** (or enter the server IP and port manually).
3. **Create Room** as Host or **Join Room** with the 6-character code (and password if protected).

---

## First-Run Firewall, SmartScreen & Gatekeeper Notes

Because these are unsigned academic project builds:

- **Firewall Ports**: Allow inbound **TCP `4000`** (whiteboard traffic) and **UDP `45454`** (optional LAN discovery) on the server machine (`Private networks` on Windows Defender Firewall, `Allow` on macOS, or `ufw`/`firewalld` on Linux).
- **Windows SmartScreen**: Click **More info -> Run anyway** if prompted ("Windows protected your PC").
- **macOS Gatekeeper**: Drag `LAN Whiteboard.app` into `/Applications`, then **right-click -> Open -> Open** once (or run `xattr -dr com.apple.quarantine "/Applications/LAN Whiteboard.app"`). For the server CLI, run `xattr -d com.apple.quarantine ./whiteboard-server-macos-*` after `chmod +x`.
- **Linux AppImage**: Run `chmod +x LAN-Whiteboard-{{VERSION}}-linux-x64.AppImage`. If FUSE is unavailable, pass `--appimage-extract-and-run` (and `--no-sandbox` if user namespaces are restricted).

---

## Verify Checksums

- **Linux / macOS:** `sha256sum -c SHA256SUMS.txt --ignore-missing` (or `shasum -a 256 -c SHA256SUMS.txt` on macOS)
- **Windows PowerShell:** `Get-FileHash <downloaded-file> -Algorithm SHA256` and compare against `SHA256SUMS.txt`.

Full documentation is available in [Packaging & First-Run Guide](https://github.com/pengeon1/CN_Project/blob/{{TAG}}/docs/packaging.md), [User Guide](https://github.com/pengeon1/CN_Project/blob/{{TAG}}/docs/user_guide.md), and [Technical Documentation (PDF)](https://github.com/pengeon1/CN_Project/blob/{{TAG}}/docs/technical_documentation.pdf).

# LAN Multi-User Real-Time Collaborative Whiteboard

[![Course: CS3004](https://img.shields.io/badge/Course-CS3004_Computer_Networks_Practice-blue.svg)](#)
[![CI](https://github.com/pengeon1/CN_Project/actions/workflows/ci.yml/badge.svg)](https://github.com/pengeon1/CN_Project/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/pengeon1/CN_Project)](https://github.com/pengeon1/CN_Project/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A standalone, high-performance, real-time collaborative whiteboard built from scratch for Local Area Networks (LAN). Developed for **CS3004 — Computer Networks Practice**, it operates strictly over raw **TCP/IP socket programming** (`net`) and **UDP LAN discovery** (`dgram`) without external cloud infrastructure, WebSockets, or HTTP frameworks, ensuring 100% functionality with internet connectivity completely disabled.

---

## Architecture Overview

```text
+-------------------------------------------------------+
|                     TCP Server                        |
|   (Node.js 'net' module, Session & State Engine)      |
+-------------------------------------------------------+
       ^                           ^               ^
       | Raw TCP                   | Raw TCP       | Raw TCP
       v                           v               v
+------------------+      +------------------+    ...
| Client 1         |      | Client 2         |
| (Electron/React) |      | (Electron/React) |
+------------------+      +------------------+
```

- **Server**: Centralized coordinator implemented with Node.js built-in `net` module. Manages room state, monotonically increasing sequence numbers (`seq`), event broadcasting, idempotency via client `op_id`, and LAN discovery (`dgram`).
- **Client**: Cross-platform desktop application built on Electron, React 18, Vite, and Tailwind CSS. All networking runs exclusively in Electron's Main process over raw Node `net` sockets; the UI renderer remains responsive and communicates with the main process over a strongly-typed IPC preload bridge.
- **Protocol**: Custom binary framing (4-byte big-endian unsigned length prefix + UTF-8 JSON envelope).
- **Reliability**: Every room event carries a gap-free server sequence number. Clients deliver events exactly once and in order, repair gaps by resync, retransmit un-acknowledged operations after a reconnect (the server de-duplicates by `op_id`), and resume their identity with a session token after a dropped connection. See [`docs/protocol.md`](docs/protocol.md) §5 and §7.

---

## Downloads & Standalone Deployment

Prebuilt, self-contained executables (server + desktop client for Windows, Linux, and macOS) are published on the [GitHub Releases](https://github.com/pengeon1/CN_Project/releases) page alongside `SHA256SUMS.txt`. They require **no Node.js installation** and **no internet access** once downloaded.

| Platform                          | Server Executable                        | Desktop Client                                                             |
| --------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- |
| **Windows (x64)**                 | `whiteboard-server-win-x64.exe`          | `LAN-Whiteboard-<version>-win-x64-nsis.exe` (installer) or `-portable.exe` |
| **macOS (Apple Silicon / Intel)** | `whiteboard-server-macos-arm64` / `-x64` | `LAN-Whiteboard-<version>-mac-<arch>.dmg` or `.zip`                        |
| **Linux (x64)**                   | `whiteboard-server-linux-x64`            | `LAN-Whiteboard-<version>-linux-x64.AppImage`                              |

### Running Downloaded Binaries (No Build Needed)

1. **Start the server** on one machine on the LAN:
   ```bash
   # Linux / macOS (make executable once)
   chmod +x ./whiteboard-server-*
   ./whiteboard-server-linux-x64 --port 4000 --data-dir ./data

   # Windows PowerShell
   .\whiteboard-server-win-x64.exe --port 4000 --data-dir ./data
   ```
   The server prints its active LAN IPv4 addresses (e.g. `192.168.1.x:4000`). Allow inbound **TCP `4000`** (and **UDP `45454`** for auto-discovery) if prompted by your firewall.
2. **Launch the client** (`LAN Whiteboard`) on participant machines, pick the server under **Find servers on this network** (or enter its IP/port manually), and create or join a room with the 6-character code (+ optional password).

See [`docs/packaging.md`](docs/packaging.md) for checksum verification, local packaging commands, and first-run Windows SmartScreen / macOS Gatekeeper / Linux FUSE instructions.

```bash
npm run package:server && npm run package:client   # build standalone executables locally
```

---

## Key Features

- **Real-Time Canvas & Diagramming**: Smooth calligraphy pen (`perfect-freehand`), object-level eraser, rectangles and ellipses (with outline colors, fill colors, and centered inline text), smart orthogonal connectors anchored to shapes, arrows, straight lines, resizable text boxes, sticky notes, and chunked image insertion (PNG/JPEG/WebP/GIF/BMP).
- **Session Control & Access Security**: Unambiguous 6-character room codes, optional `scrypt`-hashed room passwords with brute-force IP rate limiting, role-based access control (`HOST` / `EDITOR` / `VIEWER`), room locking, Share modal with LAN IP detection and password toggle, and automatic cleanup of expired empty rooms.
- **Live Presence, Presentation & Chat**: Color-coded remote cursors, Host-driven Presentation Mode with synchronized viewport and smooth laser pointer, chronological group chat with unread badges, and Host participant moderation.
- **Reliability & Persistence**: Length-prefixed TCP framing, monotonic server sequencing (`seq`), `op_id` deduplication, per-user isolated undo/redo, offline outbox, heartbeat watchdogs, session token reconnection with incremental gap resync, named Version History snapshots, server save/load selector, board text search (`Ctrl+F`), full shortcuts modal (`?`), light/dark themes, and PNG / PDF / JSON export.

---

## Tech Stack

| Layer              | Technology                                                               |
| ------------------ | ------------------------------------------------------------------------ |
| **Language**       | TypeScript (Strict mode across all workspaces)                           |
| **Monorepo**       | npm workspaces (`packages/common`, `packages/server`, `packages/client`) |
| **Networking**     | Node.js `net` (raw TCP) + `dgram` (UDP LAN broadcast)                    |
| **Desktop Client** | Electron 45, React 18, Vite 6, Tailwind CSS                              |
| **Canvas Engine**  | Custom HTML5 Canvas 2D renderer with `perfect-freehand`                  |
| **State & Icons**  | Zustand, Lucide React                                                    |
| **Testing**        | Vitest (184 unit & real-socket tests across 26 suites + lossy TCP proxy) |
| **Packaging**      | `@yao-pkg/pkg` (Server binary), `electron-builder` (Client installers)   |

---

## Repository Structure

```text
CN_Project/
├── packages/
│   ├── common/           # Shared types, binary framing encode/decode, Zod schemas, constants
│   ├── server/           # TCP server, room registry, state log, broadcasting, session recovery
│   └── client/           # Electron main process (TCP manager, IPC) & React renderer canvas UI
├── tests/                # Multi-client integration test suites & network lossiness harness
├── docs/                 # Architecture, protocol specification, and user manual
├── scripts/              # Build, release, and packaging automation
└── .github/workflows/    # 3-OS GitHub Actions CI/CD matrix (Ubuntu, Windows, macOS)
```

---

## Prerequisites (Building from Source)

- **Node.js**: Version 20.x, 22.x, or 24.x LTS
- **npm**: Version 10.x or higher
- **Git**

---

## Quick Start

### 1. Installation

Clone the repository and install all workspace dependencies:

```bash
git clone https://github.com/pengeon1/CN_Project.git
cd CN_Project
npm install
```

### 2. Start the Server

Start the standalone TCP server on the local machine:

```bash
npm run server
```

By default, the server binds to `0.0.0.0:4000` and prints its active IPv4 LAN addresses.

### 3. Start the Client

Launch the Electron client application:

```bash
npm run client
```

---

## Development & Verification

| Command                | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| `npm run build`        | Compiles all packages (`common`, `server`, `client`)             |
| `npm test`             | Runs all 26 Vitest test suites (184 tests) across the monorepo   |
| `npm run typecheck`    | Runs strict TypeScript checks across all workspaces              |
| `npm run lint`         | Lints TypeScript and React source files                          |
| `npm run format:check` | Verifies formatting rules with Prettier                          |
| `npm run format`       | Auto-formats codebase with Prettier                              |
| `npm run package:all`  | Builds standalone server binary & desktop client installer       |
| `npm run smoke:server` | Smoke-tests a packaged server binary (TCP handshake + discovery) |

---

## Documentation

- [`docs/technical_documentation.pdf`](docs/technical_documentation.pdf) — Complete CS3004 technical report & user guide (source: [`docs/technical_documentation.md`](docs/technical_documentation.md))
- [`docs/user_guide.md`](docs/user_guide.md) — End-user setup, tools, shortcuts, and troubleshooting manual
- [`docs/architecture.md`](docs/architecture.md) — System topology, concurrency model, sync, and security design
- [`docs/protocol.md`](docs/protocol.md) — Wire framing, schemas, state recovery, and UDP discovery protocol
- [`docs/packaging.md`](docs/packaging.md) — Standalone executable build, CI/CD release pipeline, and first-run OS guide
- [`docs/presentation.md`](docs/presentation.md) — Slide-by-slide CS3004 presentation script and screenshot checklist

---

## License

This project is licensed under the [MIT License](LICENSE).

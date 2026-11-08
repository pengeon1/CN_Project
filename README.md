# LAN Multi-User Real-Time Collaborative Whiteboard

[![CI](https://github.com/pengeon1/CN_Project/actions/workflows/ci.yml/badge.svg)](https://github.com/pengeon1/CN_Project/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A standalone, high-performance, real-time collaborative whiteboard built from scratch for Local Area Networks (LAN). Designed and developed as a university Computer Networks lab project, it operates strictly over raw **TCP/IP socket programming** without external cloud infrastructure, WebSockets, or HTTP frameworks, ensuring 100% functionality with internet connectivity completely disabled.

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

## Tech Stack

| Layer              | Technology                                                               |
| ------------------ | ------------------------------------------------------------------------ |
| **Language**       | TypeScript (Strict mode across all workspaces)                           |
| **Monorepo**       | npm workspaces (`packages/common`, `packages/server`, `packages/client`) |
| **Networking**     | Node.js `net` (raw TCP) + `dgram` (UDP LAN broadcast)                    |
| **Desktop Client** | Electron 33+, React 18, Vite, Tailwind CSS                               |
| **Canvas Engine**  | Custom HTML5 Canvas 2D renderer with `perfect-freehand`                  |
| **State & Icons**  | Zustand, Lucide React                                                    |
| **Testing**        | Vitest (unit & real socket integration tests), Playwright                |
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

## Prerequisites

- **Node.js**: Version 20.x or 24.x LTS
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

| Command                | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `npm run build`        | Compiles all packages (`common`, `server`, `client`) |
| `npm test`             | Runs all Vitest test suites across the monorepo      |
| `npm run lint`         | Lints TypeScript and React source files              |
| `npm run format:check` | Verifies formatting rules with Prettier              |
| `npm run format`       | Auto-formats codebase with Prettier                  |

---

## License

This project is licensed under the [MIT License](LICENSE).

# ROLE
You are a senior engineer building a university Computer Networks lab project with a team of students. Work in small, reviewable phases. Do ONE phase at a time, then stop, summarize what you did, show how to run/test it, and wait for my "continue" before starting the next phase.

# ATTACHED FILES
1. CN_Lab_Project_Instructions.pdf - the official assignment. Treat every requirement in it as mandatory. Re-read it before each phase.
2. image.png - the target UI/design reference (a modern whiteboard app in the style of Figma/FigJam).

# PROJECT SUMMARY
Build a LAN-based, multi-user, real-time collaborative whiteboard with a central server and multiple clients. All essential communication must use TCP socket programming (no WebSocket libraries, no HTTP frameworks, no Socket.IO, no Firebase, no cloud services). It must work with the internet fully disabled. It must be cross-platform (Windows, Linux, macOS) and ship as standalone executables for both server and client.

# TECH STACK (fixed; do not substitute without asking me first)
- Language: TypeScript (strict mode) everywhere.
- Monorepo: npm workspaces with three packages: `packages/common`, `packages/server`, `packages/client`.
- Server: Node.js 20+ using the built-in `net` module (raw TCP) and `dgram` (UDP discovery). No networking frameworks. Bundle with esbuild and package into a standalone executable with `@yao-pkg/pkg` (targets: win-x64, linux-x64, macos-arm64 and macos-x64).
- Client: Electron + React 18 + Vite + Tailwind CSS. Canvas drawing uses a custom HTML5 Canvas 2D renderer (use `perfect-freehand` for smooth strokes; do not use heavy whiteboard libraries like tldraw or Excalidraw because the assignment evaluates our own implementation).
- Client networking: raw TCP runs in Electron's MAIN process using Node `net` (renderer has no Node access: contextIsolation on, nodeIntegration off, a typed preload bridge exposing only the needed IPC channels). The UI thread must never block on the network.
- Shared: `packages/common` holds message types, framing encode/decode, zod schemas for validation, constants and shared data models, imported by both server and client.
- State management in the renderer: Zustand. Icons: lucide-react.
- Testing: Vitest (unit and integration tests, including multi-client server tests using real sockets), Playwright for one Electron smoke test.
- Lint/format: ESLint + Prettier. Husky or lint-staged are optional.
- Client packaging: electron-builder (Windows NSIS + portable .exe, macOS .dmg/.zip, Linux AppImage).
- CI/CD: GitHub Actions with an OS matrix (windows-latest, ubuntu-latest, macos-latest) running lint, tests and builds, uploading executables as artifacts, and a release workflow triggered by tags.

# REPOSITORY
Remote: https://github.com/pengeon1/CN_Project
- The default and primary branch MUST be named `main` (not master). If the local repo uses another name, run `git branch -M main` and push with `-u origin main`. Set `init.defaultBranch main` in the setup instructions.
- If the repo is empty, initialize it. If you cannot push, give me the exact git commands to run.
- Layout:
    README.md, LICENSE, package.json (workspaces), tsconfig.base.json, .gitignore, .editorconfig, CONTRIBUTING.md
    packages/common/src   (protocol, framing, message types, schemas, constants, models)
    packages/server/src   (sessions, rooms, state, broadcast, persistence, auth, discovery)
    packages/client/electron   (main process: TCP connection manager, preload, IPC)
    packages/client/src   (renderer: components/, canvas/, tools/, store/, hooks/, styles/)
    tests/                (cross-package integration tests, lossy-network harness)
    docs/                 (architecture.md, protocol.md, user_guide.md, diagrams/, reference/, AI_PROMPT.md)
    scripts/              (build and helper scripts)
    .github/workflows/    (ci.yml, release.yml)
- Git workflow: `main` is protected in spirit: it must always build and run. Phases 0-3 may be committed on `main` after my approval; from Phase 4 onward every phase is developed on its own branch `feature/<NN>-<name>`, with small clear commits (Conventional Commits style: feat:, fix:, docs:, test:, chore:), then I open a PR into `main` and merge manually. Never force-push `main`. Each phase branch must start from the latest `main`. Document all of this in CONTRIBUTING.md, including how teammates rebase/merge, PR checklist (tests pass, docs updated, no console errors), and the branch naming rules.
- Keep modules small and well commented (the assignment requires commented source). Add TSDoc comments to every exported type and function, and write comments that explain WHY, not just what.

# UI DESIGN (follow the attached image closely)
- Top bar: back/leave button, session title with "last saved" text, a stack of participant avatars (colored circles with initials, unique color per user), a find button, a chat toggle with an unread badge, and a prominent blue "Share" button that shows the server LAN IP, port, room code and copy buttons.
- Left floating dark vertical toolbar: select, pen, eraser, shapes, text, image, sticky note, line/arrow, connector, and an overflow menu.
- Center: canvas with a subtle dot-grid background, pan (space+drag or middle mouse) and zoom (ctrl+wheel / pinch), with a zoom percentage control at the bottom right (- / 62% / +).
- Bottom floating dark property bar that appears for the active tool or selection: color swatches, stroke width, fill/no-fill, font, size, bold, italic, align.
- Right panel (dark blue): replaces "Comments" with GROUP CHAT: bubbles with avatar, username, timestamp, input "Write a message", green Send button, and a tab to switch between "Chat" and "Participants".
- Show remote users' live cursors with name labels in their color, and make strokes attributable to their author (user color accent or hover tooltip).
- Light theme by default with a dark theme toggle, using design tokens (Tailwind theme + CSS variables) so styling stays consistent. Usable at 1280x720 and responsive on resize.
- Smooth rendering: use requestAnimationFrame, redraw only dirty regions or layers (static committed layer + live layer), and handle devicePixelRatio.

# PROTOCOL (design in Phase 1, document in docs/protocol.md)
Transport: TCP. Justify why (reliable ordered byte stream, no need to reinvent retransmission, simpler consistency than UDP) and explain what must still be handled at the application layer.
Framing: 4-byte big-endian unsigned length prefix + UTF-8 JSON body. Enforce a max frame size (e.g. 8 MB; images are sent in chunks) and reject oversize or malformed frames. The decoder must handle partial reads and multiple frames per chunk.
Envelope for every message:
    { "v": 1, "type": "<MESSAGE_TYPE>", "msg_id": "<uuid>", "seq": <int, server-assigned for sequenced ops>, "ts": <server epoch ms>, "room": "<room code>", "user_id": "<uuid>", "payload": { ... } }
Message types (at minimum): HELLO, AUTH_OK, AUTH_FAIL, CREATE_ROOM, JOIN_ROOM, LEAVE_ROOM, ROOM_STATE (full snapshot + latest seq), PARTICIPANT_JOINED, PARTICIPANT_LEFT, PARTICIPANT_LIST, STROKE_BEGIN, STROKE_POINTS (batched), STROKE_END, SHAPE_ADD, OBJECT_UPDATE, OBJECT_DELETE, ERASE (by object id), CLEAR_CANVAS, UNDO, REDO, CURSOR_MOVE (throttled, not persisted), CHAT_MESSAGE, CHAT_HISTORY, PING, PONG, ACK, RESYNC_REQUEST, RESYNC_RESPONSE, SAVE_STATE, LOAD_STATE, ERROR, PERMISSION_CHANGE.
Ordering and reliability (document precisely):
- The server is the single source of truth and assigns a monotonically increasing `seq` per room to every accepted operation. Clients apply operations strictly in `seq` order.
- Each client op carries a client-generated `op_id`. The server de-duplicates by op_id (idempotent), so retries and duplicates are harmless.
- Clients render their own strokes optimistically, then reconcile when the server echoes the op with its seq.
- If a client detects a gap in seq, it sends RESYNC_REQUEST with its last applied seq; the server replies with the missing ops, or a full snapshot if the gap is too large.
- Out-of-order ops are buffered briefly, then trigger a resync.
- Stroke points are batched (every ~16-33 ms) to cut traffic. Cursor moves are throttled and never persisted.
Undo/redo semantics (define clearly and document):
- Each user has their own undo/redo stack with only their own operations. Undo creates a new compensating UNDO operation referencing the target op_id, which is sequenced and broadcast so all clients converge. Undo never removes another user's work. If the target was already deleted or cleared by someone else, undo is a no-op and the user is told. A new operation by a user clears that user's redo stack.
Connection management:
- PING/PONG heartbeat every 5 s; the server drops a client after 15 s of silence and broadcasts PARTICIPANT_LEFT; the room stays alive.
- Reconnect: the client keeps a session token; on reconnect it re-authenticates, sends its last seq, and gets missing ops or a full snapshot, then resumes. Auto-reconnect with exponential backoff and a visible "reconnecting..." banner.
Security / access control:
- Room code (6 chars, unambiguous alphabet) + optional room password. Store only a salted hash (Node `crypto.scrypt`). Rate-limit failed attempts per IP.
- Roles: HOST, EDITOR, VIEWER. The server validates every operation against the sender's role. Viewers cannot mutate. Only HOST can clear the canvas, kick users, change roles, and lock the room. The server never trusts the client: validate every message with zod (schema, ranges, sizes, point counts).

# PHASED PLAN (do exactly in this order; one branch per phase; stop after each)

PHASE 0 - Foundation (branch: main, after my approval)
Monorepo, tsconfig, ESLint/Prettier, Vitest, CONTRIBUTING.md, README skeleton, CI on 3 OSes, `main` as default branch. A "hello" run: `npm run server` starts a TCP server and `npm run client` opens an Electron window on all OSes. Acceptance: CI green on Windows, Linux and macOS.

PHASE 1 - Protocol and framing (branch: feature/01-protocol)
`packages/common`: frame encode/decode, envelope types, zod schemas, message type enum, constants. Unit tests for fragmentation, coalescing, oversize and malformed frames. Write docs/protocol.md. Acceptance: tests pass; docs list every message type with example JSON.

PHASE 2 - Server core: sessions and participants (branch: feature/02-server-core)
TCP server, room creation with a room code, join by code, participant registry, join/leave notifications, per-room seq counter, clean per-connection teardown, structured logging, CLI flags (`--host`, `--port`, `--data-dir`). Print the server's LAN IPv4 addresses at startup. Acceptance: integration tests with multiple real socket clients creating/joining rooms and seeing join/leave events.

PHASE 3 - Client shell and UI per the design image (branch: feature/03-client-ui)
Electron main/preload/renderer, the full layout from the image (top bar, left toolbar, dot-grid canvas with pan/zoom, property bar, right chat/participants panel), connect dialog (server IP, port, username, host or join, room code/password), and the main-process TCP connection manager with typed IPC. Acceptance: close visual match to the design, works at 1280x720, can host/join a room against the real server.

PHASE 4 - Real-time freehand drawing and shared canvas (branch: feature/04-drawing-sync)
Pen tool with color and width, batched STROKE_* messages, server validation and sequencing, broadcast, optimistic rendering with reconciliation, remote cursors with name labels, per-user attribution. Acceptance: three clients drawing simultaneously with no lost or duplicated strokes.

PHASE 5 - Eraser and canvas clear (branch: feature/05-eraser-clear)
Stroke-level eraser (by object id with hit testing), CLEAR_CANVAS restricted to HOST with a confirmation dialog. Acceptance: erases and clears converge on all clients.

PHASE 6 - Late-join state sync (branch: feature/06-state-sync)
Server-side whiteboard model (ordered ops log + materialized object map), ROOM_STATE snapshot on join, periodic log compaction. Acceptance: a client joining mid-session sees the full existing board immediately.

PHASE 7 - Chat (branch: feature/07-chat)
Group chat with username, timestamp, chronological history (server keeps and sends the last N messages on join), unread badge, system messages for join/leave. Acceptance: all requirements from section 4 of the PDF.

PHASE 8 - Reliability: heartbeat, timeouts, reconnection, resync (branch: feature/08-reliability)
Everything in "Ordering and reliability" and "Connection management". Build a lossy-proxy test harness that injects delay, duplicates, drops and reordering and proves all clients converge. Acceptance: cutting a client's network mid-draw and reconnecting yields a canvas identical to everyone else's.

PHASE 9 - Undo/redo (branch: feature/09-undo-redo)
Per-user undo/redo with the semantics above, Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z / Ctrl+Y, tested with concurrent users. Acceptance: documented behavior matches tests.

PHASE 10 - Persistence (branch: feature/10-persistence)
Server autosave of each room as JSON in `--data-dir`, restore on restart, manual Save/Load (host), and client-side "export board as .json". Acceptance: restart the server, rejoin the room, board restored.

PHASE 11 - Security and roles (branch: feature/11-security-roles)
Room passwords (scrypt-hashed), failed-attempt rate limiting, HOST/EDITOR/VIEWER roles enforced server-side, kick, lock room, role-change UI in the participants panel. Acceptance: a viewer or unauthenticated client cannot mutate the board, proven by tests.

PHASE 12 - Shapes, lines, arrows, text, sticky notes (branch: feature/12-shapes-text-notes)
Rectangle, ellipse, line, arrow, text box, sticky notes; select/move/resize/delete/recolor with synced OBJECT_UPDATE ops; z-order; last-writer-wins per property ordered by seq. Acceptance: concurrent edits of different objects never conflict; same-object conflicts resolve deterministically.

PHASE 13 - Image insertion and export (branch: feature/13-images-export)
Insert images (chunked transfer, size limit, client-side downscale), export board as PNG and PDF. Acceptance: images appear on all clients including late joiners.

PHASE 14 - Presentation mode, laser pointer, version history (branch: feature/14-extras)
Host-driven presentation mode (everyone follows the host viewport), laser pointer, periodic named snapshots with host-only restore. Optional: connectors for flowcharts/mind maps, minimap, find-on-board.

PHASE 15 - LAN discovery (branch: feature/15-discovery)
UDP broadcast discovery via `dgram` so clients can list servers on the LAN automatically, with manual IP entry as fallback. Acceptance: works with the internet disabled.

PHASE 16 - Packaging and cross-platform builds (branch: feature/16-packaging)
`pkg` build of the server and electron-builder build of the client for Windows, Linux and macOS, via the GitHub Actions matrix, plus a tag-triggered release workflow. Document first-run firewall prompts and macOS Gatekeeper / Windows SmartScreen steps for unsigned apps. Acceptance: downloaded artifacts run on a clean machine with the internet disabled.

PHASE 17 - Documentation (branch: feature/17-docs)
docs/ technical documentation covering system architecture, application-level message format, socket communication, synchronization strategy, concurrency handling and recovery, plus a User Guide (configuring the server, connecting clients over the LAN, creating/joining sessions, using each tool). Include Mermaid diagrams (architecture, sequence diagrams for join, draw, reconnect). Also produce an outline for the PPT with a slide-by-slide plan and a list of screenshots to capture.

# CONCURRENCY RULES (server)
- Node's single-threaded event loop: process ops per room through a serial queue so they are sequenced one at a time; no shared mutable state mutated outside that queue.
- Never block the loop; use async fs APIs for disk writes and debounce autosave.
- A slow client must not stall others: give each client a bounded outgoing queue and respect socket backpressure (`write()` return value and the 'drain' event). On overflow drop cursor events first; if still full, disconnect the client and let it resync.

# QUALITY RULES
- Each phase must include tests and updated docs and leave `main`-compatible, runnable code.
- Do not add features out of order. Do not refactor unrelated code during a phase.
- After each phase give me: (1) what changed, (2) how to run it, (3) how to test it, (4) known limitations, (5) the exact git commands to commit, push, and open a PR into `main`.
- If any requirement in the PDF is ambiguous, ask me before assuming.

# START
Begin with PHASE 0 only. Before writing code, show me a short plan (file tree + key decisions) and wait for my approval.

# Presentation (PPT) Slide-by-Slide Plan & Video Guide

This document provides a slide-by-slide script, visual diagram references, and an exact list of application screenshots to capture for the project presentation and explanation video required by the **Computer Networks Lab Project Specifications**.

---

## 1. Overview & Evaluation Alignment

- **Required Deliverable**: PowerPoint Presentation (`.pptx` or `.pdf`) and Recorded Video Explanation.
- **Evaluation Criteria**: Network Architecture, Application Protocol Design, UI/UX Completeness, Concurrency & State Synchronization, Reliability & Fault Tolerance, and Individual Contributions.

---

## 2. Slide-by-Slide Outline & Speaker Script

### Slide 1: Title & Team Introduction

- **Slide Title**: LAN-Based Multi-User Real-Time Collaborative Whiteboard
- **Subtitle**: Computer Networks Laboratory Course Project | Fall 2026
- **Content Elements**:
  - Project Title & High-level Description.
  - Team Member Names, Student IDs, and Designated Technical Roles:
    - _Member 1_: Network Architecture, Socket Programming & Protocol Design.
    - _Member 2_: Concurrency Control, State Synchronization & Consistency Engine.
    - _Member 3_: Fault Tolerance, Reconnection, Reliability Harness & Persistence.
    - _Member 4_: Client Engine, Canvas Graphics Rendering & User Interface.
- **Visual Assets**: Application logo, university insignia, and a hero screenshot of the multi-user whiteboard canvas.
- **Speaker Notes**:
  > "Hello everyone. Today our team is presenting our Computer Networks lab project: a LAN-based, multi-user real-time collaborative whiteboard. Our system enables multiple participants across a local network to draw, annotate, chat, and collaborate simultaneously on a digital canvas without any internet connection, cloud services, or external web frameworks."

---

### Slide 2: Problem Statement & Engineering Challenges

- **Slide Title**: Problem Statement & Technical Constraints
- **Content Elements**:
  - **Mandatory Requirements**:
    - Complete operation on a local area network (LAN) with **zero internet connectivity**.
    - Strict adherence to raw **TCP socket programming** (prohibiting HTTP, WebSockets, Socket.IO, Firebase).
    - Multi-user real-time coordination with minimal latency.
    - Cross-platform standalone executables (Windows, Linux, macOS).
  - **Core Distributed System Challenges**:
    - TCP byte-stream fragmentation and coalescing at the application layer.
    - Maintaining strong eventual consistency across concurrent edits without central databases.
    - Handling silent disconnections, heartbeat timeouts, and session resumptions.
- **Speaker Notes**:
  > "In university labs, collaborative software often relies on cloud APIs like Firebase or WebSockets. Our assignment required building everything from first principles using raw TCP sockets in Node.js and Electron. When internet is disabled, we face fundamental distributed systems challenges: message boundaries, race conditions, concurrency conflicts, and network partitions."

---

### Slide 3: Network Architecture & Topology

- **Slide Title**: Client-Server Architecture & Transport Selection
- **Content Elements**:
  - Centralized Client-Server model over TCP/IP sockets.
  - **Transport Protocol Decision (Why TCP?)**:
    - In-kernel reliability: automatic packet retransmission (ARQ) and checksums.
    - Byte ordering guarantees: eliminating packet reordering anomalies.
    - Flow control: sliding window prevents receiver buffer overflows during state snapshot bursts.
  - **UDP for Zero-Config LAN Discovery**:
    - Short-lived UDP broadcast (`dgram` port `45454`) enables clients to discover active servers automatically without entering IP addresses.
- **Diagram Reference**: Embed [`docs/diagrams/architecture.mermaid`](diagrams/architecture.mermaid).
- **Speaker Notes**:
  > "Here is our high-level architecture. We opted for a centralized server model. Why TCP? Because whiteboard mutations like adding shapes, deleting items, or clearing the board cannot tolerate packet loss. Dropping an erase event in UDP causes permanent divergence. Meanwhile, we leverage UDP broadcast strictly for LAN discovery, giving users a zero-configuration experience."

---

### Slide 4: Application Protocol & Binary Length-Prefixed Framing

- **Slide Title**: Protocol Design & Wire Framing Specification
- **Content Elements**:
  - **The TCP Streaming Dilemma**:
    - TCP is stream-oriented, not packet-oriented. Chunks can arrive fragmented or coalesced.
  - **Binary Framing Format**:
    - 4-byte unsigned Big-Endian length header ($L$) + $L$ bytes of UTF-8 JSON payload.
    - Enforcement of an 8 MB maximum frame boundary to prevent memory exhaustion attacks.
  - **Universal Message Envelope**:
    - `{ v: 1, type, msg_id, seq, ts, room, user_id, payload }`.
    - Strict validation using Zod schemas for all inbound envelopes.
- **Visual Assets**: Visual diagram of the 4-byte header byte structure (from Protocol Spec §2).
- **Speaker Notes**:
  > "Because TCP is a byte stream, chunks from the socket can split a message in half or combine two messages together. To solve this, we implemented a custom binary framing layer: a 4-byte big-endian unsigned integer prefix indicating the exact payload length. Every message is wrapped in a versioned envelope and validated against strict Zod schemas."

---

### Slide 5: Server Concurrency & Task Serialization

- **Slide Title**: Server Concurrency: Queue-Based Event Loop
- **Content Elements**:
  - Single-threaded event loop architecture (Node.js).
  - **Per-Room FIFO Task Queue**:
    - Promise-chained task executor (`room.enqueue(task)`).
    - Guarantees serialized execution of mutations: one operation finishes before the next begins.
    - Zero lock contention, deadlocks, or thread synchronization overhead.
  - Non-blocking asynchronous disk writes with debounced timers (300ms) and atomic file replacement (`fs.rename`).
  - Socket backpressure handling: monitoring `socket.write()` return values and the `'drain'` event.
- **Visual Assets**: Flowchart showing Inbound Socket $\rightarrow$ Frame Decoder $\rightarrow$ Zod Validation $\rightarrow$ Room FIFO Queue $\rightarrow$ Mutate & Broadcast.
- **Speaker Notes**:
  > "To process concurrent edits from multiple users without race conditions, each room executes mutations through a FIFO task queue on Node's single-threaded event loop. Operations are sequenced one at a time. Furthermore, we protect against slow clients by respecting socket backpressure, dropping non-critical cursor events if socket buffers fill up."

---

### Slide 6: State Synchronization & Consistency Model

- **Slide Title**: Synchronization Strategy & Eventual Consistency
- **Content Elements**:
  - **Global Monotonic Sequence Counter (`seq`)**:
    - Server acts as the single source of truth, assigning continuous positive integers ($1, 2, 3 \dots$).
  - **Idempotency via `op_id`**:
    - Every client operation carries a unique UUIDv4. Duplicate operations caused by retries are filtered out.
  - **Optimistic Client Rendering**:
    - Local operations render immediately with zero latency.
    - Reconciled against server echoes upon receiving the sequenced confirmation.
  - **Last-Writer-Wins (LWW) Property Resolution**:
    - Concurrent property updates (color, position, dimensions) resolve deterministically based on server `seq`.
- **Diagram Reference**: Embed [`docs/diagrams/sequence_draw.mermaid`](diagrams/sequence_draw.mermaid).
- **Speaker Notes**:
  > "For real-time feel, clients render strokes optimistically. As the user moves the pen, points are batched every 16 to 33 milliseconds to reduce network overhead. When the server receives the stroke, it assigns the next monotonic sequence number and broadcasts it. All peers apply operations strictly in sequence order, ensuring guaranteed state convergence."

---

### Slide 7: Late-Join Synchronization & Memory Compaction

- **Slide Title**: Late-Join State Transfer & Log Compaction
- **Content Elements**:
  - **The Late Joiner Challenge**:
    - Replaying thousands of raw stroke points to new users is slow and saturates the network.
  - **Materialized Object State**:
    - Server maintains an in-memory materialized object dictionary of all live entities.
    - On `JOIN_ROOM`, server transmits a single compressed `ROOM_STATE` snapshot.
  - **Log Compaction**:
    - Server keeps an operation log of recent events for incremental resyncs.
    - Periodic compaction prunes history past a threshold (1,000 ops), keeping memory usage flat.
- **Diagram Reference**: Embed [`docs/diagrams/sequence_join.mermaid`](diagrams/sequence_join.mermaid).
- **Speaker Notes**:
  > "When a participant joins mid-session, they shouldn't wait through thousands of drawing events. The server maintains a materialized snapshot of the canvas. Late joiners receive the current board state in a single snapshot payload, instantly catching up with the session."

---

### Slide 8: Reliability, Reconnection & Fault Tolerance

- **Slide Title**: Connection Watchdog, Reconnection & Resync
- **Content Elements**:
  - **Heartbeat Monitor**:
    - 5-second `PING` / `PONG` exchanges.
    - Drops dead clients after 15 seconds of silence without terminating the room.
  - **Session Takeover via Session Tokens**:
    - Clients receive a cryptographically random session token.
    - Reconnecting clients present this token to reclaim their participant profile and permissions.
  - **Incremental Gap Repair (`RESYNC_REQUEST`)**:
    - If a client detects a missing sequence number, it requests only the missing slice.
  - **Client Outbox Buffer**:
    - Mutations drawn while offline are buffered and retransmitted once reconnected.
- **Diagram Reference**: Embed [`docs/diagrams/sequence_reconnect.mermaid`](diagrams/sequence_reconnect.mermaid).
- **Speaker Notes**:
  > "Real LAN networks have hiccups—loose cables, laptop lids closing, or Wi-Fi drops. Our heartbeat watchdog detects dead sockets in 15 seconds. If a connection drops, the client automatically backs off and reconnects, uses a session token to resume without creating duplicate users, and fetches only the missed operations via sequence gap resync."

---

### Slide 9: Multi-User Undo/Redo Architecture

- **Slide Title**: Isolated Per-User Undo/Redo Semantics
- **Content Elements**:
  - **The Problem with Global Undo**:
    - In a collaborative canvas, global undo (`Ctrl+Z`) would erase someone else's work, frustrating users.
  - **Our Solution: Per-User Isolated Stacks**:
    - Alice's undo stack contains _only_ Alice's operations.
    - Bob's undo stack contains _only_ Bob's operations.
  - **Compensating Operations**:
    - Undo creates a new forward-sequenced compensating operation referencing the target `op_id`.
    - If the target object was already deleted or modified by another peer, the undo safely aborts as an informational no-op.
- **Diagram Reference**: Embed [`docs/diagrams/sequence_undo_redo.mermaid`](diagrams/sequence_undo_redo.mermaid).
- **Speaker Notes**:
  > "Undo in a multi-user environment is notoriously difficult. If Alice presses Ctrl+Z, it must never delete Bob's diagram. We implemented isolated per-user stacks. When Alice undos, the server generates a new compensating forward operation that removes her object while preserving everyone else's contributions."

---

### Slide 10: Security, Room Access & Role-Based Permissions

- **Slide Title**: Security Architecture & Role Hierarchy
- **Content Elements**:
  - **Room Access Control**:
    - Unambiguous 6-character room codes (excluding easily confused characters: 0, 1, I, O).
    - Password hashing using Node.js native `crypto.scrypt` with random salt.
    - IP-based rate limiting to thwart brute-force password guessing.
  - **Three-Tier Role Hierarchy**:
    - **`HOST`**: Room creator. Can clear canvas, kick participants, change roles, lock room.
    - **`EDITOR`**: Collaborator. Can draw, create shapes, annotate, chat.
    - **`VIEWER`**: Observer. Read-only canvas access; socket mutations rejected server-side.
  - **Server-Side Validation**:
    - Server never trusts the client: validates every operation against sender's authenticated role.
- **Speaker Notes**:
  > "Security is enforced at the network layer. Room passwords use scrypt hashing with rate limiting against brute force. The server enforces strict role-based access control: Host, Editor, and Viewer. A Viewer cannot draw or erase—even if a client modified their UI, the server validates every packet and drops unauthorized mutations."

---

### Slide 11: Modern User Interface & Drawing Engine

- **Slide Title**: UI Design & HTML5 Canvas Rendering
- **Content Elements**:
  - **Figma/FigJam-Inspired Aesthetic**:
    - Floating dark vertical toolbar, top header with avatars, floating property bar, right chat panel.
    - Responsive layout tested at $1280 \times 720$ and responsive across screen resolutions.
  - **Drawing Engine**:
    - Custom HTML5 2D Canvas engine with `perfect-freehand` for smooth, calligraphic pen strokes.
    - Layered rendering: committed static layer + active live drawing layer.
    - Sub-pixel anti-aliasing and `devicePixelRatio` scaling for retina/high-DPI screens.
  - **Tools**: Pen, Object Eraser, Geometric Shapes (Rectangle, Ellipse, Line, Arrow), Text Boxes, Sticky Notes, Laser Pointer.
- **Visual Assets**: High-resolution screenshot of the whiteboard interface annotated with callouts.
- **Speaker Notes**:
  > "For the user interface, we followed modern design patterns inspired by Figma and FigJam. The canvas uses a layered HTML5 Canvas 2D engine with the perfect-freehand algorithm for smooth strokes. We built rich shape tools, resizable text boxes, and colored sticky notes with full interactive handles."

---

### Slide 12: Collaboration Features & Group Chat

- **Slide Title**: Real-Time Collaboration & Integrated Chat
- **Content Elements**:
  - **Remote Cursors & Attribution**:
    - Throttled `CURSOR_MOVE` updates display remote users' live cursor positions with name tags in their designated color.
  - **Group Text Chat**:
    - Real-time text messaging alongside the shared canvas.
    - Chronological history with usernames, avatars, and timestamps.
    - Unread badge counter when panel is collapsed.
    - System notification banners on participant join/leave/role change.
  - **Asset Insertion & Export**:
    - Chunked image upload (PNG/JPEG) without external storage.
    - Export board as PNG image, vector PDF document, or JSON state snapshot.
- **Visual Assets**: Screenshot showing side-by-side chat panel and live participant cursors.
- **Speaker Notes**:
  > "Collaboration extends beyond drawing. Users see remote cursors move in real time with personalized colors. The right sidebar features an integrated group chat with history sync, unread badges, and system alerts. Teams can also insert local images and export their completed board to high-resolution PNG or PDF."

---

### Slide 13: Presentation Mode & Version History

- **Slide Title**: Advanced Capabilities: Presentation & Versioning
- **Content Elements**:
  - **Host-Driven Presentation Mode**:
    - The Host broadcasts their exact viewport (pan and zoom).
    - Connected viewers automatically track the host's viewport in real time.
    - **Laser Pointer**: Glowing cursor trail fades after 1.5 seconds for highlighting diagram sections.
  - **Version History & Milestone Restores**:
    - Periodic autosaves and user-named milestone snapshots.
    - Host can review historical versions and restore the board to any prior state.
- **Visual Assets**: Screenshot of Presentation Mode active with laser pointer trail and Version History modal.
- **Speaker Notes**:
  > "Beyond the core requirements, we implemented presentation mode, where the host can lock viewer viewports to their own camera and use a glowing laser pointer to direct attention. We also added version history, enabling hosts to save named milestone snapshots and restore them with one click."

---

### Slide 14: Verification, Testing & The Lossy Network Harness

- **Slide Title**: Rigorous Testing & Lossy Network Simulation
- **Content Elements**:
  - **Complete Automated Test Suite**:
    - **175 unit and integration tests** passing across 26 test files with 100% pass rate.
    - Tests real raw TCP socket communication, framing, Zod validation, and role security.
  - **Lossy TCP Proxy Test Harness** (`tests/lossy-proxy.ts`):
    - Injects artificial latency (50-200ms), packet duplication, random drops, and reordering.
    - Verifies that multiple concurrent drawing clients converge to an identical canvas despite network instability.
- **Visual Assets**: Terminal screenshot showing Vitest reporting 26 passed test files and 175 passing tests.
- **Speaker Notes**:
  > "To verify our protocol's robustness, we wrote 175 automated tests that run against real TCP sockets. We even built an adversarial lossy proxy harness that injects simulated network delays, duplicated frames, and dropped connections. In every test, all clients converged to the exact same canvas state."

---

### Slide 15: Cross-Platform Packaging & Offline Verification

- **Slide Title**: Standalone Binaries & Zero-Internet Verification
- **Content Elements**:
  - **Server Packaging (`@yao-pkg/pkg`)**:
    - Self-contained executable with embedded Node 22 runtime for Windows (`.exe`), Linux, and macOS.
  - **Client Packaging (`electron-builder`)**:
    - Windows NSIS installer & portable `.exe`, macOS `.dmg`, Linux `AppImage`.
  - **Zero-Internet Verification**:
    - Verified on clean machines with Wi-Fi disabled and Ethernet disconnected from WAN.
    - Server starts cleanly; clients discover and join over isolated local switch.
  - **GitHub Actions CI/CD Matrix**:
    - Automated builds and tests on Windows, Ubuntu, and macOS runners.
- **Visual Assets**: Matrix table showing platforms and packaging formats.
- **Speaker Notes**:
  > "For final deployment, both server and client compile into standalone executables that require zero external installations. We verified these binaries on clean test machines with internet disabled. Our GitHub Actions CI pipeline runs lint, test, and packaging jobs across all three operating systems."

---

### Slide 16: Individual Contributions Breakdown (Video Guide)

- **Slide Title**: Team Member Contributions
- **Content Elements**:
  - **Member 1 (Networking & Protocol)**:
    - Designed 4-byte BE binary framing parser, universal envelope, and Zod schemas.
    - Implemented TCP socket server accept loop and UDP broadcast discovery service.
  - **Member 2 (Concurrency & State Synchronization)**:
    - Engineered the per-room serial FIFO task queue and monotonic sequencer.
    - Implemented optimistic rendering reconciliation and log compaction engine.
  - **Member 3 (Reliability, Security & Testing)**:
    - Built heartbeat watchdog, session takeover token system, and gap resync protocol.
    - Authored password scrypt hashing, role enforcement, and the lossy proxy test harness.
  - **Member 4 (Client Architecture & UI/UX)**:
    - Developed Electron main-process TCP client, preload IPC bridge, and Zustand store.
    - Implemented HTML5 Canvas 2D engine with perfect-freehand, shapes, chat, and PDF export.
- **Speaker Notes**:
  > "Each team member owned a vital architectural subsystem. [Each member speaks to their specific module as outlined above, referencing the relevant source code files and architecture diagrams]."

---

## 3. Application Screenshots to Capture for PPT

To ensure the presentation visually demonstrates all implemented functionality, capture the following screenshots:

| #         | Screenshot Target                       | Where in App             | Elements to Highlight                                                                                          |
| :-------- | :-------------------------------------- | :----------------------- | :------------------------------------------------------------------------------------------------------------- |
| **SS-1**  | **Connect Dialog & Auto-Discovery**     | App Startup              | Username entry, discovered server card with IP/Port/Rooms, "Host New Room" and "Join Existing Room" buttons.   |
| **SS-2**  | **Full Whiteboard Overview**            | Main Canvas              | Top bar with room code, dot-grid canvas, left vertical toolbar, bottom property bar, and right chat panel.     |
| **SS-3**  | **Multi-User Collaboration in Action**  | Two Client Windows       | Two side-by-side windows showing Alice drawing in teal and Bob drawing in purple, with live cursor name tags.  |
| **SS-4**  | **Geometric Shapes & Styling**          | Canvas & Property Bar    | Rectangles, ellipses, arrows, and sticky notes on canvas; property bar showing color presets and stroke width. |
| **SS-5**  | **Text Box & Sticky Notes**             | Canvas                   | Multiline text annotations and sticky note cards showing brainstorming ideas.                                  |
| **SS-6**  | **Group Chat & Unread Notifications**   | Right Panel              | Chat bubbles with avatars, timestamps, system join alerts, message input field, and unread badge.              |
| **SS-7**  | **Participants List & Role Management** | Right Panel (Tab 2)      | List of users showing Host, Editor, Viewer tags, and Host action menu (Kick, Change Role).                     |
| **SS-8**  | **Share Modal**                         | Top Bar "Share" Button   | Room code, server LAN IP address, port, and "Copy Link" buttons.                                               |
| **SS-9**  | **Presentation Mode & Laser Pointer**   | Canvas during Presenting | Viewport indicator and glowing laser pointer trail fading across the canvas.                                   |
| **SS-10** | **Version History Modal**               | Top Bar Clock Icon       | List of named snapshot milestones with "Create Snapshot" and "Restore" buttons.                                |
| **SS-11** | **Reconnection Banner**                 | Top of Screen            | Amber banner _"Connection lost. Reconnecting to whiteboard..."_ during simulated network drop.                 |
| **SS-12** | **Terminal Server Startup**             | Server Console           | Server logging LAN IPv4 addresses, active port, and UDP discovery readiness.                                   |
| **SS-13** | **Automated Test Results**              | Terminal Console         | Vitest output showing 26 test files passed, 175 passed tests.                                                  |

---

## 4. Video Recording Guidelines (Zoom / Teams)

1. **Format**: Record via Zoom or Microsoft Teams with cameras ON for all team members (faces and names clearly visible).
2. **Focus**: The video should focus on explaining technical implementation using the PPT slides and source code files (a live application demonstration is not required per project instructions).
3. **Flow**:
   - Begin with Slide 1 (introductions and roles).
   - Walk through the slides sequentially.
   - When discussing each subsystem, switch briefly to the corresponding TypeScript source file in VS Code (e.g., `framing.ts`, `room.ts`, `tcp-client.ts`, `WhiteboardCanvas.tsx`) to show key functions and comments.
   - Conclude with the test results and verification slide.

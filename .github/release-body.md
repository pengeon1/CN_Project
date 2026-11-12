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

## Step-by-Step Guide to Run on Each OS (Offline LAN)

> **Server vs Client:** Start **one server** on any host computer on your LAN, then launch the **desktop client (`LAN Whiteboard`)** on every participant's machine (including the host machine if participating).

### Windows (x64)

1. **Download**:
   - **Client**: `LAN-Whiteboard-{{VERSION}}-win-x64-nsis.exe` (installer) or `LAN-Whiteboard-{{VERSION}}-win-x64-portable.exe` (standalone portable `.exe`).
   - **Server** _(host machine only)_: `whiteboard-server-win-x64.exe`.
2. **Start the Server** _(host machine only, PowerShell or Command Prompt)_:
   ```powershell
   .\whiteboard-server-win-x64.exe --port 4000 --data-dir ./data
   ```
   - When Windows Defender Firewall prompts, check **Private networks** and click **Allow access** (TCP `4000` + UDP `45454`).
   - Note the printed LAN IPv4 address (for example `192.168.1.x:4000`).
3. **Run the Client**:
   - Double-click `LAN-Whiteboard-{{VERSION}}-win-x64-nsis.exe` (or the portable `.exe`).
   - If **Windows SmartScreen** shows _"Windows protected your PC"_, click **More info** -> **Run anyway**.
4. **Connect**: Pick the server under **Find servers on this network** (or enter its IP and port `4000`), then **Create Room** or **Join Room**.

---

### macOS (Apple Silicon `arm64` & Intel `x64`)

1. **Download**:
   - **Apple Silicon (M1/M2/M3/M4)**: Client `LAN-Whiteboard-{{VERSION}}-mac-arm64.dmg` (or `.zip`), Server `whiteboard-server-macos-arm64`.
   - **Intel Mac**: Client `LAN-Whiteboard-{{VERSION}}-mac-x64.dmg` (or `.zip`), Server `whiteboard-server-macos-x64`.
2. **Start the Server** _(host machine only, Terminal)_:
   ```bash
   chmod +x ./whiteboard-server-macos-*
   xattr -cr ./whiteboard-server-macos-*
   ./whiteboard-server-macos-arm64 --port 4000 --data-dir ./data   # use -x64 on Intel Macs
   ```
   - Click **Allow** if macOS prompts to allow incoming network connections.
3. **Install & Open the Client**:
   - If Safari/Chrome quarantined the downloaded `.dmg`, clear the download attribute first:
     ```bash
     xattr -cr ~/Downloads/LAN-Whiteboard-{{VERSION}}-mac-*.dmg
     ```
   - Open the `.dmg` (or extract the `.zip`) and drag **`LAN Whiteboard.app`** into **Applications**.
   - Clear the browser quarantine flag once (builds are ad-hoc signed without a paid Apple notarization certificate) and open the app:
     ```bash
     xattr -cr "/Applications/LAN Whiteboard.app"
     open "/Applications/LAN Whiteboard.app"
     ```
   - _(Alternatively, open **System Settings -> Privacy & Security -> Open Anyway** if Gatekeeper prompts.)_
4. **Connect**: Pick the server under **Find servers on this network** (or enter its IP and port `4000`), then **Create Room** or **Join Room**.

---

### Linux (x64)

1. **Download**:
   - **Client**: `LAN-Whiteboard-{{VERSION}}-linux-x64.AppImage`.
   - **Server** _(host machine only)_: `whiteboard-server-linux-x64`.
2. **Start the Server** _(host machine only)_:
   ```bash
   sudo ufw allow 4000/tcp && sudo ufw allow 45454/udp   # or equivalent firewalld rules
   chmod +x ./whiteboard-server-linux-x64
   ./whiteboard-server-linux-x64 --port 4000 --data-dir ./data
   ```
3. **Run the Client**:
   ```bash
   chmod +x ./LAN-Whiteboard-{{VERSION}}-linux-x64.AppImage
   ./LAN-Whiteboard-{{VERSION}}-linux-x64.AppImage
   ```
   - If FUSE (`libfuse2`) is not installed (common on Ubuntu 22.04+/24.04+), launch with:
     ```bash
     ./LAN-Whiteboard-{{VERSION}}-linux-x64.AppImage --appimage-extract-and-run
     ```
   - Add `--no-sandbox` if your kernel disables unprivileged user namespaces.
4. **Connect**: Pick the server under **Find servers on this network** (or enter its IP and port `4000`), then **Create Room** or **Join Room**.

> Run `whiteboard-server --help` for optional CLI flags (`--host`, `--port`, `--data-dir`, `--discovery-port`, `--no-discovery`, `-v`).

---

## Verify Checksums

- **Linux / macOS:** `sha256sum -c SHA256SUMS.txt --ignore-missing` (or `shasum -a 256 -c SHA256SUMS.txt` on macOS)
- **Windows PowerShell:** `Get-FileHash <downloaded-file> -Algorithm SHA256` and compare against `SHA256SUMS.txt`.

Full documentation is available in [Packaging & First-Run Guide](https://github.com/pengeon1/CN_Project/blob/{{TAG}}/docs/packaging.md), [User Guide](https://github.com/pengeon1/CN_Project/blob/{{TAG}}/docs/user_guide.md), and [Technical Documentation (PDF)](https://github.com/pengeon1/CN_Project/blob/{{TAG}}/docs/technical_documentation.pdf).

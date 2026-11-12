# Packaging, Releases and First-Run Guide

Developed for **CS3004 — Computer Networks Practice**.

The whiteboard ships as two standalone programs that need **no Node.js install and no internet**:

| Program    | What it is                                         | Built with         | Output (in `release/`)                       |
| ---------- | -------------------------------------------------- | ------------------ | -------------------------------------------- |
| **Server** | Command-line TCP server (Node 22 runtime embedded) | `@yao-pkg/pkg`     | `server/whiteboard-server-<os>-<arch>[.exe]` |
| **Client** | Desktop app (Electron)                             | `electron-builder` | `client/` installers (see below)             |

| OS          | Server                                                         | Client                                                                               |
| ----------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Windows x64 | `whiteboard-server-win-x64.exe`                                | NSIS installer `LAN-Whiteboard-<v>-win-x64-nsis.exe` and portable `...-portable.exe` |
| Linux x64   | `whiteboard-server-linux-x64`                                  | `LAN-Whiteboard-<v>-linux-x64.AppImage`                                              |
| macOS       | `whiteboard-server-macos-arm64`, `whiteboard-server-macos-x64` | `LAN-Whiteboard-<v>-mac-<arch>.dmg` / `.zip` (arm64 and x64)                         |

## Building locally

```bash
npm ci
npm run package:server     # builds the executables this OS can build natively
npm run package:client     # builds the desktop installers for this OS
npm run package:all        # both
npm run smoke:server -- release/server/whiteboard-server-linux-x64   # verify an executable
```

- `package:server` bundles the server, shared package and `zod` into one file with esbuild, then wraps it with the Node runtime. Targets default to the current OS (`linux-x64`, `win-x64`, or `macos-arm64` + `macos-x64`); pass targets explicitly, or `--all` to cross-compile everything. macOS binaries must be built on a Mac to be (ad-hoc) signed, which is why CI builds each OS natively.
- **First build needs internet once**: `pkg` downloads the Node base binary for each target and `electron-builder` downloads Electron. After that both are cached and builds work offline. The _resulting executables_ never need internet.
- `package:client` is slow (Electron plus installers). `npm --workspace=@cn-whiteboard/client run package:dir` builds an unpacked app directory only, which is faster for checking the configuration.
- Set `CSC_IDENTITY_AUTO_DISCOVERY=false` if electron-builder goes looking for a code-signing certificate you do not have.

## What CI does

- **`ci.yml`**: on every push/PR to `main`, format check, lint, tests and build on Windows, Linux and macOS. On pushes to `main` (and manual runs) a second `package` job builds the server executable, **smoke-tests it** (starts it, completes a TCP `HELLO`/`AUTH_OK` handshake and a UDP discovery probe), builds the client installers, verifies macOS `.app` ad-hoc signatures (`codesign --verify --deep --strict`) and `.dmg` images (`hdiutil verify`), and uploads both as artifacts (kept 14 days) from the run's _Artifacts_ section.
- **`release.yml`**: pushing a tag `vX.Y.Z` runs the same build and verification matrix across all three OSes, then a final `publish` job downloads every artifact, generates `SHA256SUMS.txt` checksums, renders the curated release write-up from `.github/release-body.md`, and publishes **one GitHub Release** using that release overview (with auto-generated commit/contributor lists disabled).

```bash
git tag v1.0.2 && git push origin v1.0.2     # publishes a release
```

## Running the server

```bash
./whiteboard-server-linux-x64 --port 4000 --data-dir ./data
./whiteboard-server-linux-x64 --help
```

Flags: `--host`, `--port`, `--data-dir`, `--discovery-port`, `--no-discovery`, `-v`, `--version`. On start it prints the LAN addresses clients should use. Rooms autosave to `--data-dir`; keep it somewhere writable.

## First-run firewall prompts (important on a LAN)

The server must accept inbound connections from other computers:

- **Windows**: the first run shows _"Windows Defender Firewall has blocked some features"_. Tick **Private networks** and click **Allow access**. If you dismissed it, run in an Administrator terminal:
  `netsh advfirewall firewall add rule name="Whiteboard server" dir=in action=allow program="C:\path\whiteboard-server-win-x64.exe" enable=yes profile=private`
- **macOS**: _"Do you want the application to accept incoming network connections?"_ → **Allow**. (System Settings → Network → Firewall → Options shows the entry.)
- **Linux**: no prompt, but a firewall may block it. UFW: `sudo ufw allow 4000/tcp && sudo ufw allow 45454/udp`. firewalld: `sudo firewall-cmd --add-port=4000/tcp --add-port=45454/udp` (add `--permanent` to keep it).

Ports: **TCP 4000** (or your `--port`) for the whiteboard; **UDP 45454** only for automatic server discovery. If UDP is blocked, clients can still connect by typing the server's IP and port.

The **client** only makes outgoing connections, so it normally triggers no firewall prompt (it uses a short-lived outgoing UDP socket for discovery).

## Unsigned & Ad-Hoc Signed Apps: Step-by-Step First-Run Guide

These academic builds do not use paid Apple Developer / Authenticode certificates (`CSC_IDENTITY_AUTO_DISCOVERY=false`), so macOS builds are **ad-hoc signed inside-out** during packaging (`scripts/mac-adhoc-sign.mjs`) and verified with `codesign --verify --deep --strict` + `hdiutil verify`. Because downloads from a browser still carry quarantine/SmartScreen metadata, follow these exact first-run steps per OS:

### Windows (x64)

1. **Server** _(host machine only)_: Run `.\whiteboard-server-win-x64.exe --port 4000 --data-dir ./data` in PowerShell. If Windows Defender Firewall prompts, allow **Private networks**.
2. **Client**: Run `LAN-Whiteboard-<v>-win-x64-nsis.exe` (or `-portable.exe`).
3. If **Windows SmartScreen** appears (_"Windows protected your PC"_), click **More info -> Run anyway** _(or right-click the file -> **Properties** -> check **Unblock** before running)_.

### macOS (Apple Silicon `arm64` & Intel `x64`)

1. **Server** _(host machine only)_:
   ```bash
   chmod +x ./whiteboard-server-macos-*
   xattr -cr ./whiteboard-server-macos-*
   ./whiteboard-server-macos-arm64 --port 4000 --data-dir ./data   # use -x64 on Intel Macs
   ```
   Click **Allow** when macOS asks whether to allow incoming network connections.
2. **Client**:
   - Download `LAN-Whiteboard-<v>-mac-arm64.dmg` (Apple Silicon M1/M2/M3/M4) or `-x64.dmg` (Intel), or the matching `.zip`.
   - If your browser quarantined the `.dmg` download so Finder refuses to mount it, run `xattr -cr ~/Downloads/LAN-Whiteboard-*-mac-*.dmg` first.
   - Open the `.dmg` (or extract the `.zip`) and drag **`LAN Whiteboard.app`** into **Applications**.
   - Clear the quarantine attribute once and launch:
     ```bash
     xattr -cr "/Applications/LAN Whiteboard.app"
     open "/Applications/LAN Whiteboard.app"
     ```
   - Alternatively, **right-click -> Open** or enable it under **System Settings -> Privacy & Security -> Open Anyway**.

### Linux (x64)

1. **Server** _(host machine only)_: Allow TCP `4000` and UDP `45454` in `ufw`/`firewalld`, then run:
   ```bash
   chmod +x ./whiteboard-server-linux-x64
   ./whiteboard-server-linux-x64 --port 4000 --data-dir ./data
   ```
2. **Client**:
   ```bash
   chmod +x ./LAN-Whiteboard-<v>-linux-x64.AppImage
   ./LAN-Whiteboard-<v>-linux-x64.AppImage
   ```
   If FUSE (`libfuse2`) is missing (Ubuntu 22.04+/24.04+), pass `--appimage-extract-and-run` (and add `--no-sandbox` if unprivileged user namespaces are disabled).

## Verifying on a clean, offline machine

1. Copy the two files (server, client) to the machine by USB or LAN; disable Wi-Fi/internet.
2. Start the server (allow the firewall prompt). Note the printed LAN address.
3. Start the client, choose **Find servers on this network** or type the IP, create a room, and note the room code.
4. On a second machine, join with the code. Draw, chat, insert an image, and export a PNG.

Everything above uses only the local network: TCP for the session, UDP broadcast for discovery.

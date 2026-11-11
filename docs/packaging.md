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

- **`ci.yml`**: on every push/PR to `main`, format check, lint, tests and build on Windows, Linux and macOS. On pushes to `main` (and manual runs) a second `package` job builds the server executable, **smoke-tests it** (starts it, completes a TCP `HELLO`/`AUTH_OK` handshake and a UDP discovery probe), builds the client installers, and uploads both as artifacts (kept 14 days) from the run's _Artifacts_ section.
- **`release.yml`**: pushing a tag `vX.Y.Z` runs the same build and verification matrix across all three OSes, then a final `publish` job downloads every artifact, generates `SHA256SUMS.txt` checksums, renders the curated release write-up from `.github/release-body.md`, and publishes **one GitHub Release** using that release overview (with auto-generated commit/contributor lists disabled).

```bash
git tag v1.0.0 && git push origin v1.0.0     # publishes a release
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

## Unsigned apps: SmartScreen and Gatekeeper

These builds are **not code-signed** (signing needs paid certificates), so operating systems warn on first launch. This is expected for a CS3004 course lab build.

- **Windows SmartScreen** ("Windows protected your PC"): click **More info → Run anyway**. For the portable `.exe` or the server, the same prompt appears once per downloaded file. Right-click the file → _Properties_ → tick **Unblock** to avoid it.
- **macOS Gatekeeper** ("cannot be opened because the developer cannot be verified" / "is damaged"):
  - **Client app**: open the `.dmg`, drag the app to _Applications_, then **right-click the app → Open → Open** (once). If macOS says it is damaged, remove the download quarantine flag: `xattr -dr com.apple.quarantine "/Applications/LAN Whiteboard.app"`. Alternatively _System Settings → Privacy & Security → Open Anyway_.
  - **Server binary**: `chmod +x whiteboard-server-macos-arm64 && xattr -d com.apple.quarantine whiteboard-server-macos-arm64`, then run from Terminal. Use `macos-arm64` on Apple Silicon and `macos-x64` on Intel Macs.
- **Linux AppImage**: `chmod +x LAN-Whiteboard-*.AppImage` then run it. If it fails with a FUSE error (common on Ubuntu 22.04+), run it with `--appimage-extract-and-run`, or install `libfuse2`. The Electron sandbox may also need `--no-sandbox` on systems without user namespaces.
- **Linux server**: `chmod +x whiteboard-server-linux-x64`.

## Verifying on a clean, offline machine

1. Copy the two files (server, client) to the machine by USB or LAN; disable Wi-Fi/internet.
2. Start the server (allow the firewall prompt). Note the printed LAN address.
3. Start the client, choose **Find servers on this network** or type the IP, create a room, and note the room code.
4. On a second machine, join with the code. Draw, chat, insert an image, and export a PNG.

Everything above uses only the local network: TCP for the session, UDP broadcast for discovery.

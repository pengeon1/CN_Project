# LAN Collaborative Whiteboard - User Guide & Operator Manual

Welcome to the **LAN-Based Multi-User Collaborative Whiteboard**. This comprehensive user manual guides system administrators, facilitators, and collaborative participants through installing, configuring, running, and using the application across local area networks without internet connectivity.

---

## 1. System Requirements & Compatibility

The application is engineered for cross-platform execution on **Windows**, **macOS**, and **Linux**.

### Hardware Requirements

- **Processor**: Intel/AMD x64 or Apple Silicon (arm64).
- **RAM**: Minimum 2 GB (4 GB recommended for large canvases with multiple images).
- **Network**: Any Local Area Network (Ethernet switch/hub, Wi-Fi router, or ad-hoc laptop hotspot). **Internet connectivity is completely optional and not required.**
- **Display**: Minimum resolution of $1280 \times 720$ (optimized for desktop monitors and laptops).

### Software Requirements

- **Standalone Binaries**: Zero external dependencies required. Standalone executables package their own embedded runtime.
- **Development / Source Execution**: Node.js 20+ LTS and npm 10+.

---

## 2. Server Installation & Configuration

The whiteboard server is a lightweight daemon that coordinates real-time sessions, sequences drawing operations, and persists board state.

### 2.1 Starting the Server

#### Using Standalone Executable

Download the appropriate server executable for your host machine from the releases page:

```bash
# Windows
.\whiteboard-server-win-x64.exe --port 4000 --data-dir ./data

# Linux
chmod +x ./whiteboard-server-linux-x64
./whiteboard-server-linux-x64 --port 4000 --data-dir ./data

# macOS (Apple Silicon or Intel)
chmod +x ./whiteboard-server-macos-arm64
./whiteboard-server-macos-arm64 --port 4000 --data-dir ./data
```

#### Running from Source Code

```bash
npm run server
```

### 2.2 Server Command-Line Arguments

The server supports the following CLI options:

| Flag                     | Shorthand | Default   | Description                                                                        |
| :----------------------- | :-------- | :-------- | :--------------------------------------------------------------------------------- |
| `--host <ip>`            | `-h`      | `0.0.0.0` | IP address to bind TCP socket listener. Default binds to all network interfaces.   |
| `--port <number>`        | `-p`      | `4000`    | Port number for TCP socket connections.                                            |
| `--data-dir <path>`      | `-d`      | `./data`  | Directory where room state JSON files are saved. Created automatically if missing. |
| `--discovery-port <num>` |           | `45454`   | UDP port used for LAN broadcast discovery.                                         |
| `--no-discovery`         |           | `false`   | Disables UDP broadcast discovery service.                                          |
| `--verbose`              | `-v`      | `false`   | Enables verbose debug logging of raw TCP socket events and sequence numbers.       |
| `--help`                 |           |           | Displays the command-line help menu.                                               |
| `--version`              |           |           | Displays current server software version.                                          |

### 2.3 Identifying Your LAN IP Address

When the server initializes, it automatically scans all local network adapters and outputs your LAN IP addresses:

```text
[INFO] [TCPServer] Server bound and listening on 0.0.0.0:4000
[INFO] [TCPServer] Accessible across your Local Area Network via:
[INFO] [TCPServer]   -> tcp://192.168.1.105:4000
[INFO] [TCPServer]   -> tcp://10.0.0.12:4000
[INFO] [Discovery] LAN discovery listening on udp/45454
```

Share the displayed `192.168.x.x` or `10.0.x.x` address with client participants on your network.

### 2.4 Firewall Configuration

To allow incoming TCP connections from other LAN devices:

- **Windows**: On first run, a _Windows Defender Firewall_ popup will appear. Check **Private networks** and click **Allow access**. If missed, execute in an Administrator PowerShell:
  ```powershell
  netsh advfirewall firewall add rule name="Whiteboard Server" dir=in action=allow protocol=TCP localport=4000
  netsh advfirewall firewall add rule name="Whiteboard Discovery" dir=in action=allow protocol=UDP localport=45454
  ```
- **macOS**: When prompted _"Do you want the application to accept incoming network connections?"_, click **Allow**.
- **Linux**: Allow the ports in your firewall:
  ```bash
  sudo ufw allow 4000/tcp
  sudo ufw allow 45454/udp
  ```

---

## 3. Client Installation & Connection

### 3.1 Launching the Desktop Client

Install and open the client app on your operating system:

- **Windows**: Run `LAN-Whiteboard-Setup.exe` (or the standalone `LAN-Whiteboard-portable.exe`).
  - _SmartScreen Note_: If Windows displays _"Windows protected your PC"_, click **More info** $\rightarrow$ **Run anyway** (standard for unsigned lab binaries).
- **macOS**: Open `LAN-Whiteboard.dmg`, drag the app to _Applications_, and right-click $\rightarrow$ **Open**.
- **Linux**: Run `LAN-Whiteboard.AppImage` (`chmod +x` may be required).

### 3.2 Connect Dialog: Automatic Discovery & Manual Connect

Upon launching the application, the **Connect Dialog** appears:

```text
+-------------------------------------------------------+
|            Collaborative Whiteboard Connect           |
+-------------------------------------------------------+
|  Your Username: [ Jane Doe                          ] |
|                                                       |
|  Connection Mode:                                     |
|  (•) Auto-Discover Servers    ( ) Manual IP Address   |
|                                                       |
|  Discovered LAN Servers:                              |
|  +-------------------------------------------------+  |
|  | [192.168.1.105:4000] - Lab Server (2 rooms)    |  |
|  +-------------------------------------------------+  |
|                                                       |
|  Session Intent:                                      |
|  [ Host New Room ]              [ Join Existing Room ]|
+-------------------------------------------------------+
```

1. **Enter Your Username**: Type the display name that peers will see alongside your live cursor and chat messages.
2. **Auto-Discovery**: If your network supports UDP broadcasts, the client automatically scans port `45454` and lists discovered servers. Select the desired server with a single click.
3. **Manual Connect**: If UDP discovery is restricted on your network (e.g., enterprise AP isolation), switch to **Manual IP Address** and enter the server's LAN IP (e.g., `192.168.1.105`) and TCP Port (`4000`).

---

## 4. Room Management & Roles

### 4.1 Hosting a New Room

1. In the Connect Dialog, click **Host New Room**.
2. **Room Name**: Enter an optional descriptive name (e.g., `"Network Topologies Lab"`).
3. **Room Password**: (Optional) Enter a password to restrict access. Passwords are cryptographically salted and hashed using `scrypt` on the server.
4. Click **Create Room**. You will enter the canvas with the **`HOST`** role.
5. Note the generated **6-character Room Code** displayed in the Top Bar (e.g., `7RC7H3`).

### 4.2 Joining an Existing Room

1. Select **Join Existing Room** in the Connect Dialog.
2. Enter the **6-character Room Code** provided by the host.
3. If the room is password-protected, enter the room password.
4. Click **Join**. You will be authenticated and receive the full whiteboard state immediately.

### 4.3 Sharing Room Details

Click the prominent blue **Share** button in the Top Header Bar:

- Displays Server LAN IP, Port, and Room Code.
- Provides one-click **Copy Room Code** and **Copy Invite Link** buttons.
- Shows QR code / quick reference for team members.

### 4.4 User Roles & Permissions

The system enforces three distinct access tiers:

| Role         | Permissions & Capabilities                                                                                                                                                                                                      |
| :----------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`HOST`**   | Complete administrative control. Can draw, erase, insert shapes, edit text, clear canvas, kick participants, change roles (promote/demote), lock/unlock room, control presentation mode, and restore version history snapshots. |
| **`EDITOR`** | Full creative collaboration. Can draw, erase, create shapes, add text, post sticky notes, upload images, send chat messages, and undo/redo own actions.                                                                         |
| **`VIEWER`** | Read-only observation. Can view real-time drawing, pan and zoom locally, and participate in text chat. Mutating tools are disabled.                                                                                             |

#### Changing Participant Roles & Moderation

The Host can open the **Participants Tab** in the Right Sidebar, click the options icon (`⋮`) next to any user:

- **Make Host**: Transfer room ownership.
- **Make Editor / Make Viewer**: Modify editing privileges in real time.
- **Kick User**: Disconnect user from the room immediately.
- **Lock Room**: Prevent new participants from joining.

---

## 5. Whiteboard Tools & Feature Guide

The interface follows modern design aesthetics inspired by Figma and FigJam:

```text
+---------------------------------------------------------------------------------------+
| [<] Room: Network Topologies [7RC7H3]   Saved    (JD) (AL) (BO)   [Chat (2)]  [Share]  |
+----+-----------------------------------------------------------------------------+----+
| [V]|                                                                             |    |
| [P]|                                   [Rectangle]                               | C  |
| [E]|                                                                             | H  |
| [S]|                 (Freehand Stroke)            [Sticky Note]                  | A  |
| [T]|                                                                             | T  |
| [N]|                                                                             |    |
| [I]|                                                                             | &  |
| [L]|                                                                             |    |
|    |                                                                             | U  |
|    |                +-----------------------------------------+                  | S  |
|    |                | Color: [■][■][■]  Width: [---o---] 4px  |                  | E  |
|    |                +-----------------------------------------+                  | R  |
|    |                                                                [- 100% +]   | S  |
+----+-----------------------------------------------------------------------------+----+
```

### 5.1 Left Floating Toolbar

- **Select Tool (`V`)**: Click any object on the canvas to select, drag to reposition, use corner handles to resize, or press `Delete`/`Backspace` to remove.
- **Pen Tool (`P`)**: Real-time freehand drawing powered by `perfect-freehand`. Renders pressure-sensitive, anti-aliased calligraphy strokes with zero jitter.
- **Eraser Tool (`E`)**: Precise object-level eraser. Drag over any stroke or shape to delete it with automatic hit-testing.
- **Shape Tool (`S` / `R` / `O`)**: Click to insert geometric primitives:
  - **Rectangle**: Box with optional solid or translucent fill.
  - **Ellipse / Circle**: Smooth curves with adjustable stroke and border color.
  - **Line (`L`) & Arrow (`A`)**: Connectors and directional annotation arrows.
- **Text Box (`T`)**: Click anywhere on the canvas to place an editable text block. Supports multiline notes with customizable font size, bold, and alignment.
- **Sticky Note (`N`)**: Colorful digital sticky notes with integrated text editing, ideal for brainstorming and agile retrospectives.
- **Image Insertion (`I`)**: Insert local PNG, JPEG, or WebP images. Images are automatically compressed, divided into chunked TCP frames, and synced across all peers.
- **Laser Pointer**: Ephemeral glowing pointer for highlighting canvas regions during presentations without leaving permanent strokes.

### 5.2 Floating Property Bar

When any tool or object is active, a floating property bar appears at the bottom center:

- **Color Swatches**: 12 curated vibrant and dark color presets plus custom hex selection.
- **Stroke Width**: Adjustable slider from 1px to 24px.
- **Fill Toggle**: Switch between outlined shapes and solid filled shapes.
- **Text Styling**: Font size (Small, Medium, Large, Huge), Bold, Italic, and Text Alignment.

### 5.3 Canvas Navigation (Pan & Zoom)

- **Pan Canvas**: Hold the `Spacebar` and click-drag with the mouse, or press and hold the **Middle Mouse Wheel** while dragging.
- **Zoom Canvas**: Hold `Ctrl` (or `Cmd` on macOS) while scrolling the mouse wheel.
- **Zoom Controls**: Use the `[-]`, `[100%]`, `[+]` widget in the bottom right corner to quickly reset or adjust zoom level.
- **Dot-Grid Background**: Subtle background grid dynamically scales with zoom to provide spatial perspective.

### 5.4 Undo & Redo System

- **Shortcut**: `Ctrl+Z` (Undo), `Ctrl+Y` or `Ctrl+Shift+Z` (Redo).
- **Per-User Isolation**: Undoing your actions only affects strokes and objects _you_ created. Your teammate's work is never disrupted.
- If an object you created has already been deleted or modified by another peer, an informational alert will explain that the undo cannot be applied.

### 5.5 Canvas Clear (Host Protected)

- Only participants with the **`HOST`** role can reset the whiteboard.
- Triggered via the Top Bar menu or toolbar.
- A modal confirmation dialog prevents accidental clicks: _"Are you sure you want to clear the entire whiteboard? This action cannot be undone."_

---

## 6. Advanced Collaboration Features

### 6.1 Presentation Mode

1. The **`HOST`** can enable **Presentation Mode** from the Top Bar.
2. When active, all participants' viewports automatically follow the Host's exact pan and zoom coordinates.
3. The Host can activate the **Laser Pointer** tool to point at diagrams; a glowing cursor trail appears on all viewer screens and fades automatically after 1.5 seconds.
4. When the Host exits presentation mode, viewers regain independent canvas control.

### 6.2 Version History & Snapshots

1. Click the clock icon in the Top Bar to open **Version History**.
2. **Create Named Snapshot**: Enter a label (e.g., `"End of Sprint Planning"`) to take an immutable milestone snapshot.
3. **Restore Version**: The Host can preview past versions and click **Restore** to revert the whiteboard to any historical milestone.

### 6.3 Exporting the Whiteboard

Export the shared work at any time via the Top Bar export dropdown:

- **Export as PNG**: High-resolution image export with transparent or solid background.
- **Export as PDF**: Multi-page or single-sheet vector document ready for lab report submission.
- **Export as JSON**: Raw serialized state file that can be re-imported into any server session.

---

## 7. Group Chat & Communication

Collaborate via real-time text chat alongside drawing:

1. Click the **Chat** icon in the Top Bar (features an unread badge indicator).
2. The **Right Panel** expands with the chat thread.
3. **Live Messages**: Messages display the author's username, user-assigned avatar color, and exact timestamp.
4. **Chat History**: New joiners automatically receive the last 100 messages sent prior to joining.
5. **System Notifications**: Colored status banners notify the group when members join, leave, or are promoted.

---

## 8. Network Faults & Reconnection Behavior

If a laptop experiences Wi-Fi degradation or an Ethernet cable is briefly unplugged:

1. **Visual Notification**: A top amber status banner appears: _"Connection lost. Reconnecting to whiteboard..."_
2. **Graceful Retries**: The client automatically attempts to reconnect using exponential backoff (500ms, 1s, 2s, 4s...).
3. **Session Resumption**: Upon reconnecting, the client presents its `sessionToken`. The server re-associates the socket without resetting user permissions.
4. **Gap Repair**: The client compares its sequence counter (`seq`) with the server and receives any missed intermediate operations via `RESYNC_RESPONSE`.
5. **Offline Outbox**: Mutations drawn while temporarily disconnected are buffered locally and transmitted once reconnected, avoiding lost work.

---

## 9. Troubleshooting & Frequently Asked Questions

### Q1: The client says "Unable to connect: connect ECONNREFUSED".

- **Solution**: Ensure the server application is actively running on the target machine. Verify that both the host computer and client devices are connected to the same subnet/router. Confirm that the client entered the correct IP and port.

### Q2: Auto-Discovery does not find the server.

- **Solution**: Some Wi-Fi routers disable UDP broadcast forwarding between wireless clients (AP Isolation). If discovery times out, select **Manual IP Address** on the client and enter the server's LAN IP address printed in the server terminal.

### Q3: Windows Defender Firewall blocks the connection.

- **Solution**: Open Windows Firewall Settings $\rightarrow$ Allow an app through Windows Firewall $\rightarrow$ Ensure `whiteboard-server-win-x64.exe` (or Node.js) has checkboxes enabled for **Private Networks**.

### Q4: Can two users draw simultaneously at the exact same location?

- **Solution**: Yes. Both strokes are rendered concurrently. The server sequences them in the order received in the room queue and broadcasts both events to all clients.

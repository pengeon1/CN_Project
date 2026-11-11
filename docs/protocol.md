# LAN Collaborative Whiteboard Protocol Specification (v1)

**Course**: CS3004 — Computer Networks Laboratory

This document specifies the wire protocol, binary framing, message envelope, sequence ordering, consistency model, and error recovery mechanisms for the LAN-Based Multi-User Collaborative Whiteboard application.

---

## 1. Transport Protocol: Why TCP?

The application runs strictly over **TCP (Transmission Control Protocol)** via Node.js native `net.Socket` and `net.Server`.

### 1.1 Transport Selection Rationale

In a real-time collaborative workspace, the shared canvas state must maintain **strong eventual consistency** across all participants. While UDP is sometimes considered for loss-tolerant voice or low-stakes video gaming, it is ill-suited as the core transport for an interactive whiteboard for the following reasons:

1. **Guaranteed Delivery & Reliability**:
   - Canvas operations (such as adding a shape, deleting an object, clearing the board, or sending a chat message) are discrete state mutations. Dropping a single mutation in UDP results in divergent client canvas states ("ghost objects").
   - TCP provides kernel-level acknowledgment, automatic retransmission (ARQ), and checksum verification. Reinventing reliable transmission over raw UDP at the application layer would re-implement TCP poorly without operating-system-level offloading.
2. **In-Order Byte Delivery**:
   - TCP guarantees that bytes arrive in the exact order transmitted, eliminating the risk of out-of-order packet delivery causing race conditions at the transport layer.
3. **Congestion and Flow Control**:
   - When a client exports or receives an initial room state snapshot with hundreds of strokes, TCP's sliding window flow control prevents the sending peer from overwhelming the receiving socket buffer.

### 1.2 Responsibilities Handled at the Application Layer

Although TCP provides a reliable, ordered byte stream, it does **not** provide message boundaries or application-level state ordering. The following must still be handled at the application layer:

- **Message Framing**: TCP is a stream-oriented transport, not a packet-oriented transport. Chunks received from `socket.on('data')` may contain half a message (fragmentation) or multiple concatenated messages (coalescing). The application must enforce discrete message framing.
- **Application-Level Sequence Ordering (`seq`)**: TCP only orders bytes on an individual point-to-point socket. Across multiple concurrent clients, the server must assign a global monotonically increasing sequence number per room so all peers apply operations deterministically.
- **Idempotency & Deduplication (`op_id`)**: Network hiccups, client reconnects, or retried operations must not cause duplicate strokes or conflicting shapes.
- **Connection Health & Silent Disconnections**: TCP connections can silently die (e.g., unplugged Ethernet cable, laptop sleep) without a TCP FIN/RST packet. Application-level heartbeats (`PING`/`PONG`) and timeout monitors detect dead peers.

---

## 2. Binary Length-Prefixed Framing

Every message transmitted over the TCP socket is formatted as a **4-byte unsigned big-endian length prefix** followed by a UTF-8 encoded JSON payload.

### 2.1 Wire Format

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                 Payload Length (32-bit Big-Endian)            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                   UTF-8 Encoded JSON Body                     |
|                      (Variable Length)                        |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

### 2.2 Framing Rules

- **Header**: 4 octets (`UInt32BE`), representing the exact byte count of the following UTF-8 JSON payload.
- **Maximum Frame Size**: `8,388,608` bytes (8 MB). Any frame with a header indicating a length greater than 8 MB is immediately rejected with a `FramePayloadTooLargeError`, and the connection is dropped to prevent memory exhaustion attacks.
- **Decoder Behavior**:
  - **Partial Reads (Fragmentation)**: If `buffer.length < 4 + payloadLength`, the decoder retains the pending bytes and waits for subsequent TCP chunks.
  - **Coalesced Frames**: If `buffer.length >= 4 + payloadLength`, the decoder extracts the complete frame, advances the buffer offset, and loops to process any additional frames packed into the same buffer.
  - **Malformed Payload**: If the body cannot be parsed as valid JSON, a `MalformedFrameError` is emitted and the invalid frame is discarded without crashing the decoder process.

---

## 3. Universal Message Envelope

Every application message shares a uniform envelope structure.

```typescript
interface MessageEnvelope<T = unknown> {
  v: number; // Protocol version (1)
  type: MessageType; // Enumerated action type string
  msg_id: string; // Unique UUID v4 identifying this specific message
  seq: number; // Server-assigned sequence number (0 for unsequenced client messages)
  ts: number; // Server timestamp in epoch milliseconds
  room: string; // 6-character room code (empty during pre-room handshake)
  user_id: string; // Client UUID (empty prior to authentication)
  payload: T; // Strongly-typed payload object validated by Zod
}
```

### Envelope Fields

| Field     | Type     | Description                                                                                                                              |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `v`       | `number` | Protocol version. Handshake rejects clients if `v !== 1`.                                                                                |
| `type`    | `string` | The message discriminator (e.g. `STROKE_BEGIN`, `CHAT_MESSAGE`).                                                                         |
| `msg_id`  | `string` | Unique UUID v4 generated by the sender for tracking and request/response correlation.                                                    |
| `seq`     | `number` | Global room sequence counter. Clients set `seq = 0`. The server assigns a positive integer (`seq >= 1`) to accepted mutating operations. |
| `ts`      | `number` | Epoch timestamp in milliseconds.                                                                                                         |
| `room`    | `string` | Target room code. 6 alphanumeric characters from an unambiguous alphabet (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`).                            |
| `user_id` | `string` | Unique UUID identifying the authenticated user.                                                                                          |
| `payload` | `object` | Message-specific data payload, validated via Zod schemas.                                                                                |

---

## 4. Complete Message Type Catalog

### 4.1 Connection & Authentication

#### `HELLO` (Client -> Server)

Initiates the handshake upon establishing a TCP socket connection.

```json
{
  "v": 1,
  "type": "HELLO",
  "msg_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "seq": 0,
  "ts": 1730644800000,
  "room": "",
  "user_id": "",
  "payload": {
    "clientVersion": "1.0.0",
    "suggestedUsername": "Alice"
  }
}
```

#### `AUTH_OK` (Server -> Client)

Confirms successful protocol handshake and issues a session token.

```json
{
  "v": 1,
  "type": "AUTH_OK",
  "msg_id": "1c2deb4d-3b7d-4bad-9bdd-2b0d7b3dcb7e",
  "seq": 0,
  "ts": 1730644800050,
  "room": "",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "sessionId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "protocolVersion": 1
  }
}
```

#### `AUTH_FAIL` (Server -> Client)

Sent when protocol version is unsupported or handshake fails.

```json
{
  "v": 1,
  "type": "AUTH_FAIL",
  "msg_id": "2d3deb4d-3b7d-4bad-9bdd-2b0d7b3dcb8f",
  "seq": 0,
  "ts": 1730644800050,
  "room": "",
  "user_id": "",
  "payload": {
    "code": "PROTOCOL_VERSION_MISMATCH",
    "reason": "Server requires protocol version 1, client supplied version 2"
  }
}
```

---

### 4.2 Room Management & Participants

#### `CREATE_ROOM` (Client -> Server)

Requests creation of a new collaborative whiteboard session.

```json
{
  "v": 1,
  "type": "CREATE_ROOM",
  "msg_id": "3e4deb4d-3b7d-4bad-9bdd-2b0d7b3dcb90",
  "seq": 0,
  "ts": 1730644805000,
  "room": "",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "roomName": "Network Architecture Brainstorm",
    "username": "Alice",
    "password": "labpassword123",
    "allowNameChanges": true
  }
}
```

#### `JOIN_ROOM` (Client -> Server)

Requests access to an existing room using a 6-character room code.

```json
{
  "v": 1,
  "type": "JOIN_ROOM",
  "msg_id": "4f5deb4d-3b7d-4bad-9bdd-2b0d7b3dcb01",
  "seq": 0,
  "ts": 1730644810000,
  "room": "AB23CD",
  "user_id": "661f9511-f3ac-42e5-b827-557766551111",
  "payload": {
    "roomCode": "AB23CD",
    "username": "Bob",
    "password": "labpassword123",
    "sessionToken": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    "lastSeq": 140
  }
}
```

`sessionToken` and `lastSeq` are optional and only used to **resume** after a disconnect (see §7):

- `sessionToken` is the `sessionId` the server issued in `AUTH_OK`. If it matches a participant of the room, that participant's identity (`userId`, color, role) is restored instead of creating a new one.
- `lastSeq` is the highest room `seq` the client has applied. When the identity is resumed and `lastSeq` is supplied, the server answers with a `RESYNC_RESPONSE` containing only the missed operations (or with a full `ROOM_STATE` if the client is too far behind). Without `lastSeq` the answer is always a full `ROOM_STATE`.

#### `LEAVE_ROOM` (Client -> Server)

Cleanly leaves the current room. The server acknowledges with an `ACK` and broadcasts `PARTICIPANT_LEFT`. The participant's identity is retained, so they may resume it later with their session token.

```json
{
  "v": 1,
  "type": "LEAVE_ROOM",
  "msg_id": "50adeb4d-3b7d-4bad-9bdd-2b0d7b3dcb02",
  "seq": 0,
  "ts": 1730644812000,
  "room": "AB23CD",
  "user_id": "661f9511-f3ac-42e5-b827-557766551111",
  "payload": { "reason": "User left the session" }
}
```

#### `ROOM_STATE` (Server -> Client)

Sent to a newly joined client containing the entire materialized canvas snapshot, active participants, chat history, and current sequence number.

```json
{
  "v": 1,
  "type": "ROOM_STATE",
  "msg_id": "5a6deb4d-3b7d-4bad-9bdd-2b0d7b3dcb12",
  "seq": 142,
  "ts": 1730644810100,
  "room": "AB23CD",
  "user_id": "661f9511-f3ac-42e5-b827-557766551111",
  "payload": {
    "roomCode": "AB23CD",
    "roomName": "Network Architecture Brainstorm",
    "seq": 142,
    "objects": {
      "d290f1ee-6c54-4b01-90e6-d701748f0851": {
        "id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
        "authorId": "550e8400-e29b-41d4-a716-446655440000",
        "seq": 14,
        "zIndex": 1,
        "updatedAt": 1730644806000,
        "type": "stroke",
        "color": "#3B82F6",
        "width": 3,
        "points": [
          { "x": 100, "y": 150, "pressure": 0.5 },
          { "x": 105, "y": 155, "pressure": 0.6 }
        ],
        "isComplete": true
      }
    },
    "participants": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "username": "Alice",
        "role": "HOST",
        "color": "#EF4444",
        "joinedAt": 1730644805000
      },
      {
        "id": "661f9511-f3ac-42e5-b827-557766551111",
        "username": "Bob",
        "role": "EDITOR",
        "color": "#3B82F6",
        "joinedAt": 1730644810050
      }
    ],
    "chatHistory": [
      {
        "id": "c111f1ee-6c54-4b01-90e6-d701748f0811",
        "userId": "550e8400-e29b-41d4-a716-446655440000",
        "username": "Alice",
        "color": "#EF4444",
        "text": "Welcome to the session!",
        "ts": 1730644807000
      }
    ],
    "locked": false,
    "allowNameChanges": true,
    "createdAt": 1730644805000
  }
}
```

#### `PARTICIPANT_JOINED` (Server -> Broadcast)

Broadcast to room peers when a participant enters.

```json
{
  "v": 1,
  "type": "PARTICIPANT_JOINED",
  "msg_id": "6b7deb4d-3b7d-4bad-9bdd-2b0d7b3dcb23",
  "seq": 143,
  "ts": 1730644810150,
  "room": "AB23CD",
  "user_id": "661f9511-f3ac-42e5-b827-557766551111",
  "payload": {
    "participant": {
      "id": "661f9511-f3ac-42e5-b827-557766551111",
      "username": "Bob",
      "role": "EDITOR",
      "color": "#3B82F6",
      "joinedAt": 1730644810050
    }
  }
}
```

#### `PARTICIPANT_LEFT` (Server -> Broadcast)

Broadcast when a participant disconnects or leaves.

```json
{
  "v": 1,
  "type": "PARTICIPANT_LEFT",
  "msg_id": "7c8deb4d-3b7d-4bad-9bdd-2b0d7b3dcb34",
  "seq": 144,
  "ts": 1730644820000,
  "room": "AB23CD",
  "user_id": "661f9511-f3ac-42e5-b827-557766551111",
  "payload": {
    "userId": "661f9511-f3ac-42e5-b827-557766551111",
    "username": "Bob",
    "reason": "Connection timed out"
  }
}
```

#### `UPDATE_USERNAME` / `PARTICIPANT_RENAMED`

When the host enables participant name changes in the room's creation settings, participants can request to change their display name during the session. The server validates the new name and broadcasts it as a sequenced event so connected clients and reconnecting clients update consistently. The setting is stored with the room; when disabled, the server rejects name-change requests.

```json
{
  "type": "UPDATE_USERNAME",
  "payload": { "username": "Sketcher" }
}
```

The server broadcasts `PARTICIPANT_RENAMED` with `{ "userId": "<participant UUID>", "username": "Sketcher" }`.

#### `PARTICIPANT_LIST` (Server -> Client)

Provides the full list of participants upon request.

```json
{
  "v": 1,
  "type": "PARTICIPANT_LIST",
  "msg_id": "8d9deb4d-3b7d-4bad-9bdd-2b0d7b3dcb45",
  "seq": 0,
  "ts": 1730644820100,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "participants": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "username": "Alice",
        "role": "HOST",
        "color": "#EF4444",
        "joinedAt": 1730644805000
      }
    ]
  }
}
```

#### `PERMISSION_CHANGE` (Client -> Server -> Broadcast)

The host can change a participant between `EDITOR` and `VIEWER`, lock or unlock the room, or kick a participant. Host ownership is transferred by the server when the host leaves; clients cannot assign the `HOST` role directly. Each request performs one change:

```json
{
  "v": 1,
  "type": "PERMISSION_CHANGE",
  "msg_id": "9e0deb4d-3b7d-4bad-9bdd-2b0d7b3dcb56",
  "seq": 145,
  "ts": 1730644825000,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "targetUserId": "661f9511-f3ac-42e5-b827-557766551111",
    "newRole": "VIEWER"
  }
}
```

For a lock toggle, send `{ "lockRoom": true }` or `{ "lockRoom": false }`. To remove a participant, send `{ "targetUserId": "<participant UUID>", "kick": true, "reason": "Removed by host" }`. A kicked session token cannot resume in that room.

---

### 4.3 Real-Time Drawing & Canvas Operations

#### `STROKE_BEGIN` (Client -> Server -> Broadcast)

Begins a new freehand pen stroke.

```json
{
  "v": 1,
  "type": "STROKE_BEGIN",
  "msg_id": "a1bdeb4d-3b7d-4bad-9bdd-2b0d7b3dcb67",
  "seq": 146,
  "ts": 1730644830000,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "op_id": "f101f1ee-6c54-4b01-90e6-d701748f0801",
    "strokeId": "s201f1ee-6c54-4b01-90e6-d701748f0802",
    "color": "#10B981",
    "width": 3,
    "startPoint": { "x": 240.5, "y": 180.2, "pressure": 0.5 }
  }
}
```

#### `STROKE_POINTS` (Client -> Server -> Broadcast)

Transmits a batched array of intermediate freehand stroke coordinates.

```json
{
  "v": 1,
  "type": "STROKE_POINTS",
  "msg_id": "b2cdeb4d-3b7d-4bad-9bdd-2b0d7b3dcb78",
  "seq": 147,
  "ts": 1730644830025,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "op_id": "f102f1ee-6c54-4b01-90e6-d701748f0803",
    "strokeId": "s201f1ee-6c54-4b01-90e6-d701748f0802",
    "points": [
      { "x": 242.0, "y": 181.5, "pressure": 0.52 },
      { "x": 245.8, "y": 184.0, "pressure": 0.55 },
      { "x": 250.1, "y": 188.4, "pressure": 0.6 }
    ],
    "startIndex": 1
  }
}
```

`startIndex` is added by the server when it broadcasts the batch: it is the index that `points[0]` occupies in the authoritative stroke (the `startPoint` of `STROKE_BEGIN` is index 0). Receivers merge a batch by index, skipping points they already hold, so applying the same batch twice (a duplicate frame, a replay after resync, or the echo of a stroke the sender already drew locally) never duplicates points. Any `startIndex` supplied by a client is ignored.

The server accepts points only for a stroke that exists and is not yet complete; otherwise it answers with a rejecting `ACK`.

#### `STROKE_END` (Client -> Server -> Broadcast)

Finalizes the freehand stroke.

```json
{
  "v": 1,
  "type": "STROKE_END",
  "msg_id": "c3ddeb4d-3b7d-4bad-9bdd-2b0d7b3dcb89",
  "seq": 148,
  "ts": 1730644830080,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "op_id": "f103f1ee-6c54-4b01-90e6-d701748f0804",
    "strokeId": "s201f1ee-6c54-4b01-90e6-d701748f0802",
    "finalPoint": { "x": 260.0, "y": 195.0, "pressure": 0.4 },
    "startIndex": 4
  }
}
```

As for `STROKE_POINTS`, the server stamps `startIndex` (the index of `finalPoint`) onto the broadcast.

#### `SHAPE_ADD` (Client -> Server -> Broadcast)

Adds a geometric shape, text box, or sticky note.

```json
{
  "v": 1,
  "type": "SHAPE_ADD",
  "msg_id": "d4edeb4d-3b7d-4bad-9bdd-2b0d7b3dcb9a",
  "seq": 149,
  "ts": 1730644835000,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "op_id": "f104f1ee-6c54-4b01-90e6-d701748f0805",
    "object": {
      "id": "e301f1ee-6c54-4b01-90e6-d701748f0806",
      "authorId": "550e8400-e29b-41d4-a716-446655440000",
      "seq": 0,
      "zIndex": 2,
      "updatedAt": 1730644835000,
      "type": "shape",
      "shapeType": "rectangle",
      "x": 300,
      "y": 200,
      "width": 180,
      "height": 90,
      "strokeColor": "#1E293B",
      "strokeWidth": 2,
      "fillColor": "#F8FAFC"
    }
  }
}
```

#### `OBJECT_UPDATE` (Client -> Server -> Broadcast)

Updates attributes (position, size, color, content) of an existing object.

```json
{
  "v": 1,
  "type": "OBJECT_UPDATE",
  "msg_id": "e5fdeb4d-3b7d-4bad-9bdd-2b0d7b3dcba1",
  "seq": 150,
  "ts": 1730644840000,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "op_id": "f105f1ee-6c54-4b01-90e6-d701748f0807",
    "id": "e301f1ee-6c54-4b01-90e6-d701748f0806",
    "changes": {
      "x": 320,
      "y": 210,
      "strokeColor": "#EF4444"
    }
  }
}
```

**Phase 12 rules for shape operations**

- _Server-owned fields._ On `SHAPE_ADD` the server overwrites `authorId` (the sender), `zIndex` (top of the stack) and `seq`, and broadcasts the normalized object, so a client can neither forge authorship nor jump the layer order. Reusing an existing object `id` is rejected.
- _Whitelisted changes._ `changes` may only contain `zIndex, x, y, width, height, strokeColor, strokeWidth, fillColor (null removes it), text, fontSize, fontFamily, align, bold, italic` for shapes and `zIndex, color, strokeWidth (stroke width), points` for freehand strokes. Unknown keys, bad colors, non-finite or out-of-range numbers and empty change sets are rejected by the zod schema.
- _Conflict resolution: last-writer-wins per property, ordered by `seq`._ The room applies operations one at a time, so arrival order is `seq` order, and every client replays in `seq` order. Edits to different properties of one object merge; edits to the same property resolve to the higher `seq`. Every change is an absolute value (moving a stroke sends the full `points` array), so re-applying an echoed operation is idempotent.
- _Updating a deleted object_ is rejected with an `ACK` of status `rejected`; the client's optimistic copy is overwritten by the authoritative `OBJECT_DELETE` it already received.
- _Undo._ Undoing `SHAPE_ADD` removes the object; undoing `OBJECT_UPDATE` restores the pre-update object; undoing `OBJECT_DELETE` restores it. Redo reverses each. Undo restores the whole previous object, so if another user edited the same object after your change, your undo also reverts their edit (documented limitation).
- Drags (move/resize) show a local preview and send **one** `OBJECT_UPDATE` on release, so one drag is one undo step.

#### Images: `IMAGE_UPLOAD`, `IMAGE_ADD`, `IMAGE_REQUEST`, `IMAGE_DATA` (Phase 13)

Image bytes never travel inside the ops log or snapshots. An image is an object (`type: "image"`) holding metadata plus an `assetId`; the bytes are a server-side asset moved in chunks well below the 8 MB frame limit so they interleave with drawing traffic.

1. **Client prepares the file**: decodes it, downscales so the longer side is at most 1600 px, and re-encodes it (PNG if it fits, else JPEG at falling quality) to at most **2 MB**.
2. **`IMAGE_UPLOAD`** (client -> server, unsequenced), one per 48 KB chunk. Requires edit rights. `data` is base64.

```json
{
  "type": "IMAGE_UPLOAD",
  "payload": {
    "assetId": "<uuid>",
    "mime": "image/png",
    "index": 0,
    "total": 3,
    "data": "iVBORw0KGgo..."
  }
}
```

3. **`IMAGE_ADD`** (client -> server -> broadcast, **sequenced and reliable**), sent after the chunks. The server accepts it only if the asset is fully stored and the `mime` matches; like `SHAPE_ADD` it overwrites `authorId`, `zIndex` and `seq`, and sets `bytes` from the stored asset.

```json
{
  "type": "IMAGE_ADD",
  "seq": 152,
  "payload": {
    "op_id": "<uuid>",
    "object": {
      "id": "<uuid>",
      "type": "image",
      "assetId": "<uuid>",
      "mime": "image/png",
      "bytes": 98000,
      "x": 10,
      "y": 20,
      "width": 200,
      "height": 100,
      "authorId": "<uuid>",
      "seq": 152,
      "zIndex": 3,
      "updatedAt": 1730644850000
    }
  }
}
```

4. **`IMAGE_REQUEST`** (client -> server). Any room member, viewers included, sends it for each image on the board whose bytes it lacks (after `IMAGE_ADD`, a late join, a resync or a reconnect; retried after 8 s if incomplete). The server answers with **`IMAGE_DATA`** chunks (same shape as `IMAGE_UPLOAD`, unsequenced) or an `ERROR` with code `IMAGE_NOT_FOUND`. Until the bytes arrive the client shows a "Loading image…" placeholder at the correct position.

Server-side validation: each chunk is schema-checked (base64, size, index range); at most 8 uploads in flight per room; the assembled file must be <= 2 MB, must start with the PNG/JPEG/WebP magic bytes for its declared `mime`, and the room's total image storage is capped at 64 MB. Violations produce `ERROR` code `IMAGE_REJECTED` and discard the partial upload. Unfinished uploads are dropped when their sender disconnects. Image objects move/resize through the normal `OBJECT_UPDATE` (`x, y, width, height, zIndex`), delete via `OBJECT_DELETE`/`ERASE`, and undo/redo like shapes. Assets are written into the room's autosave file, so images survive a server restart.

**Export** is client-side only (no protocol traffic): _Export > PNG_ and _PDF_ render the whole board, cropped to its content, using the same renderers as the live canvas. The PDF is a one-page document embedding a JPEG of that render.

#### Presentation mode: `PRESENTATION` (Phase 14)

Host-only, **unsequenced and latest-wins** (a viewport is meaningless once superseded, so it never enters the ops log or consumes a `seq`).

```json
{
  "type": "PRESENTATION",
  "seq": 0,
  "payload": { "active": true, "viewport": { "x": 120, "y": -40, "zoom": 1.5 } }
}
```

- `viewport.x/y` is the **world point at the centre of the host's view**, not pan offsets, so followers with different window sizes keep the same content centred. Followers' pan/zoom are locked while `active`; they can still edit and chat.
- The host sends a viewport on every pan/zoom (rate-limited to ~20/s, trailing edge) plus a **heartbeat every 2 s**. The server stores the latest state and includes it as `presentation` in `ROOM_STATE`, so late joiners and reconnecting clients lock on immediately.
- Because `{ "active": false }` is unsequenced it could be lost across a reconnect, so a follower treats **8 s without an update** as "presentation ended". The server also ends it (broadcasting `active: false`) when the presenting host disconnects.
- Non-host senders receive `ERROR` (`PERMISSION_DENIED`).

#### Laser pointer (Phase 14)

No new message: the laser tool reuses the ephemeral, throttled `CURSOR_MOVE` with `activeTool: "laser"`. Receivers draw a fading ~0.9 s glowing trail in the sender's colour instead of an arrow. Because it is presence data, read-only viewers may use it.

#### Version history: `VERSION_SAVE`, `VERSION_LIST`, `VERSION_RESTORE` (Phase 14)

Host-only. The server keeps up to **20** full copies of the board (object maps) per room, persisted with the room file.

| Message           | Direction                                       | Payload                                                                        | Effect                                           |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| `VERSION_SAVE`    | host -> server                                  | `{ "name": "Before workshop" }`                                                | Stores a named copy; replies with `VERSION_LIST` |
| `VERSION_LIST`    | host -> server (request, `{}`) / server -> host | `{ "versions": [{ "id", "name", "ts", "createdBy", "auto", "objectCount" }] }` | Newest first, no object data                     |
| `VERSION_RESTORE` | host -> server                                  | `{ "versionId": "<uuid>" }`                                                    | Replaces the board, then broadcasts `ROOM_STATE` |

- **Automatic snapshots** are taken lazily: the first board edit after 5 minutes, and only if the board changed since the last snapshot (no timers; idle rooms cost nothing). When the cap is reached, automatic versions are evicted before named ones.
- **Restore semantics.** The current board is first saved as an automatic "Before restoring ..." version, so a restore can be reverted. The restored board replaces `objects`; every user's undo/redo history is cleared (its targets no longer exist); the ops log is reset (`baseSeq = seq + 1`) so lagging clients get a full snapshot rather than replaying across the jump; then a `ROOM_STATE` snapshot is broadcast to all participants and a system chat message records who restored what. This is the same convergence mechanism as the host's `LOAD_STATE`.
- Unknown ids give `ERROR` `VERSION_NOT_FOUND`; non-hosts get `PERMISSION_DENIED`.

#### `OBJECT_DELETE` / `ERASE` (Client -> Server -> Broadcast)

`OBJECT_DELETE` removes one object (`{ "op_id", "id" }`, used by Delete key / selection delete); `ERASE` removes several by ID (eraser tool). Both are undoable.

```json
{
  "v": 1,
  "type": "ERASE",
  "msg_id": "f6adeb4d-3b7d-4bad-9bdd-2b0d7b3dcbb2",
  "seq": 151,
  "ts": 1730644845000,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "op_id": "f106f1ee-6c54-4b01-90e6-d701748f0808",
    "objectIds": ["e301f1ee-6c54-4b01-90e6-d701748f0806"]
  }
}
```

#### `CLEAR_CANVAS` (Client -> Server -> Broadcast)

Clears all objects from the whiteboard. Restricted to participants with the `HOST` role.

```json
{
  "v": 1,
  "type": "CLEAR_CANVAS",
  "msg_id": "07bdeb4d-3b7d-4bad-9bdd-2b0d7b3dcbc3",
  "seq": 152,
  "ts": 1730644850000,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "op_id": "f107f1ee-6c54-4b01-90e6-d701748f0809"
  }
}
```

#### `UNDO` / `REDO` (Client -> Server -> Broadcast)

Issues a compensating operation targeting a prior operation performed by the same user.
The client sends only `op_id` and `target_op_id`; the server adds the authoritative `removeIds` and
`restoreObjects` arrays to the sequenced broadcast so peers and resyncing clients make the same
canvas change.

```json
{
  "v": 1,
  "type": "UNDO",
  "msg_id": "18cdeb4d-3b7d-4bad-9bdd-2b0d7b3dcbd4",
  "seq": 153,
  "ts": 1730644855000,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "op_id": "f108f1ee-6c54-4b01-90e6-d701748f0810",
    "target_op_id": "f104f1ee-6c54-4b01-90e6-d701748f0805",
    "removeIds": ["d290f1ee-6c54-4b01-90e6-d701748f0851"],
    "restoreObjects": []
  }
}
```

---

### 4.4 Ephemeral Presence

#### `CURSOR_MOVE` (Client -> Server -> Broadcast)

High-frequency remote cursor coordinates. Throttled (~33ms) and **never** stored in the persistent operations log.

```json
{
  "v": 1,
  "type": "CURSOR_MOVE",
  "msg_id": "29ddeb4d-3b7d-4bad-9bdd-2b0d7b3dcbe5",
  "seq": 0,
  "ts": 1730644860000,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "x": 420.5,
    "y": 310.2,
    "activeTool": "pen",
    "pressure": 0.5
  }
}
```

---

### 4.5 Text Chat

#### `CHAT_MESSAGE` (Client -> Server -> Broadcast)

Text message sent within the room chat channel.

```json
{
  "v": 1,
  "type": "CHAT_MESSAGE",
  "msg_id": "3aedeb4d-3b7d-4bad-9bdd-2b0d7b3dcbf6",
  "seq": 154,
  "ts": 1730644865000,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "id": "c201f1ee-6c54-4b01-90e6-d701748f0812",
    "text": "Check out the connection between the client and server.",
    "username": "Alice",
    "color": "#EF4444"
  }
}
```

#### `CHAT_HISTORY` (Server -> Client)

Historical chat messages provided to joining clients.

```json
{
  "v": 1,
  "type": "CHAT_HISTORY",
  "msg_id": "4bfdeb4d-3b7d-4bad-9bdd-2b0d7b3dcc07",
  "seq": 0,
  "ts": 1730644865050,
  "room": "AB23CD",
  "user_id": "661f9511-f3ac-42e5-b827-557766551111",
  "payload": {
    "messages": [
      {
        "id": "c201f1ee-6c54-4b01-90e6-d701748f0812",
        "userId": "550e8400-e29b-41d4-a716-446655440000",
        "username": "Alice",
        "color": "#EF4444",
        "text": "Check out the connection between the client and server.",
        "ts": 1730644865000
      }
    ]
  }
}
```

---

### 4.6 Heartbeat & Synchronization

#### `PING` (Client -> Server) / `PONG` (Server -> Client)

Periodic heartbeat exchanged every 5 seconds.

```json
// PING
{
  "v": 1,
  "type": "PING",
  "msg_id": "5c0deb4d-3b7d-4bad-9bdd-2b0d7b3dcc18",
  "seq": 0,
  "ts": 1730644870000,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "nonce": 42109
  }
}

// PONG
{
  "v": 1,
  "type": "PONG",
  "msg_id": "6d1deb4d-3b7d-4bad-9bdd-2b0d7b3dcc29",
  "seq": 0,
  "ts": 1730644870005,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "nonce": 42109,
    "serverTs": 1730644870005,
    "roomSeq": 154
  }
}
```

`roomSeq` is the current sequence number of the sender's room (omitted when the sender is not in a room). It lets a client notice that it is missing the **tail** of the event stream (see §5.5).

#### `RESYNC_REQUEST` (Client -> Server)

Sent by a client when a gap in received sequence numbers is detected.

```json
{
  "v": 1,
  "type": "RESYNC_REQUEST",
  "msg_id": "7e2deb4d-3b7d-4bad-9bdd-2b0d7b3dcc3a",
  "seq": 0,
  "ts": 1730644875000,
  "room": "AB23CD",
  "user_id": "661f9511-f3ac-42e5-b827-557766551111",
  "payload": {
    "last_seq": 140
  }
}
```

#### `RESYNC_RESPONSE` (Server -> Client)

Supplies the operations a client is missing, or a full snapshot when it is too far behind. It is the answer to a `RESYNC_REQUEST`, and also the answer to a resuming `JOIN_ROOM` that carried `lastSeq`.

- The `operations` are **contiguous**: exactly `from_seq .. to_seq`, with no holes, because every sequence number the server hands out is recorded in the room's operations log (§5.1). They include participant and chat events, not only drawing operations.
- If the client is more than `MAX_RESYNC_OPS_WINDOW` (500) operations behind, or asks for a range the server has already compacted away (the log keeps the most recent 500 once it grows past 1,000), the response carries `fullSnapshot` (a `ROOM_STATE` payload) instead of `operations`.

```json
{
  "v": 1,
  "type": "RESYNC_RESPONSE",
  "msg_id": "8f3deb4d-3b7d-4bad-9bdd-2b0d7b3dcc4b",
  "seq": 154,
  "ts": 1730644875050,
  "room": "AB23CD",
  "user_id": "661f9511-f3ac-42e5-b827-557766551111",
  "payload": {
    "from_seq": 141,
    "to_seq": 154,
    "operations": [
      {
        "op_id": "f101f1ee-6c54-4b01-90e6-d701748f0801",
        "seq": 141,
        "userId": "550e8400-e29b-41d4-a716-446655440000",
        "type": "STROKE_BEGIN",
        "payload": { ... },
        "ts": 1730644830000
      }
    ]
  }
}
```

---

### 4.7 Acknowledgements & Errors

#### `ACK` (Server -> Client)

Tells a client what became of one of its messages, identified by `target_msg_id` (the `msg_id` the client used).

```json
{
  "v": 1,
  "type": "ACK",
  "msg_id": "9a4deb4d-3b7d-4bad-9bdd-2b0d7b3dcc5c",
  "seq": 0,
  "ts": 1730644880000,
  "room": "AB23CD",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "target_msg_id": "b2cdeb4d-3b7d-4bad-9bdd-2b0d7b3dcb78",
    "status": "ok",
    "seq": 147
  }
}
```

| Situation                                                              | What the sender gets                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Operation accepted for the first time                                  | No `ACK`: the broadcast **echo** (same `msg_id`, now with a `seq`) is the acknowledgement. |
| Operation already applied (retry or duplicated frame)                  | `ACK` with `status: "ok"` and the `seq` it originally received. Nothing is re-broadcast.   |
| Operation can never be applied (unknown or completed stroke, id clash) | `ACK` with `status: "rejected"` and an `error` text.                                       |
| `LEAVE_ROOM`                                                           | `ACK` with `status: "ok"`.                                                                 |

#### `ERROR` (Server -> Client)

```json
{
  "v": 1,
  "type": "ERROR",
  "msg_id": "ab5deb4d-3b7d-4bad-9bdd-2b0d7b3dcc6d",
  "seq": 0,
  "ts": 1730644881000,
  "room": "AB23CD",
  "user_id": "661f9511-f3ac-42e5-b827-557766551111",
  "payload": {
    "code": "FORBIDDEN",
    "message": "Viewer role cannot mutate canvas",
    "details": { "target_msg_id": "a1bdeb4d-3b7d-4bad-9bdd-2b0d7b3dcb67" }
  }
}
```

When an error is the response to a specific client message, `details.target_msg_id` identifies it. A client uses this to stop retransmitting an operation the server will never accept (§5.6).

| Code                        | Meaning                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `NOT_IN_ROOM`               | The message needs a room but the connection has not joined one.                                      |
| `FORBIDDEN`                 | The sender's role or room lock does not permit the action.                                           |
| `JOIN_FAILED`               | The room does not exist, is locked, the password is wrong, or the IP join-attempt limit was reached. |
| `INVALID_PERMISSION_CHANGE` | The requested role change, lock operation, or kick is not allowed.                                   |
| `NAME_CHANGE_DISABLED`      | The room host has disabled participant name changes.                                                 |
| `INVALID_PAYLOAD`           | The payload failed schema validation.                                                                |
| `INTERNAL_ERROR`            | Unexpected server-side failure.                                                                      |

---

## 5. Ordering, Concurrency, and Idempotency

### 5.1 Centralized Sequencing (`seq`)

1. The server is the **single source of truth** for operation ordering.
2. For every room, the server maintains an integer counter initialized at `0`.
3. Every event that changes shared state consumes one sequence number: drawing operations (`STROKE_*`, `SHAPE_*`, `OBJECT_*`, `ERASE`, `CLEAR_CANVAS`, `UNDO`, `REDO`), `CHAT_MESSAGE`, and the membership events `PARTICIPANT_JOINED`, `PARTICIPANT_LEFT` and `PERMISSION_CHANGE`. The server increments the room's counter and assigns `seq = ++room.seq`.
4. **The sequence has no holes.** Every sequence number handed out is paired with exactly one entry in the room's operations log, so any range `a..b` inside the log's window can be re-sent verbatim.
5. The sequenced envelope is broadcast to all participants. (A participant that is joining does not receive its own `PARTICIPANT_JOINED`; it learns about itself from the `ROOM_STATE` it receives.)
6. All clients apply events **strictly in ascending `seq` order, exactly once** (§5.4).

Unsequenced messages (`CURSOR_MOVE`, `PING`/`PONG`, `ACK`, `ERROR`, snapshots) carry `seq = 0` and are never replayed.

### 5.2 Client Idempotency (`op_id`)

1. Every mutating operation generated by a client carries a unique client-generated UUID: `op_id`, or `id` for `CHAT_MESSAGE`.
2. The server remembers the sequence number assigned to each of the last 10,000 operations (`op_id -> seq`).
3. If the server receives an operation whose `op_id` it has already sequenced, it does **not** re-apply or re-broadcast it. It replies to the sender with an `ACK` (`status: "ok"`) echoing the `seq` the operation originally received.
4. A retried `STROKE_BEGIN` for a stroke that has since been erased does not resurrect the stroke.
5. This makes network retries, duplicated frames, and the retransmission of an outbox after a reconnect (§5.6) completely harmless.

### 5.3 Optimistic Rendering & Reconciliation

1. **Local Drawing**: When a user draws with the pen tool, the client renders the stroke immediately onto an active local overlay canvas layer for instantaneous 60 FPS responsiveness.
2. **Batching**: The client batches collected pointer coordinates every ~20 milliseconds (`STROKE_BATCH_INTERVAL_MS`) and transmits `STROKE_POINTS`.
3. **Reconciliation**: While the user is still drawing, the local stroke is authoritative and echoes of it are ignored. Once the stroke is finished, the local copy is committed to the canvas model; the echoes that follow carry `startIndex`, so points the local copy already holds are skipped rather than appended twice.

### 5.4 Delivery Guarantee: Exactly Once, In Order

Whatever the network does, the UI is handed each sequenced event **exactly once and in strict `seq` order**. The client's network layer (main process) enforces this with a per-room cursor `lastSeq` (the highest contiguous `seq` delivered):

- `seq <= lastSeq` is a duplicate or a stale replay and is dropped.
- `seq == lastSeq + 1` is delivered immediately, followed by any buffered events that are now next in line.
- `seq > lastSeq + 1` arrived early: it is buffered until the gap fills (or is repaired, §5.5).
- A snapshot (`ROOM_STATE`, or `fullSnapshot` in a resync) sets the baseline `lastSeq = snapshot.seq`. Events that raced ahead of the first snapshot are held back, then delivered if they are newer than it and dropped if the snapshot already contains them. A stale or duplicated snapshot never rewinds a client that is already ahead of it.

The renderer additionally ignores any sequenced event with `seq <= lastAppliedSeq`, and applies stroke points by index (§4.3), as a second line of defence.

### 5.5 Gap Detection & Repair

A gap means the client knows the server has reached a seq it has not applied. It is detected in two ways:

1. **A later event arrives** while an earlier one is missing (`seq > lastSeq + 1`).
2. **The heartbeat reveals a lost tail.** `PONG.roomSeq` is the room's current seq. If it is ahead of `lastSeq` and no event is on its way, the last events were lost and nothing later would ever expose it.

Repair:

1. Wait `250 ms` (`gapWaitMs`): a merely delayed frame usually fills the gap by itself.
2. If the gap is still open, send `RESYNC_REQUEST { last_seq: lastSeq }`. At most one request is in flight.
3. The `RESYNC_RESPONSE` is fed through the same pipeline as live events, so overlaps with already-buffered events are de-duplicated naturally.
4. If no response arrives within `2 s`, ask again.

### 5.6 Reliable Submission (Client Outbox)

Operations that change shared state (`STROKE_*`, `SHAPE_ADD`, `OBJECT_*`, `ERASE`, `CLEAR_CANVAS`, `UNDO`, `REDO`, `CHAT_MESSAGE`) must not be lost just because the connection dropped at the wrong moment, so the client keeps each one in an **outbox** (in send order) until the server answers:

| Server answer                                               | Effect                                 |
| ----------------------------------------------------------- | -------------------------------------- |
| Broadcast echo of the operation (or its replay in a resync) | Operation is acknowledged and removed. |
| `ACK` (duplicate, or rejected) with `target_msg_id`         | Removed.                               |
| `ERROR` with `details.target_msg_id`                        | Removed (it will never be accepted).   |

While the connection is down, new operations are still accepted and queued. After a reconnect the whole outbox is re-sent in its original order; the server's `op_id` idempotency (§5.2) turns any operation it had already applied into a harmless `ACK`. Ephemeral messages (cursor moves) are never queued. The outbox is bounded (20,000 operations).

### 5.7 Fault Model Summary

| What goes wrong                                         | How it is handled                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Frame delivered twice                                   | Dropped by `seq` (server -> client) or `op_id` (client -> server).        |
| Frames arrive out of order                              | Buffered and delivered in order (§5.4).                                   |
| Event lost                                              | Gap detected, missing range re-fetched (§5.5).                            |
| Last events lost, nothing follows                       | Detected through `PONG.roomSeq` (§5.5).                                   |
| Connection dies with operations in flight               | Outbox retransmission after reconnect (§5.6); server de-duplicates.       |
| Client silently vanishes (cable pulled, laptop asleep)  | Heartbeat timeout drops the session; the room and identity survive (§7).  |
| Client reconnects before the server noticed it vanished | New connection takes over the old one without disturbing the room (§7.3). |
| Client is away longer than the server keeps history     | Full snapshot instead of incremental resync (§5.5, §7.2).                 |

---

## 6. Undo/Redo Semantics

Collaborative whiteboards with multiple simultaneous editors present concurrency conflicts if undo simply removes the last added element from the canvas. The protocol defines unambiguous undo/redo semantics:

1. **Per-User Local Stacks**:
   - Each client tracks its **own** completed strokes, erases, and canvas clears in a local Undo stack. A stroke's begin, point batches, and end are one user action.
   - User A clicking Undo **never** undoes or alters work authored by User B.
2. **Compensating Operations**:
   - Performing an Undo does not destructively modify server history. Instead, the client sends an `UNDO` operation referencing the target `target_op_id`.
   - The server sequences this `UNDO` operation like any other mutation (`seq = ++room.seq`) and broadcasts it to all peers.
   - The sequenced broadcast contains `removeIds` and `restoreObjects`, the authoritative canvas changes for that inverse. All clients, including the sender and clients catching up through resync, apply the same changes.
   - Redo uses the same fields to restore the removed object(s) or remove the object(s) restored by undo.
   - Shortcuts are `Ctrl/Cmd+Z` to undo, `Ctrl/Cmd+Shift+Z` to redo, and `Ctrl+Y` to redo. Shortcuts are ignored while focus is in an input or editable field.
3. **Conflict Resolution**:
   - The server only accepts the top operation on the requesting user's undo/redo stack. A target already removed by another action is rejected with `UNDO_FAILED`; an unavailable redo target is rejected with `REDO_FAILED`.
4. **Redo Invalidation**:
   - If a user performs any new canvas mutation after undoing, that user's local Redo stack is automatically cleared.

---

## 7. Connection Management & Recovery

### 7.1 Liveness (Heartbeat)

```text
 Client                                         Server
   |                                              |
   | --- PING (every 5s) -----------------------> |
   | <--- PONG (carries roomSeq) ---------------- |
   |                                              |
```

- **Client -> server**: the client sends `PING` every `5000 ms`. If it hears nothing from the server for `15000 ms` (`HEARTBEAT_TIMEOUT_MS`) it treats the connection as dead, closes it and starts reconnecting. Any received data counts as proof of life, not only `PONG`.
- **Server -> client**: the server sweeps all sessions every `5000 ms`. A session that has sent nothing for `15000 ms` is terminated, its participant is removed from the live roster, and `PARTICIPANT_LEFT` is broadcast.
- **The room survives.** Closing a session never closes the room; the canvas, the operations log and the participant's identity (`userId`, color, role) are kept, so the participant can come back (§7.2).
- TCP keepalive probes are also enabled on every socket, which helps the operating system reap half-open connections independently of the application heartbeat.
- A socket error (for example `ECONNRESET` from a client that crashed or lost its network) only ever ends that one session. It can never take down the server.

### 7.2 Reconnection & Resume

```text
 Client                                         Server
   |                                              |
   x [Socket drop / network outage]               |
   |                                              | (session closed or timed out)
   |                                              | [Broadcasts PARTICIPANT_LEFT]
   | ... wait 500ms x 2^n (cap 5s), +/-20% ...    |
   | --- Connect & HELLO (sessionToken) --------> |
   | <--- AUTH_OK (same sessionId) -------------- |
   | --- JOIN_ROOM (sessionToken, lastSeq: 140) ->|
   | <--- RESYNC_RESPONSE (ops 141..154) -------- |
   | [Client applies them in order, then          |
   |  re-sends its outbox (§5.6)]                 |
   | --- (un-acknowledged operations, in order) ->|
   | <--- echoes / ACKs ------------------------- |
```

1. **Backoff.** The client shows a "Reconnecting..." banner and retries after `500 ms`, then `1 s`, `2 s`, `4 s`, capped at `5 s`, each delay randomized by ±20% so that a room full of clients does not reconnect in lock-step. Attempts continue until the connection succeeds, the user disconnects, or the server answers that the room no longer exists (in which case the client stops and reports the error).
2. **Identity.** The client presents the session token it received in `AUTH_OK` (first in `HELLO`, then in `JOIN_ROOM`). The server restores the same participant: same `userId`, color and role.
3. **Catch-up.** `JOIN_ROOM.lastSeq` tells the server how far the client got. The server replies with:

   | Condition                                                                         | Reply                                                          |
   | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
   | Identity resumed and `lastSeq <= room.seq`, gap within the history window         | `RESYNC_RESPONSE` with only the missed operations (contiguous) |
   | Identity resumed but the client is older than the retained history (> 500 behind) | Full `ROOM_STATE` snapshot                                     |
   | `lastSeq` omitted, or greater than `room.seq`, or identity not recognized         | Full `ROOM_STATE` snapshot                                     |

4. **Outbox.** Only after the catch-up has been applied does the client re-send every operation that was never acknowledged, in the original order. Operations the server had in fact already applied are acknowledged as duplicates (§5.2). Drawing done while offline is therefore delivered when the connection returns.
5. **Mid-stroke.** A stroke that was in progress when the connection dropped is not abandoned: the points that were drawn while offline are queued behind the points that were already sent, and the stroke completes on every canvas once the outbox drains.

### 7.3 Identity Rules

- A participant who is **already gone** from the live roster (the server timed them out) is re-admitted with their previous role and `PARTICIPANT_JOINED` is broadcast.
- A client that **reconnects before the server noticed it vanished** (the old socket is still registered) takes over its own participant: the new connection replaces the old one, the old socket is closed, and nothing is announced because nothing changed for the other participants. No ghost participant and no spurious leave/join is created.
- A returning `HOST` whose ownership was **transferred** to someone else while away comes back as `EDITOR`, so a room never has two hosts.
- A **locked** room refuses new participants but always admits returning ones.
- A connection that closes after it has been replaced can never evict the participant that replaced it.

### 7.4 Slow Clients

Each session has a bounded outgoing queue (500 messages). When a client cannot keep up, ephemeral `CURSOR_MOVE` traffic is shed first; if the queue still overflows, that client is disconnected (it will reconnect and resync) rather than letting its backlog exhaust server memory or slow down the room.

### 7.5 Timing Reference

| Parameter                  | Value                       | Where                       |
| -------------------------- | --------------------------- | --------------------------- |
| Heartbeat interval         | 5 s                         | client `PING`, server sweep |
| Silence timeout            | 15 s                        | both directions             |
| Reconnect backoff          | 500 ms x 2^n, cap 5 s, ±20% | client                      |
| Gap wait before resync     | 250 ms                      | client                      |
| Resync response timeout    | 2 s                         | client                      |
| Resync window              | 500 operations              | server                      |
| Operations log             | 1,000, compacted to 500     | server                      |
| Remembered `op_id`s        | 10,000                      | server                      |
| Client outbox limit        | 20,000 operations           | client                      |
| Outgoing queue per session | 500 messages                | server                      |

### 7.6 Verification

The behaviour above is exercised by automated tests, including an end-to-end suite that runs the real server and the real client networking code through a **lossy TCP proxy** (`tests/lossy-proxy.ts`). The proxy parses protocol frames and can delay, duplicate, reorder and drop them, cut every connection, refuse new ones, or cut only the client side of a connection (a half-open connection the server has not noticed). The suite asserts that three clients drawing concurrently through such a network end up with exactly the server's canvas, that every event was delivered exactly once and in order, and that a client cut off mid-stroke resumes with nothing lost, nothing duplicated and its identity intact.

---

## 8. Security & Role-Based Access Control (RBAC)

1. **Room Authentication**:
   - Rooms are identified by a 6-character code (`ROOM_CODE_ALPHABET`).
   - Rooms optionally require a password. Passwords are never stored in plaintext; the server computes a salted cryptographic hash using Node.js built-in `crypto.scrypt`.
   - Failed room-join attempts are limited to five per remote IP in any rolling one-minute window to defend against brute-force attacks.
2. **Role Enforcement**:
   - **`HOST`**: Full control. Only the host can execute `CLEAR_CANVAS`, `PERMISSION_CHANGE` (promote/demote/kick), lock the room, and trigger server-side persistence (`SAVE_STATE`, `LOAD_STATE`).
   - **`EDITOR`**: Can draw, modify own objects, create shapes, and chat unless the host has locked the room.
   - **`VIEWER`**: Read-only observer. Cannot send canvas mutations. If a `VIEWER` client emits a drawing operation, the server rejects it with an `ERROR` message (`FORBIDDEN`).
3. **Zero-Trust Input Validation**:
   - The server **never** trusts incoming client data.
   - Every received message envelope and payload is strictly validated via Zod schemas before entering the room operations queue. Invalid shapes, non-finite coordinates, and out-of-range dimensions are rejected at the protocol boundary.

## 9. Room Persistence

- The server debounces room changes and atomically writes versioned JSON files named `<ROOM_CODE>.json` under `--data-dir` (default: `./data`). Temporary files are renamed into place only after the async write completes.
- Saved state includes board objects, sequence/resync history, chat, undo/redo history, and room access settings. Live socket sessions and connected participants are intentionally not restored.
- Startup validates persisted files before accepting connections. Invalid JSON or state produces a startup error instead of silently discarding data.
- Hosts can send `SAVE_STATE` with `{}` to save immediately or `LOAD_STATE` with `{}` to load the latest server-side save. A successful load replaces the active room state and sends a fresh `ROOM_STATE` snapshot to each participant. A missing save returns `ERROR` with code `SAVE_NOT_FOUND`.
- `SAVE_STATE` replies with `{ "savedAt": 1730644800000, "filename": "ABC234.json" }`; `LOAD_STATE` replies with `{ "loadedAt": 1730644800000, "filename": "ABC234.json" }`. These acknowledgments are unsequenced. The client can separately export its current snapshot as a JSON file using the desktop save dialog.

## 10. LAN Discovery (UDP)

Everything above runs over TCP. The one exception is **server discovery**, which needs a one-to-many "is anyone there?" that TCP cannot do. Discovery is a convenience only: the client dialog always keeps manual IP/port entry, and nothing in a session depends on UDP. It works with the internet disabled, since it uses only the local network.

**Exchange** (UDP/IPv4, default port `45454`, change with `--discovery-port`, disable with `--no-discovery`):

1. The client binds an ephemeral UDP socket, enables broadcast, and sends a **PROBE** to `255.255.255.255`, to the directed broadcast address of every external IPv4 interface (e.g. `192.168.1.255`, computed from address + netmask), and to `127.0.0.1` (a server on the same machine). Several targets are used because many OSes route the limited broadcast out of only one interface.
2. Every server that receives it answers the **sender directly (unicast)** with an **ANNOUNCE**.
3. The client collects replies for 1.5 s, de-duplicates by `name:port` (a server reachable on several addresses answers each probe; a real LAN address is preferred over loopback), and shows the list. Picking one fills in the host and port.

```json
{ "magic": "CN-WHITEBOARD", "v": 1, "type": "PROBE" }
{ "magic": "CN-WHITEBOARD", "v": 1, "type": "ANNOUNCE", "name": "lab-pc", "port": 4000, "rooms": 2, "appVersion": "1.0.0" }
```

**Safety properties**

- _No secrets._ An announcement never contains room codes, names or participants, only the server name, TCP port and a room _count_. Knowing a server exists grants nothing: joining still needs the room code and password, and the TCP layer's role checks and rate limits apply unchanged.
- _Strict parsing._ Datagrams over 512 bytes, non-JSON, wrong `magic`/`v`, or failing the zod schema are silently dropped.
- _No reflection abuse._ A responder answers at most 5 probes per second per source address, and replies are small and go only to the probing address.
- _Never fatal._ If the UDP port is taken or binding fails, the server logs a warning and keeps serving over TCP. Two servers on one machine can share the port (`SO_REUSEADDR`); if you need both discoverable by different clients, give them different `--discovery-port` values.
- _UDP is unreliable by design:_ a lost probe or reply just means the server is missing from that scan; scanning again fixes it.

Firewall note: the host firewall must allow inbound **UDP 45454** (in addition to the TCP port) for discovery to find that server; if it blocks it, typing the IP still works.

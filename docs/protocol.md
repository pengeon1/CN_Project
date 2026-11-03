# LAN Collaborative Whiteboard Protocol Specification (v1)

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
    "clientVersion": "0.1.0",
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
    "password": "labpassword123"
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
    "password": "labpassword123"
  }
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

Host updates a participant's role (`HOST`, `EDITOR`, `VIEWER`) or room lock status.

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
    "newRole": "VIEWER",
    "lockRoom": false
  }
}
```

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
    ]
  }
}
```

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
    "finalPoint": { "x": 260.0, "y": 195.0, "pressure": 0.4 }
  }
}
```

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

#### `OBJECT_DELETE` / `ERASE` (Client -> Server -> Broadcast)

Removes canvas objects by ID.

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
    "target_op_id": "f104f1ee-6c54-4b01-90e6-d701748f0805"
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
    "serverTs": 1730644870005
  }
}
```

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

Supplies missing sequenced operations, or a full snapshot if the gap exceeds `MAX_RESYNC_OPS_WINDOW` (500 ops).

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

## 5. Ordering, Concurrency, and Idempotency

### 5.1 Centralized Sequencing (`seq`)

1. The server is the **single source of truth** for operation ordering.
2. For every room, the server maintains an integer counter initialized at `0`.
3. When a mutating operation (`STROKE_*`, `SHAPE_*`, `OBJECT_*`, `ERASE`, `CLEAR_CANVAS`, `UNDO`, `REDO`, `CHAT_MESSAGE`) is accepted, the server increments the room's counter and assigns `seq = ++room.seq`.
4. The sequenced envelope is broadcast to all participants.
5. All clients apply operations **strictly in ascending `seq` order**.

### 5.2 Client Idempotency (`op_id`)

1. Every mutating operation generated by a client carries a unique client-generated UUID `op_id`.
2. The server records recently processed `op_id`s in an in-memory set (bounded to the last 10,000 ops).
3. If the server receives an operation with an `op_id` that has already been sequenced, the server does not re-apply the mutation. It returns an `ACK` echoing the previously assigned `seq`.
4. This ensures network retries or duplicated client submissions are completely harmless.

### 5.3 Optimistic Rendering & Reconciliation

1. **Local Drawing**: When a user draws with the pen tool, the client renders the stroke immediately onto an active local overlay canvas layer for instantaneous 60 FPS responsiveness.
2. **Batching**: The client batches collected pointer coordinates every ~20 milliseconds (`STROKE_BATCH_INTERVAL_MS`) and transmits `STROKE_POINTS`.
3. **Reconciliation**: When the server broadcasts back the echo of the stroke bearing its assigned `seq`, the client commits the stroke to its permanent synchronized canvas model and clears the temporary overlay.

---

## 6. Undo/Redo Semantics

Collaborative whiteboards with multiple simultaneous editors present concurrency conflicts if undo simply removes the last added element from the canvas. The protocol defines unambiguous undo/redo semantics:

1. **Per-User Local Stacks**:
   - Each client tracks its **own** operations in a local Undo stack.
   - User A clicking Undo **never** undoes or alters work authored by User B.
2. **Compensating Operations**:
   - Performing an Undo does not destructively modify server history. Instead, the client sends an `UNDO` operation referencing the target `target_op_id`.
   - The server sequences this `UNDO` operation like any other mutation (`seq = ++room.seq`) and broadcasts it to all peers.
   - All clients apply the compensating inversion (e.g. marking the targeted stroke as deleted).
3. **Conflict Resolution**:
   - If User A attempts to undo a shape that User B has subsequently deleted or that was cleared via `CLEAR_CANVAS`, the server rejects the undo as a no-op and notifies User A via an informational toast.
4. **Redo Invalidation**:
   - If a user performs any new canvas mutation after undoing, that user's local Redo stack is automatically cleared.

---

## 7. Connection Management & Recovery

```text
 Client                                         Server
   |                                              |
   | --- PING (every 5s) -----------------------> |
   | <--- PONG ---------------------------------- |
   |                                              |
   x [Socket Drop / Network Disconnection]        |
   |                                              | (Server drops socket after 15s)
   |                                              | [Broadcasts PARTICIPANT_LEFT]
   | --- Connect & HELLO -----------------------> |
   | <--- AUTH_OK (New socket, same session) ---- |
   | --- JOIN_ROOM (sessionToken, last_seq: 140)->|
   | <--- RESYNC_RESPONSE (ops 141..154) -------- |
   | [Client catches up & resumes collaboration]  |
```

1. **Heartbeat Monitoring**:
   - Clients send `PING` every `5000 ms`.
   - If the server receives no data from a socket for `15000 ms` (`HEARTBEAT_TIMEOUT_MS`), the server forcefully closes the socket and broadcasts `PARTICIPANT_LEFT`.
   - The room session and canvas state remain alive.
2. **Automatic Reconnection**:
   - Upon socket disconnection, the client displays a visible "Reconnecting..." banner and attempts to reconnect with exponential backoff (500ms, 1000ms, 2000ms, max 5000ms).
   - The client retains its `sessionToken` and `last_seq`.
3. **Resync Catch-Up**:
   - Upon reconnecting, the client sends `RESYNC_REQUEST` with its `last_seq`.
   - If `room.seq - last_seq <= 500`, the server transmits `RESYNC_RESPONSE` with only the missed incremental operations.
   - If `room.seq - last_seq > 500` (e.g. client was disconnected for hours), the server sends a full `ROOM_STATE` snapshot.

---

## 8. Security & Role-Based Access Control (RBAC)

1. **Room Authentication**:
   - Rooms are identified by a 6-character code (`ROOM_CODE_ALPHABET`).
   - Rooms optionally require a password. Passwords are never stored in plaintext; the server computes a salted cryptographic hash using Node.js built-in `crypto.scrypt`.
   - Failed authentication attempts are rate-limited per remote IP address to defend against brute-force attacks.
2. **Role Enforcement**:
   - **`HOST`**: Full control. Only the host can execute `CLEAR_CANVAS`, `PERMISSION_CHANGE` (promote/demote/kick), lock the room, and trigger server-side persistence (`SAVE_STATE`).
   - **`EDITOR`**: Can draw, modify own objects, create shapes, and chat.
   - **`VIEWER`**: Read-only observer. Cannot send canvas mutations. If a `VIEWER` client emits a drawing operation, the server rejects it with an `ERROR` message (`UNAUTHORIZED_ROLE`).
3. **Zero-Trust Input Validation**:
   - The server **never** trusts incoming client data.
   - Every received message envelope and payload is strictly validated via Zod schemas before entering the room operations queue. Invalid shapes, non-finite coordinates, and out-of-range dimensions are rejected at the protocol boundary.

# StompStation Pro / VoidX Node Protocol

Static reverse-engineering notes for building a Linux-compatible controller.

This document describes how the official **VoidX-Control** application talks to a
**StompStation Pro** (and other VoidX node-based devices). It focuses on:

- reading the current patch,
- reading which blocks are enabled,
- enabling/disabling blocks,
- changing patches,
- listing the patches stored on the device.

The protocol is a line-oriented JSON-over-text protocol carried over TCP, serial,
or BLE. The same node model is used for every VoidX device; the contents of the
tree differ per device/firmware.

---

## 0. TL;DR

- Devices advertise an mDNS service of type `_http._tcp.` with TXT keys
  `id`, `MAC`, and `name`. `id` must contain the marker `voidx`.
- Connect to the advertised `host:port` over TCP.
- On connect the app sends:
  1. `read root\sys\_name`
  2. `browse root`
- The `browse root` reply is a snapshot of the whole node tree, one
  `<nodePath>:<jsonNode>` line per node, lines separated by `\r\n` and the
  message terminated by `\0`.
- Every command is text:
  - `read <path>`
  - `browse root`
  - `write <path>:<json>`
  - `dread <listPath>:{"index":N,"chunk":M}`
  - `dwrite <listPath>:{"index":N,"chunk":M,"value":"<hex>"}`
  - `dmove <listPath>:{"index":N,"index2":M}`
- Outgoing messages must not contain `0x00`; the transport appends a single
  `0x00` terminator.
- A patch is a **preset**. The current patch name is the `value` of a
  `NodeParList` named `preset`. The patch names are the `value` array of the
  `NodeList` referenced by that node's `ref` field.
- The dynamic chain/backline is a `NodeRouter`. Its `value` field is a 2D array
  of strings; every non-empty cell is the full node path of a block `NodeItem`.
- A block is enabled/disabled by writing its `on_off` child enum:
  `write <blockPath>\on_off:{"value":"ON"}` or `"OFF"`.
- Change patch: `write <presetNodePath>:{"value":"<patchName>"}`.

---

## 1. What was analyzed

| Item | Value |
| --- | --- |
| Application | `VoidX-Control.app` |
| Version | `1.28.0` (build 35, from `Info.plist`) |
| Platform | macOS, Flutter (Dart AOT) |
| Flutter/Dart | Dart `3.13.2`, engine snapshot `0451907c2eaa8467e848c0067bfe8ed4` |
| Package | `dsp_nodes` (application code) |
| Analysis | Dart AOT snapshot parsed/decompiled with `dae`; class/method names and string literals recovered from the snapshot |
| Key decompiled areas | `dsp_nodes/system/nodes/*`, `dsp_nodes/system/connections/*`, `dsp_nodes/system/tcpip/*`, `dsp_nodes/system/serial/*`, `dsp_nodes/components/structure_drawer/dynamic_chain/*`, `dsp_nodes/system/lists_management.dart` |

Confidence tags used below:

- **Observed** — directly seen in decompiled code or string constants.
- **Inferred** — structurally implied by the code, but not exercised against
  hardware.
- **Unknown** — not recovered; must be confirmed with a device/capture.

---

## 2. Transport and discovery

### 2.1 Network (primary path)

**Observed** in `dart_socket_communication_interface.dart` and the string pool:

- mDNS/DNS-SD service type: `_http._tcp.`
- TXT record keys read by the app:
  - `id` — UTF-8 bytes; the decoded string must contain the marker `voidx`
    (the app logs `TCIPIPConnection: valid voidx identifier!`).
  - `MAC` — MAC address of the device; required.
  - `name` — human-readable device name; required.
- The app resolves the advertised host and port, builds an address string
  `"<host>:<port>"`, and opens a TCP socket.
- A local history list of `"<ip>:<port>"` addresses is kept and probed with a
  short TCP connect ("ping") to detect devices that are no longer present.

The connection object parses `"<host>:<port>"` by splitting on `":"`; the last
part is parsed as the port (`int.tryParse`). Logs:
`DartSocketConnection: created connection with IP: ..., and port: ...`.

**Inferred**: the port is whatever the device advertises in its mDNS SRV
record; there is no hard-coded port in the app.

### 2.2 Serial

**Observed** in `dart_serial_communication_interface.dart`:

- The app scans serial ports and probes them with:
  - `read root\sys\_name`
  - `read root\sys\_id`
- Responses are parsed as `<path>:{"value":"..."}`.
- Serial is used as an alternative to TCP; the node protocol is identical.

**Unknown**: exact baud rate / line settings. They are selected through the
bundled `libserialport` config; the value was not recovered from the binary.
If serial support is needed, capture the app's serial configuration on the
target or use the device's documented baud rate.

### 2.3 BLE

**Observed** (strings/class names): the app also has BLE interfaces
(`FlutterReactiveBle`, `FlutterBluePlus`, `WinBle`). BLE uses the same command
protocol over GATT writes/notifications. `Connection.getAtomicPacketSize()`
returns `1024`, used for BLE packetization/MTU handling.

For a first Linux implementation, TCP (and optionally serial) is recommended.

---

## 3. Framing and encoding

### 3.1 Outgoing messages

**Observed** in `connection.dart` (`Connection.writeAndWaitForResponse`,
`Connection.transmitMessage`) and the node write functions:

- Messages are strings. The app converts them to UTF-16/code units, checks that
  the payload contains no `0x00` (error string:
  `Connection - ERROR in writeAndWaitForResponse - original message contains zeros!.`),
  and appends a single `0x00` terminator before writing.
- Therefore the on-wire message is:
  `<ASCII/UTF-8 payload> 0x00`
- Node `write` builders also append `\r\n` to the JSON line. Examples:
  - `write <path>:{"value":"ON"}\r\n\0`
  - `write <path>:{"value":1.234567}\r\n\0`
- Non-`write` commands observed in the app do not add `\r\n` themselves
  (`read`, `browse`, `dmove`, `dread`, `dwrite`). **Recommendation:** send every
  command as `<command>\r\n\0`. This is compatible with the `write` framing and
  gives the device a clean line terminator for all commands.

### 3.2 Incoming messages

**Observed** in `NodesSystem.interpretMessage`, `Node.interpretMessage`,
`Connection.onNewReceivedData`:

- Response text is split by `\r\n`; each non-empty line has the form:

  ```text
  <nodePath>:<json>
  ```

- The first `:` separates path from JSON (paths themselves only contain
  backslashes, never colons).
- The `browse root` response starts with `root:{`.
- The app accumulates received bytes until the device's end-of-message marker
  arrives, then processes the message. The transport is NUL-terminated; the
  app normalizes the final line to end with CRLF before parsing.

**Observed** error/timeout strings:

```text
Connection: Timeout in receiving message. Message: ...
Connection: syntax error in token row: ...
```

**Unknown / verify**: the exact end-of-response delimiter on hardware. The
parser is CRLF-line based; sending requests CRLF+NUL terminated and reading
until the socket would be idle for a short time (e.g. 100-200 ms) works for a
first implementation, but confirm with a capture.

### 3.3 Chunked reads / writes

Large list elements (files, bundle data, WAV/IR/NAM payloads) are transferred in
chunks. The value is a hex string (two hex characters per byte).

Read request:

```text
dread <listPath>:{"index":<elementIndex>,"chunk":<chunkIndex>}
```

Response chunks:

```text
<listPath>:{"chunk":0,"value":"<hex>"}
<listPath>:{"chunk":1,"value":"<hex>"}
...
<listPath>:{"chunk":-1,"value":"<hex>"}   // last chunk
```

Write request:

```text
dwrite <listPath>:{"index":<elementIndex>,"chunk":<chunkIndex>,"value":"<hex>"}
```

- `chunk:-1` in a `dwrite` marks the final chunk.
- `dwrite` with `index` and `chunk:-1` and a value of 128 bytes of `00`
  (256 `"00"` hex characters) is used by the app's `deleteAtIdx` to blank a
  slot (observed; exact device semantics of deletion should be confirmed).

Move element:

```text
dmove <listPath>:{"index":<fromIndex>,"index2":<toIndex>}
```

---

## 4. Connection handshake

### 4.1 Normal (no password)

**Observed** in `device_connections.dart` (`DeviceConnections.connect` /
`onConnect`) and the serial interface:

1. Open the transport.
2. Send `read root\sys\_name`.
3. Expect a response beginning with `root` (otherwise the app logs
   `received a non valid ...`).
4. Send `browse root`.
5. Parse the browse response into the in-memory node tree.

After this, the app is "browsed" and can read/write nodes.

### 4.2 Optional password / token

**Observed** in `connection.dart` (`writeAndWaitForResponse`,
`Connection.generateToken`) and `hashString`:

- If the device requires a password, the device can send a line:

  ```text
  token <32-char-nonce> Y
  ```

  or with `N` instead of `Y`. The app:
  - splits the line on spaces; it must have exactly 3 fields,
  - requires the first field to be `token`,
  - stores the second field as the nonce,
  - treats the third field `Y` as "secure" (otherwise not secure).

- Once secure, every outgoing command is prefixed:

  ```text
  token <hash>\r\n<command>
  ```

- `<hash>` is produced by `hashString(password + nonce)`. The function is a
  proprietary hash (64-entry permutation table) that appends the literal salt
  `"voidxdevteam"` to its input. It is **not** a standard SHA/MD5 call.

**Unknown / verify**: the exact hash algorithm. If the StompStation Pro is used
without a password (the default in the app), no token prefix is needed.

### 4.3 Device information nodes

**Observed** system paths (fixed names under `root\sys`):

```text
root\sys\_id
root\sys\_name
root\sys\_author
root\sys\_color
root\sys\_license
root\sys\_logo
root\sys\_upd
root\sys\_ver

root\sys\alias
root\sys\color
root\sys\factory
root\sys\key
root\sys\pwd
root\sys\temp_unit

root\sys\wifi\ssid
root\sys\wifi\password
root\sys\wifi\state

root\app
root\app\on_off
```

Paths prefixed with `_` are read-only system information. `root\sys\pwd` is the
device password field.

**Observed** dynamic-chain-related paths (relative to the `master` item):

```text
\vol            -> master volume
\pst\level      -> preset level
\tempo_bpm      -> global tempo
\pst\tmp        -> preset tempo
```

---

## 5. Command set

| Command | Direction | Purpose |
| --- | --- | --- |
| `read <path>` | app -> device | Read one node (or list). Reply is `<path>:<json>`. |
| `browse <path>` | app -> device | Browse the node tree. The app uses `browse root`. Reply starts `root:{...}`. |
| `write <path>:<json>` | app -> device | Write one field of a node. |
| `dread <listPath>:{"index":N,"chunk":M}` | app -> device | Read a chunk of a list element. |
| `dwrite <listPath>:{"index":N,"chunk":M,"value":"<hex>"}` | app -> device | Write a chunk of a list element. |
| `dmove <listPath>:{"index":N,"index2":M}` | app -> device | Move/reorder a list element. |
| `token <hash>` | app -> device prefix | Optional password token line, followed by `\r\n` and the command. |

`write` JSON is always a small JSON object containing one or more of the node's
fields. The app itself sends exactly one field per write for values, but the
device accepts multiple fields (the browse snapshot and `save` use multiple).

---

## 6. Node tree and `browse root`

### 6.1 Path model

**Observed** in `node.dart` (`Node.getPath`) and `nodes_system.dart`:

- A node path is `root` followed by backslash-separated names:

  ```text
  root
  root\sys
  root\sys\_name
  root\something\amp
  root\something\amp\on_off
  ```

- `Node.getPath()` builds the path by walking `parent` links and joining names
  with `\`.
- Path lookup (`NodesSystem.getNodeFromPath`) requires the string to be exactly
  `root` or to start with `root\`; it splits on `\` and walks the children.

### 6.2 Browse response

**Observed** in `nodes_system.dart` (`NodesSystem` constructor):

- The browse response is a set of CRLF-separated lines:

  ```text
  root:{"type":"root", ...}
  root\sys:{"type":"item", ...}
  root\sys\_name:{"type":"item", ...}
  root\...\amp:{"type":"item", ...}
  ...
  ```

- Each line is split at the first `:` into `path` and `json`.
- The JSON is decoded and must contain a `"type"` field.
- The node's **name** is the last segment of the path; the **parent** is found
  by removing the last segment and looking up the parent path.
- Node types in the browse JSON:

  | `type` | Meaning |
  | --- | --- |
  | `root` | Root node (usually a `NodeItem`) |
  | `item` | Generic item/block/container (`NodeItem`) |
  | `float` | Floating-point parameter (`NodeFloat`) |
  | `enum` | Enumerated parameter (`NodeEnum`) |
  | `list` | List/array container (`NodeList`) |
  | `plist` | Parameter list / reference list (`NodeParList`) |
  | `ctrl` | Control/value (`NodeControl`) |
  | `action` | Action/button (`NodeAction`) |
  | `array` | Bulk numeric array (`NodeArray`) |
  | `router` | Dynamic-chain/router node (`NodeRouter`) |

- `item_type` inside an `item`/`list` can further classify the node. Observed
  values include:
  - `module`
  - `mctrl`
  - `block` (a chain effect block)
  - `pst...` (a preset list; `isPresetListNode` checks
    `item_type.startsWith("pst")`)
  - `wav...` (a WAV/file list)

**Observed error strings** (useful for diagnostics):

```text
NodesSystem: error 1 in constructing node: ...
NodesSystem: error 2 in constructing node: ...
NodesSystem: error 4 in constructing node (no type found): ...
NodesSystem: error 5 in constructing ROOT node: ...
NodesSystem: error 6 in constructing node: ...
NodesSystem: i tried to build this node twice: ...
Node.interpretField: typeError: Key: ...
```

Unknown JSON fields are ignored (the app logs a type error but keeps the node).
A Linux implementation should ignore unknown fields and unknown `type` values
gracefully.

---

## 7. Node JSON schema

### 7.1 Base node fields (all types)

**Observed** in `node.dart` (`Node.interpretField`):

| JSON key | Meaning |
| --- | --- |
| `desc` | Description string |
| `style` | UI/style string |
| `link` | Boolean link/association flag |

Name, parent, and children are not in the JSON; they come from the path and the
tree structure.

Common runtime fields (not necessarily in browse JSON):
- `name` — last path segment.
- `parent` — parent node.
- `children` — child nodes (built from paths).
- `lastUpdate` — timestamp.

### 7.2 Type-specific fields

**Observed** from each `NodeX.interpretField` implementation:

| Type | JSON keys |
| --- | --- |
| `root`, `item` (`NodeItem`) | `value` (string), `item_type` (string), `def` (string), `fixed` (bool) |
| `float` (`NodeFloat`) | `value` (number), `def` (number), `min` (number), `max` (number), `unit` (string), `dec` (number), `shape` (string), `inv` (bool/flag) |
| `enum` (`NodeEnum`) | `value` (string), `def` (string), `options` (array of strings) |
| `list` (`NodeList`) | `value` (array), `item_type` (string), `size` (int), `group` (string), `chunk` (int), `gzip` (bool), `move` (string), `used` (map/list) |
| `plist` (`NodeParList`) | `value` (string), `ref` (path string), `used` (map/list) |
| `router` (`NodeRouter`) | `value` (2D array), `def` (2D array), `fixed` (2D array) |
| `action` (`NodeAction`) | `value` (string), `action_type` (string) |
| `array` (`NodeArray`) | `value` (hex/binary string), `enc` (string), `dec` (string), `unit` (string), `min` (number), `max` (number) |
| `ctrl` (`NodeControl`) | `value` (string), `ref` (path string), `src` (string) |

Notes:

- `NodeFloat` values are sent with 6 decimal places:
  `write <path>:{"value":1.234567}`.
- `NodeEnum` and `NodeItem`/`NodeParList` string values:
  `write <path>:{"value":"<string>"}`.
- `NodeRouter` value is serialized as JSON (for example
  `{"value":[["root\\...\\amp",""],["root\\...\\drive",""]]}`).
- `NodeArray` writes a binary/encoded payload as a string; this is used for
  bulk arrays (EQ curves, IR/NAM data, etc.), not for patch selection.

### 7.3 Lists and parameter lists

**Observed**:

- `NodeList.value` is an array. For patch lists this is the list of patch names.
- `NodeList.item_type` identifies the kind of list:
  - `pst...` — preset/patch list.
  - `wav...` — WAV/file list.
  - `block` — block list (for the chain picker).
- `NodeList.size` (printed as `itemSize` by `NodeList.toString`) is the byte
  size of the list payload, not the number of names. For preset lists the patch
  count is simply `len(value)`. `chunk` is used for chunked loading; `gzip`
  indicates whether a chunked payload is gzip-compressed.
- `NodeParList.ref` is the path of the referenced `NodeList`.
- `NodeParList.value` is the currently selected option (for `preset`, the
  current patch name).
- `NodeParList.used` records used elements/dependencies.

---

## 8. Patches (presets)

### 8.1 How the app identifies the patch list

**Observed** in `nodes_utils.dart`:

- `isPresetNode(path)`:
  - the node name is `preset`,
  - it is a `NodeParList` (`plist`),
  - its `ref` points to a `NodeList`,
  - the referenced list's `item_type` starts with `pst`.
- `isPresetListNode(path)`:
  - the node is a `NodeList`,
  - its `item_type` starts with `pst`.

So the patch model is:

```text
<NodeParList name="preset" value="<current patch>" ref="<path to pst list>">
    |
    +-- ref: <NodeList item_type="pst..." value=["Patch A", "Patch B", ...]>
```

### 8.2 Getting the list of patches on the device

**Observed** in `node_par_list.dart` (`NodeParList.getAllOptions`) and
`node_preset_drawer.dart`:

1. `browse root` (or `read <presetListPath>`).
2. Find the `preset` `NodeParList` (or any `plist` whose `ref` is a `pst` list).
3. Read the referenced `NodeList`'s `value` array. It is the ordered list of
   patch names on the device (`len(value)` = number of patches).
4. `NodeList.size`/`itemSize` is the payload byte size (used for chunked file
   reads), not the name count. If the list is chunked or `value` is incomplete,
   fetch the remainder with `dread`:

   ```text
   dread <presetListPath>:{"index":<slot>,"chunk":0}
   ```

   and concatenate the hex `value` chunks until `chunk:-1`.

The app displays these names in the preset drawer and uses `indexOf` on them to
determine the selected slot.

### 8.3 Reading the current patch

**Observed**:

- The current patch is the `value` string of the `preset` `NodeParList`.
- It is also derivable from the `NodeList` `value` array plus the index stored
  in the preset node, but the direct read is simpler:

  ```text
  read <presetNodePath>
  ```

  Response:

  ```text
  <presetNodePath>:{"type":"plist","value":"<current patch>","ref":"<list path>",...}
  ```

- The app also finds the current index with `indexOf(currentValue)` in the
  referenced list.

### 8.4 Changing patch

**Observed** in `node_preset_drawer.dart` (next/previous/pick callbacks) and
`node_par_list.dart` (`setDynamicValueAndGetMsg`):

```text
write <presetNodePath>:{"value":"<patchName>"}
```

This selects/loads the patch named `<patchName>` from the preset list. Both the
"next/previous patch" buttons and tapping a name in the list use this write.

### 8.5 Saving / saving as

**Observed** in `node_preset_drawer.dart` (`txSave`):

```text
write <presetNodePath>:{"value":"<patchName>","save":"save"}
```

- `value` is the target slot/name.
- The literal `"save":"save"` tells the device to persist the current patch into
  that slot.
- The app's `save()` uses the current name; `saveAs()` asks for a new name and
  sends the same shape.

### 8.6 Moving / renaming / deleting / uploading / downloading

**Observed** in `lists_management.dart` (all take the preset list path and an
index):

- Move a patch within the list:

  ```text
  dmove <presetListPath>:{"index":<from>,"index2":<to>}
  ```

- Rename: implemented as a write of the list element (the app's `renameAtIdx`
  uses the same chunked write path with the new name).
- Delete: the app's `deleteAtIdx` writes a final chunk (`chunk:-1`) containing
  128 zero bytes as `"00"` hex pairs to the slot. Confirm on hardware whether
  this clears the slot or marks it free.
- Upload/download of a whole patch bundle:
  - `dwrite <presetListPath>:{"index":<slot>,"chunk":<n>,"value":"<hex>"}` for
    each chunk, final chunk `chunk:-1`.
  - `dread <presetListPath>:{"index":<slot>,"chunk":<n>}` to download, until a
    response with `"chunk":-1`.
  - The payload is a bundle (the app works with `bdinfo.json`,
    `dependencies/`, `preset/`, `.nam`, WAV/IR files, and optional gzip). The
    bundle format is outside the scope of this document; start by decoding the
    hex chunks to bytes and inspecting the archive.

**Observed** error strings for list operations:

```text
target is not a preset list
preset target slot is invalid or occupied
bundle belongs to another preset list
missing bdinfo.json
DownloadAtIdx. Invalid gzip data size
```

---

## 9. Current patch, dynamic chain, and enabled blocks

### 9.1 Patch vs. chain

The **patch** is the preset selection (section 8). The **chain** (the ordered
set of effect blocks, with series/parallel routing) is stored in a `NodeRouter`
node inside the current patch's subtree. The app calls the chain view the
"DynamicChain".

### 9.2 Router node

**Observed** in `node_router.dart`, `dynamic_chain.dart`, `picker.dart`:

- A router is a node with `type:"router"` (`NodeRouter`, class id `0x9b7`).
- Its fields:
  - `value` — the **current** routing matrix (2D array of strings).
  - `def` — the **default** routing matrix.
  - `fixed` — a parallel matrix of fixed/locked positions.
- `NodeRouter.getActualValue()` returns `value`, or a temporary "dynamic" value
  while a drag/edit is in progress.
- Each non-empty cell in `value` is a **full node path** to a block `NodeItem`
  (for example `root\...\amp`). Empty cells are `""`.
- The matrix shape/positions encode the chain topology (series/parallel). The
  app edits the matrix and writes the whole matrix back.
- `NodeRouter.toString()` format for diagnostics:

  ```text
  <path> - value:<value> - default:<def>, fixed:<fixed>, desc: <desc>
  ```

- The app's local UI stores only a selection key, `block:<row>:<col>`, in
  session data; this is not sent to the device.

### 9.3 Finding the current chain/router

**Observed** in `dynamic_chain.dart` (`initializeRelatedNodes`,
`currentRouter`) and `picker.dart`:

- A chain container is the router's parent. It has:
  - a child `item` named `master`,
  - child `item`s whose `item_type` is `block` (the available effect blocks),
  - the `router` node itself.
- `initializeRelatedNodes` finds the `master` item among the router parent's
  children and resolves:

  ```text
  <master>\vol
  <master>\pst\level
  <master>\tempo_bpm
  <master>\pst\tmp
  ```

  and checks they are `NodeFloat` nodes.

**Inferred**: each preset/chain container has its own router and block pool;
with a full `browse root` snapshot, locate the router whose parent contains the
`master` item and whose preset name matches the current preset `value`, or (if
only one router is present) use that router.

A robust Linux implementation can:

1. Build a map `path -> node JSON` from `browse root`.
2. Find all `type:"router"` nodes.
3. For each, take its parent path and look for a child named `master`; that
   identifies a chain container.
4. Select the router under the container corresponding to the current preset
   (name match), or prompt/choose if there are multiple.

### 9.4 Reading which blocks are in the current patch / enabled

**Observed** in `dynamic_chain.dart` (`blockPositions`, `deriveSelectedFx`,
`buildRouterBlock`), `fx_block.dart`, `nodes_utils.dart`
(`getOnOffNode`, `isOnOffNode`, `onOffNodeIsActive`):

1. Read the router's `value` matrix.
2. Iterate rows and columns; every non-empty cell is a block path.
3. Resolve each block path to its `item` node.
4. The block's enabled state is a child enum named `on_off`:

   ```text
   <blockPath>\on_off
   ```

   - `on_off` is a `NodeEnum` (`type:"enum"`, class id `0x9bc`).
   - It has exactly 4 options.
   - The first option is `"ON"` and the last is `"OFF"`.
   - Its current `value` is `"ON"` when the block is enabled, `"OFF"` when
     disabled.
   - `onOffNodeIsActive` returns true when `value == "ON"`.

So:

```text
Block in chain      = non-empty cell in router.value
Block enabled       = <blockPath>\on_off value == "ON"
Block disabled      = <blockPath>\on_off value == "OFF"
```

The app's `FxBlock.build()` gets the block node and its `on_off` node, reads the
`on_off` value, and treats `"OFF"` as inactive.

### 9.5 Enabling / disabling a block

**Observed** in `node_enum.dart` (`NodeEnum.setDynamicValueAndGetMsg`) and
`fx_block.dart`:

```text
write <blockPath>\on_off:{"value":"ON"}
write <blockPath>\on_off:{"value":"OFF"}
```

This is the exact mechanism used by the block power toggle.

The app may also batch several `write` lines into one message (CRLF-separated)
when applying defaults (see 9.7).

### 9.6 Adding / removing / reordering blocks in the chain

**Observed** in `dynamic_chain.dart` (`writeRouterItem`,
`writeRouterAndDefaultActiveBlocks`, `emptyRouter`, `restoreRouterDefaults`)
and `picker.dart` (`addBlock`, `usedBlockPaths`):

- The device already exposes the available block nodes as `item` children with
  `item_type == "block"` under the chain container. The app does **not** create
  nodes for new blocks; it only references existing block paths in the router
  matrix.
- To add a block:
  1. Pick an available block item path (from the, chain container's children
     with `item_type:"block"`, excluding paths already present in the matrix).
  2. Build a new matrix equal to the current `value` with the block path placed
     at the desired row/column.
  3. Write the **whole matrix back**:

     ```text
     write <routerPath>:{"value":<new 2D array>}
     ```

- To remove a block: write the matrix with that cell set to `""` (and possibly
  remove the row/column if the app does so).
- To reorder/move: write the matrix with the path at the new position.
- "Empty chain" uses `""` cells. The app's `emptyRouter` resets the matrix to
  empty strings while preserving fixed positions.
- The app writes the router and then sends a "default active blocks" message
  that turns on the newly placed block(s) and their default sub-blocks
  (see 9.7).

The matrix is a JSON array of arrays, e.g.:

```json
{"value":[
  ["root\\...\\drive","root\\...\\amp"],
  ["", "root\\...\\cab"]
]}
```

(Backslashes are escaped in JSON. The actual path strings contain single
backslashes.)

### 9.7 Default active blocks / enablers

**Observed** in `dynamic_chain.dart` (`defaultActiveBlocksMessage`) and
`nodes_system.dart` (`compileEnablerNodesCache`, `getEnablersOf`):

- For each node, the app caches the paths of the `on_off` nodes of the node and
  its ancestors ("enablers").
- After writing the router, the app builds a batch of `write` lines that turn on
  the default-enabled blocks/sub-blocks. The payload is a concatenation of:

  ```text
  write <onOffPath>:{"value":"ON"}\r\n
  ```

- A Linux implementation can:
  1. Write the router matrix.
  2. For each newly added block, write `"ON"` to the block's `on_off` and to the
     `on_off` of its ancestor blocks (walk parents and look for an `on_off`
     child).
  3. Optionally reproduce the app's exact default selection by reading the
     block's `def` fields.

For a first working version, enabling the block's own `on_off` is sufficient to
hear/see it; ancestor enablers matter when the block is nested in a module or
sub-chain.

---

## 10. File / blob lists (for completeness)

**Observed** in `lists_management.dart`:

- `NodeList` nodes with `item_type` starting `wav` are file lists; the same
  `dread`/`dwrite`/`dmove` commands are used.
- The `value` of a `dread` response is hex-encoded bytes.
- `getFilesNameAndContent` validates `node.itemSize` against the decoded
  content length; `gzip` means the concatenated chunks are gzip-compressed.
- The app also supports `.nam`, IR, WAV, `preset/`, `dependencies/`, and a
  `bdinfo.json` manifest for bundles. The exact bundle format should be
  reverse-engineered separately if patch import/export is required.

---

## 11. Recommended Linux implementation flow

Language-agnostic pseudo-code:

```text
# 1. Discovery
services = mdns.discover("_http._tcp.")
for s in services:
    txt = s.txt_records
    if not txt["id"].decode("utf-8").contains("voidx"): continue
    if not txt["MAC"] or not txt["name"]: continue
    address = resolve_host(s) + ":" + s.port

# 2. Connect
sock = tcp.connect(address)

# 3a. Optional auth
#     If the device sends a "token <nonce> Y" line first, respond with
#     "token <hash>" on every command. Otherwise skip.

# 3b. Identify + browse
send("read root\\sys\\_name")
name_resp = recv_until_nul()          # root\sys\_name:{"value":"..."}
send("browse root")
browse = recv_until_nul()             # multi-line "path:json" snapshot

# 4. Build the tree
nodes = {}
for line in browse.split("\r\n"):
    path, json_text = line.split(":", 1)
    nodes[path] = json.loads(json_text)
    nodes[path]["_path"] = path
    nodes[path]["_name"] = path.split("\\")[-1]

# 5. Find the patch list and current patch
preset = first(n for n in nodes.values()
               if n["type"] == "plist"
               and n["_name"] == "preset"
               and nodes[n["ref"]]["type"] == "list"
               and nodes[n["ref"]]["item_type"].startswith("pst"))
preset_list_path = preset["ref"]
patch_names = nodes[preset_list_path]["value"]
current_patch = preset["value"]

# 6. Find the current chain/router
#    Router cells are full block paths. Prefer the router under the
#    current preset container; fall back to the only router.
router = choose_router(nodes, current_patch)
matrix = router["value"]

# 7. Read enabled blocks
enabled = []
for row in matrix:
    for cell in row:
        if cell == "": continue
        block = nodes[cell]
        on_off_path = cell + "\\on_off"
        on_off = nodes[on_off_path]
        enabled.append({
            "path": cell,
            "name": block.get("name", cell),
            "on": on_off["value"] == "ON",
        })

# 8. Enable/disable a block
send('write ' + block_path + '\\on_off:{"value":"ON"}')
send('write ' + block_path + '\\on_off:{"value":"OFF"}')

# 9. Change patch
send('write ' + preset_path + ':{"value":"' + patch_name + '"}')

# 10. Save current patch
send('write ' + preset_path + ':{"value":"' + patch_name + '","save":"save"}')
```

Notes for the implementation:

- Always JSON-escape backslashes and quotes in paths when building JSON (the
  path itself is literal; only the JSON string needs escaping).
- Send `<command>\r\n\0` and read until the response is complete. A short idle
  timeout (100-200 ms) is a pragmatic first implementation; confirm the actual
  end-of-message marker with a capture.
- Treat the browse snapshot as a read-only model and apply your own writes
  locally (the app does this) so the UI stays consistent.
- Ignore unknown node types and unknown JSON fields.
- If a list is partially loaded/chunked, fetch the remaining elements with
  `dread` and decode the hex chunks. `itemSize` is a byte count, not an
  element count.

---

## 12. Open questions / verification checklist

These were not fully resolved statically and should be confirmed against a real
StompStation Pro (or a packet capture of the official app):

1. **Exact end-of-response marker.** The app is clearly CRLF-line based and
   NUL-terminated on TX. Confirm whether the device terminates multi-line
   browse replies with `\0`, `\r\n\r\n`, or another marker.
2. **Full browse snapshot vs. active patch only.** The app does not re-browse
   on every preset change. Confirm whether `browse root` includes every preset's
   chain subtree, or whether the device pushes updates. If it is only the
   active patch, re-browse (or read the relevant paths) after changing patch.
3. **TXT `id` format.** The marker `voidx` is required inside the `id` TXT
   value; the exact format (prefix, JSON, etc.) should be captured from a
   device.
4. **Token hash.** The app uses a proprietary hash that appends
   `"voidxdevteam"` and a 64-entry permutation. If the device is protected by a
   password, this algorithm must be recovered exactly (or the password disabled)
   for a Linux client to authenticate.
5. **Serial settings.** Baud rate/parity/stop bits were not recovered. Capture
   the app's serial configuration or use the device documentation.
6. **Router matrix geometry.** The matrix encodes series/parallel topology.
   Preserve the existing shape and only insert/remove/move paths; do not assume
   rows/columns mean a specific topology until verified.
7. **Delete/list-element semantics.** The `dwrite` zero-fill used by
   `deleteAtIdx` should be verified to ensure it deletes rather than corrupts a
   slot.
8. **Patch bundle format.** `bdinfo.json`, `preset/`, `dependencies/`, `.nam`,
   IR/WAV data, and gzip handling are not documented here.

---

## 13. Appendix: constants and source map

### 13.1 Important literals

| Literal | Meaning |
| --- | --- |
| `_http._tcp.` | mDNS service type |
| `id`, `MAC`, `name` | mDNS TXT keys |
| `voidx` | Marker required inside TXT `id` |
| `read ` | Read command |
| `browse root` | Browse command |
| `write ` | Write command |
| `dread ` | Chunked read command |
| `dwrite ` | Chunked write command |
| `dmove ` | Move command |
| `token ` | Auth prefix |
| `on_off` | Block enable enum child name |
| `ON` / `OFF` | Enable enum values |
| `value` | Generic value JSON key |
| `index`, `index2` | List index / destination index |
| `chunk` | Chunk index; `-1` = last |
| `save` | `{"save":"save"}` persists a preset |
| `type` | Browse node type discriminator |
| `item_type` | Node subclass/role discriminator |
| `ref` | `NodeParList` reference to a `NodeList` |
| `used` | Used elements/dependencies |
| `def` | Default value/matrix |
| `fixed` | Fixed/locked matrix positions |
| `options` | Enum option list |
| `block` | `item_type` of chain effect blocks |
| `pst...` | `item_type` prefix of preset lists |
| `wav...` | `item_type` prefix of WAV/file lists |
| `voidxdevteam` | Salt appended by the password hash |

### 13.2 Decompiled source map

| Protocol area | Decompiled file / functions |
| --- | --- |
| Node model | `dsp_nodes/system/nodes/node.dart` — `getPath`, `interpretMessage`, `interpretField` |
| Tree parsing | `dsp_nodes/system/nodes/nodes_system.dart` — constructor, `getNodeFromPath` |
| Values | `node_float.dart`, `node_enum.dart`, `node_item.dart`, `node_list.dart`, `node_par_list.dart`, `node_router.dart`, `node_action.dart`, `node_array.dart`, `node_control.dart` |
| Framing | `dsp_nodes/system/connections/connection.dart` — `writeAndWaitForResponse`, `transmitMessage`, `onNewReceivedData`, `generateToken` |
| TCP | `dsp_nodes/system/tcpip/dart_socket_connection.dart`, `dart_socket_communication_interface.dart` |
| Serial | `dsp_nodes/system/serial/dart_serial_connection.dart`, `dart_serial_communication_interface.dart` |
| Discovery/connect | `dsp_nodes/system/connections/device_connections.dart`, `connections_set.dart` |
| Patches | `dsp_nodes/system/lists_management.dart`, `components/single_parameter_drawer/node_preset_drawer.dart` |
| Chain/blocks | `components/structure_drawer/dynamic_chain/dynamic_chain.dart`, `fx_block.dart`, `picker.dart`, `fx_connection.dart` |
| Enablers | `dsp_nodes/system/nodes/nodes_system.dart` — `compileEnablerNodesCache`, `getEnablersOf`; `nodes_utils.dart` — `getOnOffNode`, `isOnOffNode`, `onOffNodeIsActive` |

---

*End of document.*

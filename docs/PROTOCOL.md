# StompStation PRO — Reverse-Engineered Control Protocol

> Reference document for building third-party software (e.g. a Linux tool) to control the
> **Sonulab StompStation PRO** guitar pedal and load NAM / IR files.
>
> Sources: Frida USB/BT captures of the official **VoidX-Control** app
> (`capture2.txt`, `capture3.txt`) and static analysis of the firmware
> (`s_pro_2_2_6.upd`, an ARM64 Linux ELF for the pedal's Raspberry Pi).

---

## 1. Overview

- The pedal is a Raspberry Pi running Linux.
- It exposes the **same control protocol over three transports**:
  USB CDC-ACM serial (`/dev/ttyACM0` on Linux, `/dev/cu.usbmodem*` on macOS),
  Bluetooth SPP, and Wi-Fi TCP. No encryption on this path.
- The protocol is **plain-text, line/record oriented**, JSON values for parameters,
  null-byte (`\0`) terminated commands.

---

## 2. Transport & Framing

### Request (host → pedal)

```
<verb> <path>[:<json>]\0
```

- Terminated by a single null byte `0x00`.
- No newlines in the request.

### Response (pedal → host)

```
<path>:<json>\r\n<path>:<json>\r\n...\0
```

- One or more `path:json` entries separated by `\r\n` (`0x0D 0x0A`).
- The whole response is terminated by a null byte `0x00`.

### Value encoding

Parameter values are JSON objects:

```json
{"value": "ON"}                       // string (enums, on/off, names)
{"value": 0.000000}                   // float
{"value": 5}                          // int
{"value": ["name1","name2", ...]}     // array (e.g. preset lists)
{"value": "X", "style": "visible:false;"}   // value + UI style hint
```

---

## 3. Command Reference

| Verb | Format | Purpose |
|------|--------|---------|
| `read`   | `read <path>\0` | Read **changed** params (delta). `read root` = poll. |
| `browse` | `browse <path>\0` | Read the **full** subtree (all params + metadata) — not a delta. |
| `write`  | `write <path>:{"value":<v>}\0` | Set a parameter (block state, preset, any scalar). |
| `dwrite` | `dwrite <path>:{"index":N,"chunk":C,"value":"<hex>"}\0` | Chunked binary upload (NAM / IR files). |

Other verbs seen in the firmware (not yet needed for control): `dread`, `dswap`,
`dmove`, `supd`, `upd`, `token`, plus the `list` sub-command.

### `read` vs `browse` (important)

- **`read root`** returns only the parameters whose value changed since the last read
  (a delta). Most polls return just `usb_status` + the live meters.
- **`browse root`** returns the **entire** tree (613 params, ~98 KB on v2.2.6), each with
  full metadata: `{"desc","value","type","item_type","def","min","max","unit",…}`.

A third-party client should use **`browse root` once at startup** (to populate full
state), then **`read root` for continuous polling**.

### ACK behaviour

A `write` is acknowledged by the pedal echoing the parameter back:

```
write root\app\drive\on_off:{"value":"ON"}\0
→  root\app\drive\on_off:{"value":"ON"}\0
```

`dwrite` (file upload) chunks are interleaved with the app's continuous `read root`
polling; there is **no separate "commit" command** — the short/empty final chunk
terminates the transfer.

### ⚠️ `dwrite` is ACK-driven (critical)

The device **acknowledges every `dwrite` chunk** with a response echoing the command
path plus the *next* expected chunk number:

```
dwrite root\nam_amp:{"index":23,"chunk":0,"value":"<hex>"}\0
→  dwrite root\nam_amp:{"index":23,"chunk":1}\0          // send me chunk 1
dwrite root\nam_amp:{"index":23,"chunk":1,"value":"<hex>"}\0
→  dwrite root\nam_amp:{"index":23,"chunk":2}\0
...
dwrite root\nam_amp:{"index":23,"chunk":131,"value":"<hex>"}\0
→  dwrite root\nam_amp:{"index":23,"chunk":-1}\0         // done
```

- `chunk` = the next expected chunk number.
- `chunk:-1` = upload **complete**.
- `index:-1` = upload **rejected** (bad slot / malformed chunk).

A correct uploader must **send one chunk, then wait for the ACK** before sending the
next — the ACK is the flow-control/pacing mechanism. Blasting all chunks without
waiting for ACKs desynchronises the device and it rejects the upload.

### ⚠️ The final NAM chunk needs a `"gz"` terminator + padding

For a NAM (gzip) upload, the **last data chunk's value** is *not* pure hex — it ends
with the literal marker `"gz"` followed by null padding, making the decoded payload
exactly **1025 bytes**:

```
value = gzip_tail.hex() + "gz" + ("00" * (1025 - len(gzip_tail) - 2))
```

The device's hex-decoder stops at `"gz"` (non-hex) and treats it as the end-of-upload
marker. Without it, the device ACKs `chunk:131` (i.e. "send more") instead of `-1`, and
the model never lands. (IR uploads — a fixed 8192 bytes of float32 — do **not** need
this; the last full chunk alone triggers `chunk:-1`.)

### Slot selection caveat

A slot is "free" when its name is an empty string in the list, but on the test device the
empty NAM slots (indices 20–22) did **not** accept uploads (the model never appeared),
while overwriting an occupied slot (e.g. 23) worked. IR free slots accepted uploads
normally. Treat empty-string detection as a hint, not a guarantee.

### ⚠️ `read root` is a *delta* poll (important)

`read root` returns **only parameters whose value has changed since the last read**, not
the whole tree. In practice each poll returns `root\usb\_status` plus the live meters
(which change continuously). Static parameters (block on/off, preset name) appear in the
response **only when they change** (e.g. right after a `write`, or after a preset change,
which dirties everything and produces a large full-tree response).

Consequences for a third-party client:

- Use **`browse root` once at startup** to get the full tree (see §3).
- To *observe* live state, poll `read root` continuously and **merge** results into a
  local cache (`path -> value`).
- To *set* a value, use `write <path>:{"value":…}` and rely on the immediate echo + the
  changed param showing up in the next poll.

> Note: multiple clients polling `read root` simultaneously will steal each other's
> deltas — don't run two instances of the same tool at once.

---

## 4. Parameter Tree

Top-level nodes returned by `read root\0`:

| Path | Meaning |
|------|---------|
| `root\app\preset` | Current preset name (string) |
| `root\app\router` | Signal-chain order (array of block paths) |
| `root\app\<block>\…` | Per-block parameters (see §5) |
| `root\sys\_meters\_in0/1` | Input meters (live, float dB) |
| `root\sys\_meters\_out0/1` | Output meters (live, float dB) |
| `root\usb\_status` | USB connection state (`"ON"`/`"OFF"`) |
| `root\nam_amp` | NAM amp slot list (64 names) |
| `root\ir_list` | IR slot list |

Example (`read root` response fragment):

```
root\app\preset:{"value":"Match Brave No Cab"}
root\app\router:{"value":[["root\\app\\gate","s","root\\app\\pitch","s", ... ]]}
root\usb\_status:{"value":"OFF"}
root\sys\_meters\_in0:{"value":-109.289490}
root\app\drive\on_off:{"value":"OFF"}
...
```

---

## 5. Blocks & Signal Chain

`root\app\router` holds the chain, in order:

```
gate → pitch → exp → comp → mod_pre → drive → amp → ir → eq → [blank] → mod → delay → reverb → [blank]
```

### Block on/off (enable / disable)

Every block exposes its state at `root\app\<block>\on_off` with value `"ON"` / `"OFF"`.

```bash
# Enable Drive/Distortion
write root\app\drive\on_off:{"value":"ON"}\0
# Disable Modulation
write root\app\mod_pre\on_off:{"value":"OFF"}\0
```

### Block ↔ param-path mapping

The 12 blocks in the signal chain (`root\app\router`) use their **slot name** as the param
path. Confirmed against a live full-tree dump:

| UI block | on/off param path |
|----------|-------------------|
| Noise Gate | `root\app\gate\on_off` |
| Pitch | `root\app\pitch\on_off` |
| Expression | `root\app\exp\on_off` |
| Compressor | `root\app\comp\on_off` |
| Modulation (pre) | `root\app\mod_pre\on_off` |
| Drive / Distortion | `root\app\drive\on_off` |
| Amp (NAM) | `root\app\amp\on_off` |
| IR / Cabinet | `root\app\ir\on_off` |
| EQ | `root\app\eq\on_off` |
| Modulation (post) | `root\app\mod\on_off` |
| Delay | `root\app\delay\on_off` |
| Reverb | `root\app\reverb\on_off` |

> There are also **alternate block types** not in the default chain, each with its own
> `on_off`: `pitch_time`, `dyna_comp`, `eq2`, `parametric_eq`, `crossover`, `delay2`,
> `reverb2`, `chorus`, `flanger`, `rotary`, `pickup`, `dtchr`, `pcm42`.

Other common parameters follow the same `write <path>:{"value":…}` pattern, e.g.:

```
root\app\drive\model:{"value":"The Green Box"}     // enum
root\app\delay\mix:{"value":27.222080}            // float
root\app\mod_pre\mode:{"value":"Chorus"}          // enum
```

---

## 6. Setting the Active Patch

```
write root\app\preset:{"value":"<preset name>"}\0
```

The value is the preset **name string**, e.g. `"Match Brave No Cab"`.

---

## 7. NAM (.nam) Upload

Command shape:

```
dwrite root\nam_amp:{"index":<slot>,"chunk":<n>,"value":"<hex>"}\0
```

- `index` — target amp slot (0–63; the capture used `23`).
- `chunk` — 0-based chunk index.
- `value` — lowercase **hex** string of the chunk bytes.

### Data layout

| Chunk | Size (raw bytes) | Content |
|-------|------------------|---------|
| `0` | 128 | Display name, NUL-padded (e.g. `"65 Champ 10 CLN"` + `0x00`…) |
| `1 … N` | 1024 each | The **gzip-compressed model** |
| last | ≤1024 | Tail of the gzip stream (may be shorter) |

### The exact transform the app applies

1. Read the `.nam` file (it is JSON text; e.g. 295,888 bytes).
2. **Zero-pad to exactly 1 MiB** (`1,048,576` bytes).
3. **gzip** the padded buffer — **at compression level 6** (level 9's deflate output
   is *rejected* by the device's decompressor; level 6 produces the `XFL=0` header the
   app uses).
4. Split into 1024-byte chunks; hex-encode each; upload as `dwrite`. The **last** chunk
   carries the `"gz"` + null terminator (see above).

Verified: reassembling chunks + gunzip reproduces the byte-exact `.nam` file followed by
`752,688` null bytes (the 1 MiB pad).

```
payload = gzip.compress( nam_file_bytes + b"\x00" * (1048576 - len(nam_file_bytes)),
                         compresslevel=6 )
```

---

## 8. IR (.wav) Upload

Command shape:

```
dwrite root\ir_list:{"index":<slot>,"chunk":<n>,"value":"<hex>"}\0
```

- `index` — target IR slot (capture used `40`).
- `chunk` — 0-based.
- `value` — lowercase hex.

### Data layout

| Chunk | Size (raw bytes) | Content |
|-------|------------------|---------|
| `0` | 128 | Display name, NUL-padded |
| `1 … 8` | 1024 each | **2048 × float32** samples (8 × 1024 = 8192 bytes) |

### The exact transform the app applies

1. Read the WAV (24-bit PCM, mono, 48 kHz — other formats presumably accepted).
2. Decode each 24-bit little-endian sample to signed integer `v`.
3. Convert to float32 with a fixed gain:

```
float = v / 2^23 * 0.3191413049364811
      = v * 3.8044608227787146e-08
```

   (equivalently `v / 8388608.0 * 0.3191413` — a fixed ≈ −9.92 dB gain; the constant is
   empirical to ~5 significant figures. Byte-exact reproduction of the app's float32
   arithmetic differs by ≤1 LSB, which is inaudible and irrelevant for loading IRs.)
4. Take the **first 2048 samples** (truncate, no resampling).
5. Pack as little-endian float32; hex-encode; upload in 1024-byte chunks.

Verified: `IR[i] = WAV[i] * 0.3191413` holds to float32 precision across all samples.

---

## 9. The "Heartbeat" (ignore for control)

During capture the app also exchanges fixed 24-byte messages on a **socketpair internal
to the app** (two fds, one write / one read). Content is a timestamp + counter:

```
ff ff ff ff ff ff ff ff  |  63 f9 3a 6f 59 82 13 00  |  <counter>  |  00 00 00 00
```

This is the app's own poll-pacing/wakeup, **not** device communication. The real device
channel is the fd carrying `read`/`write`/`dwrite` traffic.

> Note: the device fd number varies between runs (23, 26, 17 observed) — identify it as
> the fd with bidirectional traffic **other than** the 24-byte heartbeat.

---

## 10. Reference client algorithm (Linux / USB)

```
1. open /dev/ttyACM0  (CDC-ACM serial)
2. send b"read root\0"; parse path:json entries until \0
3. toggle block:   b'write root\\app\\drive\\on_off:{"value":"ON"}\0'
4. set preset:     b'write root\\app\\preset:{"value":"Name"}\0'
5. load NAM:
     payload = gzip(nam_bytes + zeros(1MiB - len(nam_bytes)))
     send b'dwrite root\\nam_amp:{"index":N,"chunk":0,"value":"<hex name>"}\0'
     for i, chunk in enumerate(chunks(payload, 1024)):
         send b'dwrite root\\nam_amp:{"index":N,"chunk":%d,"value":"%s"}\0' % (i+1, chunk.hex())
6. load IR:
     samples = first 2048 wav samples, each = int24/2^23*0.3191413 (float32 LE)
     send name chunk + 8 data chunks via root\ir_list
```

### Serial-port framing note

Each command is a single `write()` of the full string **including the trailing `\0`**.
Reads are variable-length; buffer until a `\0` to delimit a complete response.

---

## 11. Open Questions / Caveats

- **`"gz"` artifact**: the final NAM chunk contained literal `gz` (non-hex) in its value
  string at the gzip footer boundary — treat as the app writing the tail raw rather than
  hex, or a capture artifact; a correct re-implementation should emit clean gzip + hex.
- **WAV sample-rate/format handling**: only 24-bit/48 kHz verified. Other WAV formats may
  need resampling/normalisation not yet characterised.
- **1 MiB NAM slot**: fixed size assumed from the observed padding; models larger than
  ~1 MiB would need confirmation.
- **Encryption**: firmware contains `serialize_encrypt`/`serialize_decrypt`, but the
  control/file-transfer path captured here is **plaintext**. Preset *backup* may use it.

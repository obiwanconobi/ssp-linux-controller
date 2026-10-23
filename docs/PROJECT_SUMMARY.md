# StompStation Pro Control — Project Summary

Last updated: 2026-10-23

Working directory: `/home/conner/Documents/Code/stompstation`

This document is a reference summary of the work done on the Linux client for
the **Sonulab StompStation PRO**. It covers the protocol implementation, the
GTK4 UI, testing/validation, the USB/kernel issue found on this PC, and
remaining work.

---

## 1. Goal

Build a usable Linux controller for the StompStation PRO based on the
reverse-engineered VoidX node protocol, replacing the earlier buggy,
CLI-only `stomp.py`.

Required functionality:

- connect over USB serial or network,
- list/change presets,
- show and toggle the blocks in the current signal chain,
- upload NAM models and IR WAV files,
- provide a basic graphical UI instead of a menu-driven CLI.

The UI was implemented with **GTK4 + PyGObject** because Tkinter's Tk library
is not installed in this environment and GTK4 is available.

---

## 2. Project files

| File | Purpose |
| --- | --- |
| `stomp.py` | Protocol client/library and entry point. Running it launches the modern UI. |
| `stomp_ui.py` | Modern GTK4/libadwaita UI (horizontal coloured signal chain). |
| `stomp_ui_legacy.py` | The earlier GTK4 UI, kept as a debugging/backup tool (`--legacy`). |
| `README.md` | User-facing install, run, and troubleshooting instructions. |
| `PROJECT_SUMMARY.md` | This document. |
| `tests/test_stomp.py` | Unit tests using an in-memory fake device. |
| `stompstation-pro-protocol.md` | Reverse-engineering notes for the VoidX node protocol. |
| `PROTOCOL.md` | Older USB-capture protocol notes. |
| `capture*.txt`, `logoutput*.txt`, `program_output.txt` | Original captures/logs. |
| `sniff.js` | Frida capture script used during reverse engineering. |
| `65 Champ 10 CLN.nam`, `TJ3 58BND310 P10R 57.wav` | Sample NAM/IR files used for testing. |

The old CLI menus were removed. `stomp.py` now contains the reusable protocol
core and starts `stomp_ui.py` when run directly.

---

## 3. Problems in the old `stomp.py`

The old implementation used one synchronous read per command and a shared
background poller. Key problems included:

- `read root`/`write` responses could be mismatched with late or interleaved
  frames.
- The poller could steal upload ACKs.
- Only values were cached; `browse root` metadata (`type`, `item_type`, `ref`,
  router structure) was discarded.
- Preset/block/list paths were hard-coded.
- Serial was the only transport.
- The code assumed specific paths such as `root\presets`.
- Upload pacing and final-chunk handling were fragile.
- The CLI required manual input for every action.

The rewrite addresses these with framing-aware I/O, an in-memory node tree, and
background threads for all blocking work.

---

## 4. Transport and framing

Implemented in `stomp.py`:

- `Transport` interface.
- `SerialTransport` using pyserial (`/dev/ttyACM*`, etc.).
- `TCPTransport` using a plain socket.
- Standard-library mDNS discovery for `_http._tcp` devices.
- Commands are sent as `<command>\r\n\0`.
- Responses are accumulated until a NUL byte, with an idle-timeout fallback
  for firmware that does not NUL-terminate every reply.
- The read buffer persists between requests, so trailing list updates are not
  lost.
- A stream is serialized with an I/O lock; the poller and UI actions cannot
  interleave requests.
- `AuthenticationRequired` is raised if the device requests a secure token.
  The proprietary VoidX password hash is not implemented.

### mDNS discovery

- No extra dependency; uses a UDP multicast query and a small DNS parser.
- Handles PTR, SRV, TXT, A, and AAAA records.
- Requires the TXT `id` to contain `voidx` for a verified device.
- Prefers IPv4, falling back to the reply's source address if only an IPv6
  link-local address is available.
- The real pedal was discovered this way at `192.168.1.97:8080`.

---

## 5. Node-tree model

`Device` keeps a cache of `path -> node dict` populated from:

1. `browse root` at startup/refresh (full tree with metadata),
2. `read root` delta polls,
3. explicit `read <path>` requests when needed.

Everything is discovered from that tree where possible:

- **Preset node:** a `plist` named `preset` whose `ref` points to a list with
  `item_type` starting with `pst`.
- **Preset list:** the referenced `NodeList`; its `value` array contains patch
  names.
- **Router/chain:** nodes with `type == "router"`; prefers
  `root\app\router`, then a router under a container with a master/output item.
- **Blocks:** non-empty strings in the router value, excluding link markers
  such as `"s"`. Both router formats are supported:
  - the 2-D matrix from the new protocol notes,
  - the flat `["root\\app\\gate", "s", ...]` form seen in USB captures.
- **Block state:** `<blockPath>\on_off` value `"ON"`/`"OFF"`.
- **Master controls:** from the router parent's `master` or `output` child:
  - `<base>\vol`,
  - `<base>\tempo_bpm` (fallback `<base>\pst\tmp`).
  On the real firmware this is `root\app\output`.
- **Upload lists:** `root\nam_amp`, `root\nam_drive`, and `root\ir_list` when
  present.
- **Fallback:** if no router is exposed, a known default chain is used. If
  `browse root` is unsupported, known paths are read explicitly.

`Device.state()` returns a `DeviceState` snapshot with device name, firmware,
preset, blocks, volume, tempo, meters, and upload lists. It does no network I/O
and is safe for the UI to call periodically.

Polling:

- `read root` every 0.5 s while connected (live meters/status).
- `browse root` on connect and after patch changes/refresh. A successful browse
  is treated as authoritative, so missing paths are not probed with timeouts.
- **Network transport:** on TCP the device's `read root` only returns live
  meters/status, not static parameter changes, so the poller additionally does
  a `browse root` every ~2 s to pick up block/preset/parameter changes.
- Polling pauses during uploads via `Device.pause_polling()`.

---

## 6. Preset and block control

- Change preset:
  `write <presetPath>:{"value":"<name>"}`
- Save preset:
  `write <presetPath>:{"value":"<name>","save":"save"}`
- Enable/disable block:
  `write <blockPath>\on_off:{"value":"ON"|"OFF"}`

After a patch change the UI re-browses to refresh the chain, block states, and
lists. The UI also detects **externally-made changes** (preset changes and
signal-chain edits done on the device itself, another controller, or the
official app) by watching `read root` deltas:

- if the current preset name changes, the UI re-browses;
- if the chain/router value changes, the UI re-browses and rebuilds the block
  list;
- block on/off changes already update live without a full re-browse.

The "last seen" preset and chain are re-baselined immediately after each
refresh so the app does not mistake its own re-browse for a new external
change.

---

## 7. NAM and IR uploads

Uploads are **ACK-driven**: each `dwrite` chunk is sent, then the client waits
for the device's next-chunk ACK before sending the next chunk.

### NAM

- File must be ≤ 1 MiB.
- Zero-pad to exactly `1,048,576` bytes.
- gzip at level 6 (matches the official app's expected header).
- Chunk 0: 128-byte UTF-8 display name, NUL-padded.
- Data chunks: 1024 raw bytes, hex-encoded.
- Final chunk: hex tail + literal `"gz"` + NUL/`"00"` padding, making the
  final value string 2048 characters.
- Edge case: if the gzip tail is exactly 1024 bytes, the full chunk is sent
  normally and a marker-only final chunk is sent next.
- Slot name comes from `metadata.name`, otherwise the filename.
- Auto-detects amp vs drive from `metadata.gear_type` when the drive list
  exists; the UI also lets the user choose the target explicitly.

### IR

- Reads WAV with the standard `wave` module.
- Uses the first 2048 samples of the first channel.
- 24-bit sample conversion matches the official app:
  `sample = int24 / 2^23 * 0.3191413049364811`.
- Packs as little-endian float32 (`8192` bytes).
- Chunk 0: 128-byte name.
- Chunks 1–8: 1024 bytes each.
- No `"gz"` marker is used for IRs.

Upload progress is reported to the UI. The slot list is refreshed after upload.
The UI warns that some firmware rejects NAM uploads to empty slots and asks
before overwriting an occupied slot.

> NAM/IR uploads have been validated against an in-memory fake device and the
> UI integration. They have **not** been run against the real pedal yet, to
> avoid altering the user's model/IR slots.

---

## 8. UIs

### 8.1 Modern UI (`stomp_ui.py`)

GTK4 + libadwaita, forced dark theme, laid out like desktop amp/effect
modelling software:

- **Header bar** with patch navigation (previous / dropdown / next / reload /
  save) and connection status.
- **Top, full width** — the signal chain drawn as a **horizontal row of
  coloured block cards**. Each block gets a unique colour (known blocks have a
  fixed palette colour; unknown blocks get a hashed colour). Bypassed blocks
  are dimmed. Clicking a card selects it.
- **Below the chain** — three sections side by side:
  - left: a scrollable patch list (single-click to load),
  - middle: the **selected-block editor** (enable switch + editable
    parameters — floats as sliders, enums as dropdowns, numbers as spin
    buttons, text as entries, and drive/amp **model** + cabinet **IR** shown as
    dropdowns populated from `nam_drive` / `nam_amp` / `ir_list`, via
    `Device.get_block_parameters()`),
  - right: master volume/tempo and a notebook with file upload
    (target/slot/file/progress) and the activity log.
- **Bottom, right-aligned** — the device selector (USB serial / mDNS / manual
  TCP) and the connect/disconnect button.
- Same background-threading, external-change detection, and dirty-state
  behaviour as the legacy UI.

### 8.2 Legacy UI (`stomp_ui_legacy.py`)

The earlier GTK4 UI is preserved unchanged as a debugging/backup tool:

```bash
python3 stomp_ui_legacy.py
python3 stomp.py --legacy
```

Its application id was changed to `io.github.stompstation.control.legacy` so
both UIs can run at the same time.

### Shared behaviours

- Background threads for connect, refresh, block toggles, patch changes,
  volume/tempo writes, and uploads; GTK updates go through `GLib.idle_add`.
- External changes (preset/chain) made on the device are detected via polling
  and trigger an automatic re-browse, so the UI stays in sync.
- Selected-block parameters (floats, enums, model/IR choices, etc.) live-update
  from the device on each poll; controls the user is actively editing are left
  alone.
- Dirty-state tracking prevents polling from resetting a volume/tempo change
  before its debounced write completes.
- Errors and status are shown both in the status bar and activity log.

UI update cadence is 250 ms; the device poll cadence is 500 ms.

### Known harmless warning

GTK prints messages such as:

```
GtkGizmo ... (slider) reported min width -2
```

These come from the GTK theme/layout during startup and do not affect
operation.

---

## 9. Running

Install on Debian/Ubuntu:

```bash
sudo apt install python3-gi gir1.2-gtk-4.0 python3-serial
```

On Arch/CachyOS the equivalents are already available in this environment.
Network-only operation does not need pyserial, but the UI needs GTK4/PyGObject.

Run:

```bash
python3 stomp.py
```

Optional transport preselect:

```bash
python3 stomp.py --serial /dev/ttyACM0
python3 stomp.py /dev/ttyACM0          # legacy positional form
python3 stomp.py --tcp 192.168.1.97:8080
```

USB/kernel diagnosis:

```bash
python3 stomp.py --diagnose
```

Tests:

```bash
python3 -m unittest discover -s tests -v
```

---

## 10. Testing and validation performed

### Automated tests

`tests/test_stomp.py` contains **15 passing tests** covering:

- `path:json` parsing, including `dwrite` ACK prefixes and token lines.
- Router flattening for matrix and flat formats.
- Host/port parsing.
- Connect + full state discovery from a synthetic `browse root`.
- Preset/block save and toggle commands.
- Read-root-only/no-metadata fallback.
- Default-chain fallback.
- NAM gzip/padding/name/final-marker round trip.
- NAM full-tail marker-only chunk edge case.
- IR float conversion and 8192-byte payload.
- Short-WAV padding.
- DNS packet/name parsing.
- Sysfs StompStation USB detection.

Run result:

```
Ran 15 tests in 4.307s
OK
```

### UI smoke tests

- Connected the UI to a fake TCP device on `127.0.0.1:45678`.
- Connected the UI to a pseudo-terminal fake serial device.
- Verified patch selection changes state.
- Verified block toggle writes.
- Verified volume change/write and dirty-state behavior.
- Verified target switching and slot-list refresh.
- Verified a NAM upload through the UI thread path.
- Verified app shutdown after the `do_shutdown` fix.

### Real hardware validation

Against the real pedal over network at `192.168.1.97:8080`:

- mDNS discovery returned:
  - name `StompStation PRO`
  - MAC `88:A2:9E:9E:5D:7F`
  - port `8080`
- `browse root` loaded **603 nodes**.
- Firmware reported `2.2.6`.
- Current preset read successfully.
- Router/block list read successfully, including alternate blocks such as
  Chorus.
- Master volume read as `root\app\output\vol`.
- Tempo range read as 30–240 BPM.
- Writing the current volume value back succeeded (no net change).

No real-hardware NAM/IR upload has been performed.

---

## 11. USB issue on this PC

### Symptom

The UI/`stomp.py` showed no `/dev/ttyACM*` device, even though the pedal was
connected over USB.

### Diagnosis

`lsusb` showed:

```
1d6b:0104 Linux Foundation Multifunction Composite Gadget
  Manufacturer: SONULAB
  Product: StompStation PRO
  Serial: STOMPPRO-10000000be183ca1
```

USB tree:

```
1-4:1.0  Class=Communications (CDC ACM control)  Driver=[none]
1-4:1.1  Class=CDC Data                          Driver=[none]
1-4:1.2  Class=Audio                             Driver=snd-usb-audio
1-4:1.3  Class=Audio                             Driver=snd-usb-audio
1-4:1.4  Class=Audio                             Driver=snd-usb-audio
```

The pedal exposes a valid CDC-ACM interface, but no driver is bound, so Linux
does not create `/dev/ttyACM0`.

Kernel/module check:

- Running kernel: `7.3.0-4-cachyos`
- Available module trees:
  - `7.3.0-5-cachyos`
  - `6.18.55-2-cachyos-lts`
- `cdc_acm` exists in the `7.3.0-5` and LTS trees but **not** for the running
  `7.3.0-4` kernel.
- `/lib/modules/7.3.0-4-cachyos` does not exist.
- `CONFIG_USB_ACM=m` in the running kernel config, so a module is required.

This is consistent with a kernel package update while still running the old
kernel. It is a host/environment issue, not a client bug.

### Fix

Reboot into the installed matching kernel:

```bash
sudo reboot
```

Then verify:

```bash
uname -r
# expect: 7.3.0-5-cachyos

lsmod | grep cdc_acm
ls -l /dev/ttyACM*
python3 stomp.py --diagnose
```

If the module exists but is not loaded:

```bash
sudo modprobe cdc_acm
```

If `modprobe` says the module is missing, boot the CachyOS LTS kernel
(`6.18.55-2-cachyos-lts`) from the boot menu.

The user is already in the `uucp` group, which is the serial-device group on
Arch/CachyOS; Debian/Ubuntu typically use `dialout`.

**Resolution:** after rebooting into `7.3.0-5-cachyos`, `cdc_acm` loaded and
`/dev/ttyACM0` appeared. USB is now working.

### Diagnostic support added to the app

- `find_usb_stompstations()` scans `/sys/bus/usb/devices` even when no serial
  driver is bound.
- `usb_diagnostic_message()` explains missing module/mismatched-kernel cases.
- `python3 stomp.py --diagnose` prints the USB device, serial ports, and
  diagnosis without launching GTK.
- The UI logs the same diagnostic when refreshing serial ports.
- README troubleshooting was updated.

Current diagnostic output on this PC:

```
USB device: 1-4  1d6b:0104  StompStation PRO
  serial=STOMPPRO-10000000be183ca1  cdc_acm_bound=0
...
StompStation PRO is connected over USB, but no /dev/ttyACM device exists:
the running kernel (7.3.0-4-cachyos) has no module tree in /lib/modules;
you probably updated the kernel and have not rebooted...
```

---

## 12. Current status

| Area | Status |
| --- | --- |
| Network connection | Working against real pedal |
| USB connection | Working after reboot (`/dev/ttyACM0`, `cdc_acm` loaded) |
| Preset reading/changing | Implemented and tested |
| Block on/off | Implemented and tested |
| Block parameter editing | Implemented (floats/enums/numbers/text); smoke-tested |
| Volume/tempo | Implemented; volume write verified on hardware |
| NAM upload | Implemented and tested against fake device |
| IR upload | Implemented and tested against fake device |
| mDNS discovery | Working against real pedal |
| Modern UI | Implemented and smoke-tested (network + USB) |
| Legacy/debug UI | Preserved as `stomp_ui_legacy.py` (`--legacy`) |
| Password auth | Not implemented |
| Chain editing | Not exposed in UI (block on/off + params only) |
| Patch import/export | Not implemented |
| Automated tests | 16/16 passing |

---

## 13. Known limitations / future work

1. **USB verification after reboot** — confirm `cdc_acm` binds and
   `/dev/ttyACM0` appears; then test the UI over USB.
2. **Real NAM/IR uploads** — test uploads on the pedal with a harmless slot and
   confirm name/list updates and audio.
3. **Password/token authentication** — the proprietary `hashString` algorithm
   (with the `"voidxdevteam"` salt) is not recovered.
4. **Chain editing** — add/remove/reorder blocks by writing the router matrix.
   The protocol notes contain enough information, but the UI currently only
   toggles existing blocks.
5. **Patch list operations** — rename/move/delete/import/export bundles.
6. **Chunked list reads (`dread`)** — not needed for the current preset/NAM/IR
   lists because browse returns full values, but not implemented as a general
   file download.
7. **Alternate waveform formats** — IR conversion assumes PCM WAV; no
   resampling and only the first channel is used.
8. **GTK portability** — `Gtk.FileDialog` requires GTK 4.10+; a
   `Gtk.FileChooserNative` fallback could support older GTK4 versions.
9. **Harmless GTK slider warnings** — can be investigated/reduced in a future
   polish pass.

---

## 14. Quick reference

```bash
# Run UI
python3 stomp.py

# Network
python3 stomp.py --tcp 192.168.1.97:8080

# USB
python3 stomp.py --serial /dev/ttyACM0

# USB diagnosis
python3 stomp.py --diagnose

# Tests
python3 -m unittest discover -s tests -v
```

Key protocol operations:

```text
read root
browse root
write <path>:{"value":<value>}
write <presetPath>:{"value":"<name>"}
write <presetPath>:{"value":"<name>","save":"save"}
write <blockPath>\on_off:{"value":"ON"|"OFF"}
dwrite <listPath>:{"index":N,"chunk":M,"value":"<hex>"}
```

# Firmware 2.5.3 — verification and client changes

Checked on 2026-11-21 against the public 2.5.3 image and a live StompStation
PRO on the local network. The goal was to find protocol or metadata changes
that require updates to the Python GTK client and the Tauri/Rust client.

## Image identity

| Field | Value |
| --- | --- |
| File | `s_pro_2_5_3.upd` |
| SHA-256 | `42a4f5fa1793f36640dc284f8cfe4539416204b9c6331b7c85316643b3f57531` |
| Size | 5,981,560 bytes |
| Format | ELF 64-bit LSB PIE, ARM aarch64, dynamically linked |
| Reported version | `2.5.3` (`root\sys\_ver`) |
| Previous image | `s_pro_2_4_4.upd`, SHA-256 `6fbe7aee2658686057b6a0ab51165950ed5d9f7a534e165d24d68acb5c936fa9` |

The attached `.upd` is byte-identical to the official
`https://sonulab.com/wp-content/uploads/2026/11/s_pro_2_5_3.zip` download.

Vendor release notes for 2.5.3:

- Parametric NAM improved
- Needs VoidX-Control v4.4
- Bug fixes (USB and MIDI controls)

## Live device

The pedal was connected over Wi-Fi (`192.168.1.97:8080`, mDNS
`_http._tcp`/`id=voidx`). A read-only `browse root` returned:

| Field | 2.4.4 fixture | Live 2.5.3 |
| --- | --- | --- |
| Firmware | 2.4.4 | 2.5.3 |
| Browse size | 688 nodes | 694 nodes |
| Presets | 60 slots | 60 slots |
| Capture lists | NAM 60 / PNAM 10 / NAM drive 60 / PNAM drive 10 / IR 50 | same |
| Master | volume 87, tempo 80 | same |
| Global EQ | 4 bands, 0-based device indices | same |
| Current chain | per preset | 11 blocks, 14 router slots |

Node paths, node types, router shape, preset save ordering, and upload framing
are unchanged. The node count difference is the current preset's chain: the
2.5.3 preset uses `mod_pre` and omits `exp`/`comp`, while the 2.4.4 capture used
the opposite layout. Block add/remove still comes from the router, not a fixed
list.

## Firmware changes that matter to clients

### 1. PNAM switch parameters

2.5.3 adds display metadata and switch positions to parametric NAM models
(`ParametricSlimmableContainer`, improved `HyperWaveNet`, switch `index`,
`enum_names`, `options`, `index_sw`, and `linear_volume` extensions).

The only wire-visible part is a `pfloat` node whose `vtype` style is now a JSON
array instead of the word `continuous`:

```text
root\app\amp\p1
style: vdef:0.000000;visible:true;vmax:1.000000;vmin:0.000000;
       vname:Gain-Boost;vtype:["ON","OFF"];
value: 0.5
```

The active model in the live device is `[AMP] RVRA.KR7-Mar-CH3`, a
`ParametricSlimmableContainer` with a `switch` parameter named `Gain-Boost`.
Its source `.pnam` config uses `type: "switch"`, `enum_names: ["ON","OFF"]`,
and `index: 0`.

The value is still a normalized `pfloat`: the selected position is
`index / (count - 1)`, so `0.5` on a two-position switch is position 1
(`OFF`). 2.4.4 clients showed this as a 0–1 continuous slider and could write
arbitrary in-between values.

**Client change:** parse a `vtype` that starts with `[` as JSON, expose its
entries as discrete choices, and write `index / (count - 1)`. Keep treating a
scalar `vtype` such as `continuous` or `linear_volume` as a normal pfloat.

### 2. Parametric NAM model coverage

2.5.3 accepts `ParametricSlimmableContainer` and `ParametricOutputGain`
models, plus the new output-volume extension. Our upload path already treats
`.pnam` as opaque bytes and preflights by slot size, so no upload-code change
is required. The local library and model-name extraction also keep working.

### 3. USB gadget and reconnect fixes

The USB fix changes the gadget descriptor, not the node protocol:

- product string is now `StompStation` (2.4.4: `StompStation PRO`);
- serial number ends in `-ACM` (for example `STOMPPRO-…-ACM`);
- `bcdDevice` is `0x0104` (2.4.4: `0x0101`);
- the UAC2 function is named `StompStation Audio` (2.4.4: `StompPRO Audio`);
- 2.5.3 embeds a `u_serial` kernel module and the `dwc2_ep0_fix` /
  `dwc2_idle_irq_fix` workarounds instead of the old `SONULAB_ACM_IDLE_IRQ`
  workaround.

`root\sys\_name` is still `StompStation PRO`, so app-level names do not change.
Both clients discover USB by port name/VID:PID rather than the descriptor
product string, so auto-connect still works. The Python sysfs fallback already
matches `stompstation` and a `STOMPPRO` serial prefix, which covers both
firmware spellings.

### 4. Wi-Fi server and mDNS

The 2.5.3 Wi-Fi stack now uses a per-client session (`Wifi::acceptClients`,
`Wifi::publishMDNS`, Avahi D-Bus) instead of a single listen socket. Two
simultaneous TCP clients were tested:

- both received the full 693-line `browse root` response;
- both continued to receive `read root` deltas without one client starving the
  other.

mDNS TXT records are unchanged (`id=voidx`, `MAC=…`, `name=StompStation PRO`),
so existing discovery code needs no change. The “one client at a time”
limitation now only applies to older firmware and to USB serial.

### 5. MIDI

The MIDI fix is internal: no MIDI node names, options, or commands changed.
`root\settings\misc\midi_a`, `root\midi_tempo`, and the controller links keep
their 2.4.4 shape. No client-side MIDI change is required.

## Code changes made

### Python (`Legacy/stomp.py`, `Legacy/stomp_ui.py`)

- `Legacy/stomp.py` parses `vtype` JSON arrays into `options`, reports
  `vtype: "switch"`, and preserves the option labels.
- `Legacy/stomp_ui.py` already rendered any pfloat with options as a dropdown; it now
  rounds switch positions half-away-from-zero to match the firmware
  (`0.5` → second option, not the first).
- Tests added for two- and three-position switch metadata.

### Tauri / Rust

- `stomp-protocol` parses `vtype` arrays, emits `vtype: "switch"` plus
  `options`, and has a regression test.
- The React `Knob` renders a compact option button for pfloat switches instead
  of a continuous dial. The helper uses the same `round(value × (N−1))`
  mapping as the device.
- Unit tests cover two-position and multi-position mapping.
- Demo/version strings now show firmware 2.5.3 and 694 nodes.

## Validation

```bash
(cd Legacy && python3 -m unittest discover -s tests -v)  # 43 tests
cargo test --workspace                                   # 43 Rust tests
(cd apps/desktop/ui && pnpm test -- --run)               # 28 tests
(cd apps/desktop/ui && pnpm lint)
```

Live checks:

- `browse root` via the updated Python core reports `p1` as
  `switch ["ON","OFF"]`;
- the rebuilt Rust CLI `editor tcp:… root\app\amp` reports the same node with
  `vtype: "switch"` and `options: ["ON","OFF"]`;
- two concurrent TCP clients both browsed and polled successfully.

## Remaining notes

- Existing presets created on 2.4.4 may hold `0.5` for a two-position PNAM
  switch. With the 2.5.3 mapping that means position 1 (`OFF`). Re-select and
  save the intended switch state once after the update.
- The full 2.5.3 hardware snapshot was not committed because it contains the
  user's capture and preset names; the 2.4.4 fixture remains the regression
  baseline, with the new switch shape covered by synthetic tests.
- USB serial still accepts one client. Close the official app before opening
  the pedal from either client.

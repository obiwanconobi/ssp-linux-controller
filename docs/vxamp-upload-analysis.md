# VXAMP vs NAM vs WAV-IR Upload

Short analysis of how VoidX-Control uploads files to a device, focused on the
`vxamp` path and how it differs from `.nam` and `.wav` IR upload.

Based on static analysis of `VoidX-Control` 1.28.0 (Flutter/Dart 3.13.2,
decompiled with `dae`). No device was contacted.

---

## 1. Summary

- **`vxamp` is a device list type, not a file extension.** The app has no
  literal `.vxamp` string. It branches on the target list's
  `item_type == "vxamp"` (the IR/amp library).
- All three uploads end in the same transport: chunked
  `dwrite <listPath>:{"index":N,"chunk":M,"value":"<hex>"}` over the node
  protocol, where `<hex>` is the hex-encoded UTF-8 content string.
- **`.nam`**: file content is uploaded as raw text/JSON. No audio conversion.
- **`.wav` IR**: the app parses the WAV, zero-pads/resamples it to the expected
  rate (48 kHz in the upload path), converts each sample to float32, and emits
  8 hex characters per sample (`wavToString`). That hex string is the list item
  content.
- **`vxamp`**: the `vxamp` branch reads the file as raw content (optionally
  gzip-compressed) and uploads it as a single list element. It explicitly
  accepts `.nam` files too, and derives the file-picker format from the list
  type (`getPstFormat`, first 4 chars: `vxamp` -> `vxam`). It does not apply
  the WAV resample/float conversion unless the file is handled by the WAV path.
- A preset **bundle** (a ZIP container with `bdinfo.json`) is a separate path
  (`uploadBundleAtIdx`) and is not the same as `vxamp`.

---

## 2. Upload pipeline (shared)

`InspectListScreen` → `getFilesNameAndContent` → `uploadFilesUI` →
`uploadUI`/`uploadUIBundle` → `uploadAtIdx` / `uploadBundleAtIdx`.

Shared transport in `uploadAtIdx`:

1. Take the content string (name + content from `FilesMetadata`).
2. UTF-8 encode it.
3. Hex-encode each byte (`toRadixString(16).padLeft(2,"0")`).
4. Split into chunks of `node.chunk` bytes if set, otherwise **128 bytes**.
5. Send one `dwrite` per chunk:

   ```text
   dwrite <listPath>:{"index":N,"chunk":M,"value":"<hex>"}
   ```

6. Normal uploads use chunk indices `0..K-1`; the `chunk:-1` form is used by
   `dread`/delete, not by the normal upload loop.

So the device stores a **string** per list element, and `dread`/`dwrite`
transport that string as hex.

---

## 3. `.nam` upload

**Observed** in `getFilesNameAndContent`:

- Target list: `NodeList` with `item_type` `nam`.
- File handling: `.nam` files are read as raw text/JSON NAM data. The `.nam`
  literal appears in the upload code (and is explicitly accepted by the `vxamp`
  branch); a pure NAM-list picker filter was not fully recovered, but the
  payload is the raw `.nam` content.
- Content: uploaded as-is (text/JSON NAM data). No parsing, no resampling, no
  float conversion.
- The NAM text is UTF-8 encoded and hex-encoded by the shared upload transport.
- Optional gzip: the `getFilesNameAndContent` pipeline can gzip content before
  wrapping it in `FilesMetadata`; the target list's `gzip`/size fields decide
  whether the compressed form is used.

**Difference:** it is the simplest path — raw content, no audio processing.

---

## 4. `.wav` IR upload

**Observed** in `wavToString` (`system_utils.dart`) and the upload picker:

- Target list: `NodeList` with `item_type` starting `wav`.
- File picker: `.wav`.
- Transform:
  1. Validate the file ends with `.WAV`; reject non-WAV.
  2. Read the WAV (`Wav.readFile`), validate channels and sample rate.
  3. Zero-pad/resample to the expected rate (48 kHz default in the upload
     path; the file-picker path parses a target rate, defaulting to 48000).
  4. Convert each sample to a 32-bit float (`FromDouble.toFloat32Bytes`).
  5. Hex-encode each 4-byte sample as 8 hex characters (`toRadixString(16)`,
     zero-padded).
- Content: the resulting **hex string of float32 samples**.
- Upload: the shared `dwrite` transport UTF-8 encodes that hex string and
  hex-encodes it again for the wire (hex of the ASCII hex). The download path
  reverses this with `stringToWav` (8 hex chars -> 4 bytes -> float sample).
- The app also checks the converted content against the target list's
  `itemSize`/`size` fields; failure logs e.g.
  `getFilesNameAndContent: fileContent is greater than node.itemSize...`.

**Difference:** this is the only path that transforms the audio data.

---

## 5. `vxamp` upload

**Observed** in `getFilesNameAndContent` (the `vxamp` branch),
`uploadFilesUI`, and `system_utils.getPstFormat`.

- The target list is the `vxamp` (IR/amp) list. `vxamp` is the list
  `item_type`.
- The file picker format is not a fixed string:
  - For a `pst` list it uses `pst`.
  - For a `wav` list it uses `wav`.
  - For other lists it calls `getPstFormat(item_type)`, which returns the first
    four characters. For `vxamp` that is **`vxam`** (the app therefore treats
    the VXAMP file format as a 4-char `vxam`-style format; there is no literal
    `.vxamp` extension string in the binary).
- The `vxamp` branch explicitly checks whether the selected file ends with
  `.nam`:
  - `.nam` files are accepted through the same branch (name derived by removing
    `.nam`) and read as raw content.
  - Non-`.nam` files (the VXAMP file/other IR payload) are read as raw content.
- Content handling:
  - The app reads the file bytes and optionally gzip-compresses them
    (`ZLibEncoder`/`GZipCodec`) depending on the target list's gzip/size
    settings.
  - It does **not** call `wavToString` for this raw `vxamp` content path; the
    content is not resampled to float32 hex.
  - It creates `FilesMetadata(name, content, gzipFlag)` and hands it to the
    shared single-file upload (`uploadUI` → `uploadAtIdx`).
- Upload is the same chunked `dwrite` as NAM/WAV.
- Corroboration: the Tone3000 download path saves NAM as `.nam` and IR as
  `.wav`; `vxamp` is only used there as a list-type/selector check
  (`showT3KCondition`). This reinforces that `vxamp` is a library/list type,
  not a file extension.

**Difference from `.wav` IR:** no WAV parse/resample/float32 conversion; the
file content is treated as an opaque/raw payload (gzip optional).
**Difference from `.nam`:** the `vxamp` branch is a distinct target-list branch,
accepts both `.nam` and non-`.nam` files, and is associated with the VXAMP
list/format rather than the NAM list. There is no `.vxamp` file extension in
the app; `vxamp` is the list type, `vxam` is the derived format code.

---

## 6. Side-by-side

| Aspect | `.nam` | `.wav` IR | `vxamp` / VXAMP |
| --- | --- | --- | --- |
| Target list `item_type` | `nam` | starts with `wav` | `vxamp` |
| File handling | raw `.nam` text | WAV parser | format from `getPstFormat` (`vxam`); also accepts `.nam` |
| Input read | raw text/JSON (`nam` file) | WAV parser (`.wav`) | raw bytes |
| Audio conversion | none | resample/zero-pad 48 kHz, float32, 8 hex/sample | none |
| Optional gzip | yes (pipeline) | no (converted string) | yes (`ZLib`/`GZip` branch) |
| Content string | NAM text | hex of float32 samples | raw file content (possibly gzip) |
| Wire format | `dwrite` chunks | `dwrite` chunks | `dwrite` chunks |
| Chunk size | `node.chunk` or 128 bytes | same | same |
| Special behavior | `.nam` target | `.wav` target | also accepts `.nam` files; VXAMP branch |

---

## 7. Caveats / verification

1. **`.vxamp` vs `vxam`.** The binary contains `vxamp` only as a list type; the
   file format code is computed as `vxam` by `getPstFormat`. Confirm the actual
   file extension on disk/hardware.
2. **`vxamp` raw vs WAV conversion.** The `vxamp` branch reads raw/gzipped
   content; the `wav` branch converts with `wavToString`. If a `.wav` is dropped
   on a `vxamp` list, verify whether the app takes the WAV conversion path or
   the raw `vxamp` path.
3. **Gzip encoding.** `FilesMetadata` carries a gzip flag; confirm how the
   device expects the gzip payload inside the hex `dwrite` value (whether the
   stored string is gzip bytes or a hex/base64 representation).
4. **Bundle vs single file.** Preset bundles are ZIP containers with
   `bdinfo.json`, handled by `uploadBundleAtIdx` and requiring a `pst` target;
   they are not the `vxamp` single-file path.
5. **Exact `dwrite` completion** for uploads is the normal command ack; capture
   one upload against a device if you need the exact response.

---

## 8. Relevant decompiled symbols

| Area | Symbol / file |
| --- | --- |
| File parsing and picker | `lists_management.dart` — `getFilesNameAndContent` |
| Single-file upload | `lists_management.dart` — `uploadAtIdx` |
| Bundle upload | `lists_management.dart` — `uploadBundleAtIdx` (`ZipDecoder`, `bdinfo.json`) |
| Upload dispatch | `inspect_list_screen.dart` — `uploadFilesUI`, `uploadUI`, `uploadUIBundle` |
| WAV conversion | `system_utils.dart` — `wavToString`; `lists_management.dart` — `stringToWav` |
| VXAMP format code | `system_utils.dart` — `getPstFormat` |
| VXAMP/T3K classification | `t3k_api.dart` — `showT3KCondition` (`vxamp`, `nam`, `wav`) |

*End of document.*

---

## Implementation notes in StompStation

- Target list: `root\vxamp_list` (`item_type = vxamp`, 16 slots, 12288 B each on the audited unit).
- The Library exposes **Amps → VXAMP** next to NAM and Parametric NAM. Its picker defaults to `.vxamp`, and also accepts `.vxam`/`.nam` because the official app treats VXAMP as a raw-content branch.
- Uploads are raw file bytes, zero-padded to the target list slot size (12 KiB) and sent through the normal name/data `dwrite` chunks. No WAV conversion, gzip compression, or structural model validation is applied.
- The VXAMP block maps to its own `vxamp` family so the signal-chain heading and inspector badge read **VXAMP** rather than **Utility**; it is intentionally excluded from Amp room.
- VXAMP list rows support the normal download/rename/delete paths, and `root\app\vxamp\model` is included in preset dependency discovery.
- The VXAMP upload path has been tested working on hardware (2026-11-24). Keep using a scratch slot when retesting padding/format changes; gzip-compressed VXAMP lists remain unverified.


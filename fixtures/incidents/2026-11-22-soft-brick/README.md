# 2026-11-22 soft-brick — stub NAM fixture

> **DO NOT UPLOAD THIS FILE TO A STOMPSTATION.**
>
> This is the exact 177-byte source `.nam` that was uploaded immediately before
> the 2026-11-22 soft-brick. It is kept only for local investigation and
> regression comparison. The current validator rejects it.

## Provenance

| Field | Value |
| --- | --- |
| File | `soft-brick-stub-2026-11-22.nam` |
| Size | 177 bytes |
| SHA-256 | `f9fa79066c4d10d28fae408d8778e07e0f670d3c826502429436123ccb32d014` |
| Device | StompStation PRO, firmware 2.5.3 |
| Transport | TCP `192.168.1.97:8080` |
| Target | `root\nam_amp` (Amp NAM capture list) |
| Wire slot | `21` (0-based; UI slot 22) |
| Capture name | `StompStation Upload Test` |
| Result | 3 chunks, 1199-byte gzip payload, device ACKed completion |

The source file is byte-for-byte identical to the file used at upload time.

## Exact content

```json
{"version":"0.5.4","architecture":"WaveNet","config":{"layers":[]},"weights":[],"metadata":{"name":"StompStation Upload Test","gear_type":"amp","modeled_by":"StompStation QA"}}
```

## What was actually sent

The uploader did **not** send this JSON directly:

1. The 177 bytes were zero-padded to the 1 MiB NAM slot size.
2. The padded buffer was gzip-compressed to 1199 bytes.
3. It was sent as three `dwrite` chunks to `root\nam_amp` slot 21:
   - chunk 0: 128-byte padded name (`StompStation Upload Test`)
   - chunk 1: first 1024 gzip bytes
   - chunk 2: final 175 gzip bytes plus the 2048-character `gz` marker

See `upload-result.json` and `upload-progress.log` for the recorded results.
The exact gzip stream was not logged; it is reproducible from the upload code.

## Why it is dangerous

This is JSON-shaped and has a valid architecture/config, but it is a **stub**:
`weights` is empty and `config.layers` is empty. It is not a trained model.
The pedal’s loader is not expected to survive it. The device stayed in Update
Mode after this upload; a normal firmware reflash did not remove the capture
because firmware images do not erase user capture data.

The current preflight rejects empty-weight models with:

```text
NAM file has no weights; this looks like a stub, not a trained model
```

Covered by `crates/stomp-upload/src/lib.rs` tests, including the exact empty
`weights` shape.

## Investigation notes

- Do not place this file in a folder you point the app at and then upload.
- Compare it with a valid A1 file (flat numeric `weights`) or A2 file
  (`config.submodels[].model.weights`).
- The incident and recovery playbook are in
  [`../../../docs/DEVICE_SAFETY.md`](../../../docs/DEVICE_SAFETY.md).
- The official delete behavior is documented in
  [`../../../docs/voidx-delete-button-behavior.md`](../../../docs/voidx-delete-button-behavior.md).

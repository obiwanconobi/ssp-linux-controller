# StompStation PRO — Firmware Extraction and Custom Firmware

Status: feasibility notes, based on the existing reverse-engineering documents and
static inspection of the public 2.2.6 and 2.4.4 firmware images.

## Short answer

Yes. The StompStation PRO is unusually moddable for a guitar pedal because the
“firmware” is not a locked microcontroller image. It is a Linux userspace
application running on a Raspberry Pi, and the `.upd` update file is a plain
ARM64 ELF executable.

The main caveat is recovery: the same ELF appears to provide both the normal
application and the update/recovery mode. A custom image that does not preserve
or reimplement that logic can remove the software recovery path.

## Evidence

From the repository notes:

- `docs/PROTOCOL.md` states that the pedal is a Raspberry Pi running Linux and
  that the analyzed firmware `s_pro_2_2_6.upd` is an ARM64 Linux ELF.
- `docs/stompstation-pro-protocol.md` lists the system nodes
  `root\sys\_upd`, `root\sys\_ver`, and `root\sys\_id`.
- `docs/PROTOCOL.md` lists the `supd` and `upd` verbs seen in the firmware.

Static inspection of the public firmware downloads:

| Property | 2.2.6 | 2.4.4 |
| --- | --- | --- |
| File | `s_pro_2_2_6.upd` | `s_pro_2_4_4.upd` |
| Format | ELF 64-bit LSB PIE, ARM aarch64 | ELF 64-bit LSB PIE, ARM aarch64 |
| Linking | Dynamically linked, stripped | Dynamically linked, stripped |
| Interpreter | `/lib/ld-linux-aarch64.so.1` | `/lib/ld-linux-aarch64.so.1` |
| Size | ~5.3 MB | ~5.65 MB |
| Container / signature | None observed | None observed |

The executables contain NAM/DSP code, ALSA, LVGL UI code, and exported C++
symbols for classes such as `StompProUpdater`, `StompCoreUpdater`, and
`Update`. The device tree string `brcm,bcm2711` is present, consistent with a
Raspberry Pi 4 / CM4-class board.

## Observed update mechanism

In the 2.4.4 image, the update handler works as follows:

1. `supd <decimal byte size>` allocates a buffer for the incoming file.
2. `upd <hex>` chunks are decoded and appended to that buffer.
3. When the received byte count reaches the declared size, the handler:
   - removes the old `/home/app_run`,
   - creates `/home/app_run` with mode `wb`,
   - writes the complete buffer,
   - runs `chmod 0777 /home/app_run`,
   - executes `sudo reboot`.
4. On the next boot the new `/home/app_run` is the application.

No signature, checksum, or ELF-header validation was observed in that
device-side path in 2.4.4. The 2.2.6 image uses the same `supd`/`upd` and
`/home/app_run` strings, though its reboot behaviour may differ.

The update mode is entered by holding the **UPD** button while powering the
pedal on. It is the same simplified node-protocol connection used by the
official app during a firmware update.

## Can the firmware be extracted?

There are several possible meanings:

| Goal | Feasibility | Method |
| --- | --- | --- |
| Get the application image for your firmware version | Easy | Download the matching official `.upd` from Sonulab after reading `root\sys\_ver` |
| Read the application over the node protocol | Not supported as a general file read | `dread` is designed for list/file slots such as NAM, IR, and presets; `root\sys\_upd` may expose update-related data, but its semantics are undocumented |
| Dump the exact on-device binary/rootfs | Harder | Physical eMMC/SD access, UART, or Raspberry Pi USB boot; or a custom update-mode binary with root access |
| Dump presets, NAM models, IRs | Separate from firmware | Use the existing file/list protocol and back them up independently |

For normal reverse engineering, downloading the official image is equivalent to
extracting the installed application. The `.upd` is the executable itself, not
a container, so tools such as `file`, `readelf`, `nm -D`, Ghidra, and IDA can
open it directly.

### Advanced on-device extraction

Because the update-mode child process runs as root, it is technically possible
to upload a custom binary that:

- copies files from the rootfs to a network location,
- copies the parent process executable via `/proc/<pid>/exe` (the old firmware
  may still be mapped after `/home/app_run` is replaced),
- enables SSH or another debug service, or
- dumps storage devices directly.

This is speculative and not yet validated on hardware. It overwrites
`/home/app_run`, so the official image should be kept available for recovery.

## Loading custom changes

### Preferred approach: patch the official ELF

Binary-patching the original `.upd` is the safest route because it preserves
the existing update/recovery code. Examples of changes:

- UI strings and labels,
- default parameters or parameter limits,
- feature flags / bypassed checks,
- small code caves or hooks for added behaviour.

The ELF is PIE and stripped, but many C++ symbols are exported, which makes
static analysis easier than a typical stripped firmware.

### Alternative: build a custom application

A new aarch64 Linux application can be uploaded in the same way. To keep the
device recoverable, it should:

- implement the UPD-button check and the `supd`/`upd` update protocol, or
- launch/preserve the original updater, or
- provide another reliable way to restore the official image.

ABI compatibility matters: the device has its own glibc, ALSA, GLib, and other
libraries. Patching the original binary avoids most of that problem; a
from-scratch binary is safest when statically linked or built against matching
libraries.

### Upload procedure

1. Read `root\sys\_ver` and download the matching official `.upd`.
2. Power the pedal off, then on while holding **UPD**.
3. Connect over USB serial, TCP, or BLE.
4. Send the update using the same framing as the node protocol:

   ```text
   supd <size-in-bytes>\r\n\0
   upd <hex-chunk>\r\n\0
   upd <hex-chunk>\r\n\0
   ...
   ```

5. The device writes `/home/app_run` and reboots (2.4.4 behaviour).
6. Confirm the new image boots and that Update Mode can still be entered.

## Critical recovery caveat

The evidence suggests the same ELF is used for both normal operation and
update/recovery:

- At boot it checks the UPD button via `gpioget 0 40`.
- If the button is not pressed, it launches `/home/app_run` as a child and
  keeps a parent process in update mode.
- If the button is pressed, it stays in update mode and accepts `supd`/`upd`.

Consequences:

- A custom image that does not implement this logic may have no software
  recovery path.
- The updater removes `/home/app_run` before writing the new file. A failed or
  truncated write can leave no bootable application.
- If a write fails, do not power-cycle immediately; retry while the parent
  updater process is still alive.
- Keep physical recovery available (SD/eMMC image, UART, or USB boot) before
  experimenting.

## Other limitations

- The `.upd` contains the Pi application, not the kernel, bootloader, rootfs,
  presets, NAM models, or IR files.
- `StompCoreUpdater` suggests a secondary core/MCU may have separate firmware.
  The main NAM/DSP processing appears to be in the Pi ELF, but do not assume the
  same update file covers every chip.
- Future firmware versions may add signature or integrity verification.
- Modifying firmware may void warranty and can make the pedal unbootable.
- Do not redistribute vendor firmware images.

## Suggested first experiment

1. Record `root\sys\_ver` and download the matching official `.upd`.
2. Reflash the byte-identical official image once to verify the update procedure
   and the UPD-button recovery path.
3. Make a copy and patch a harmless string, such as the version string.
4. Flash the patched image and confirm:
   - it boots,
   - the changed string is visible,
   - holding UPD still enters Update Mode,
   - the official image can be flashed back.
5. Only then make functional changes, preserving the `Update`/`ComInterface`
   code.
6. Test custom binaries under QEMU or on a spare Raspberry Pi before flashing
   the pedal.

## Possible tooling

A future addition to `stomp.py` could provide:

```text
python3 stomp.py --flash path/to/firmware.upd
```

with:

- `supd`/`upd` framing,
- size validation,
- chunk pacing and retries,
- a dry-run mode,
- explicit warnings before overwriting `/home/app_run`.

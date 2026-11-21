# Linux packaging notes

These files are intentionally checked in before the Phase 4 packaging pass so
the device-access contract is reviewable.

## udev rule

Install [`70-stompstation.rules`](70-stompstation.rules) to:

```text
/etc/udev/rules.d/70-stompstation.rules
```

Then reload:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```

The rule matches `SONULAB` / `StompStation PRO` as well as the shared
`1d6b:0104` gadget IDs, and grants `uaccess` to the active seat user. Verify:

```bash
ls -l /dev/ttyACM*
# crw-rw----+ 1 root plugdev … /dev/ttyACM0
```

If the node does not exist, see the USB diagnostics text in the app
(Settings → Diagnostics): the `cdc_acm` module may be missing for the running
kernel, or the kernel may have been updated without a reboot.

## Desktop entry

[`stompstation.desktop`](stompstation.desktop) is the reference launcher. The
Tauri bundler will own the installed copy; this file documents the expected
identity, categories, and `StartupWMClass`.

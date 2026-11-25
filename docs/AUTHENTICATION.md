# Device authentication — findings and implementation plan

Status: **device-free implementation complete; hardware auth validation passed;
remaining hardware edge cases listed below.**
Date: 2026-11-25.
Firmware: 2.5.3. Transports used for validation: Wi-Fi TCP and USB CDC-ACM.
A password was set on the test pedal for this pass. The password value is
intentionally **not** recorded in this repository.

## Implementation status (device-free)

The auth stack is implemented and tested against the simulator and scripted
transports:

- `stomp-protocol::auth`: firmware-compatible hash, authenticated command
  framing, KAT tests.
- `frame.rs`: lowercase `y`/`n` token parsing, nonce/status helpers.
- `stomp-device`: challenge detection, nonce tracking, password validation,
  protected `write`/`dwrite`/`dread` paths, one retry on `n`, clear auth
  errors.
- `stomp-sim`: `--password` mode with rotating nonces; reads stay open,
  write/transfer commands are gated.
- `stomp-cli`: `--password` flag; logs go to stderr so JSON output stays clean.
- Tauri actor/UI: password prompt, unlock action, keyring save/forget, lock
  state on the connection, reconnect with the in-memory password.
- OS keyring integration on desktop (service `StompStation`, account = device
  address); mobile builds fall back to a prompt. If the keyring is unavailable,
  the app continues in read-only mode and asks for the password. The ignored
  `credentials::tests::keyring_round_trip` test passed locally on Linux Secret
  Service.
- Snapshot/connection data carries `auth.required` and `auth.authenticated` so
  the UI stays in sync after polls and reconnects.
- Regression tests: `cargo test --workspace`, `cargo clippy`, `scripts/smoke.sh`,
  `scripts/auth-smoke.sh`, 99 UI tests, startup/UI/a11y/visual smoke.

## Hardware validation — 2026-11-25

A known test password was enabled on the pedal for this pass. The password
value is intentionally not recorded here. It was still enabled at the end of
this validation pass; whether to clear it is a separate user decision.

Passed on firmware 2.5.3 over Wi-Fi TCP and USB CDC-ACM:

- Raw read returns `token … n` while still returning data.
- Correct password gives `token … y`; wrong password gives `n`.
- Snapshot auth state reports `required: true, authenticated: true/false`
  correctly.
- Unauthenticated write and upload are rejected; state is unchanged.
- Authenticated drive toggle and restore.
- Authenticated preset import of `Blank Bass.zip` to UI slot 16 (wire 15):
  dependencies were compared/reused, and the preset payload read back
  byte-identical.
- Authenticated NAM upload to UI slot 34 (wire 33), delete, and re-upload;
  downloaded payload byte-identical to the source.
- Authenticated rename of `Silvertone 1483 D 1 3` (UI slot 31, wire 30),
  payload unchanged, name restored; authenticated delete left the slot empty;
  the capture was restored from backup and read back byte-identical.
- Authenticated `dread` download.
- Authenticated write over USB as well as Wi-Fi.
- Two concurrent authenticated TCP clients both connected and read
  successfully.
- Tauri actor: password connect, authenticated snapshot/write, explicit-password
  reconnect, and keyring auto-load reconnect.
- User-confirmed additional authenticated passes: preset save, chain
  move/link, EQ, and tuner.
- Duplicate-name upload quirk found: firmware ACKs every chunk but silently
  leaves the slot empty when another capture already uses that display name.
  The upload path now reads the list back and returns `UploadRejected` instead
  of reporting a phantom success. Regression test added.

Still pending on hardware: upload cancel/overwrite paths, packaged
AppImage/Android keyring behavior, non-ASCII passwords, password change/clear,
and factory-default auto-login.

## Why writes time out today

A `token …` line is not a write acknowledgement. It is the pedal’s
password/challenge line. When `root\sys\pwd` is non-empty, firmware 2.5.3:

- prefixes every response with `token <nonce> y` or `token <nonce> n`;
- accepts unauthenticated `read`/`browse`;
- rejects `write`, `dwrite`, `dread`, `dmove`, and `dswap` unless the request
  carries a valid `token <hash>` prefix.

The client currently ignores the rejection because
`crates/stomp-protocol/src/frame.rs` only treats uppercase `Y` as “secure”,
while the firmware sends lowercase `y`/`n`. A write then waits for the path
echo until `DEFAULT_TIMEOUT` (3 s) and reports “the device did not answer in
time.” Reads still work because the firmware deliberately leaves them open.

## Live read-only validation

A raw TCP session was used. Only `read root\sys\_name` / `read root\sys\_ver`
were sent. No `write`, `dwrite`, or other mutating command was issued.

Observed exchange for an unauthenticated read:

```text
> read root\sys\_name\r\n\0
< token <nonce> n\r\nroot\sys\_name:{"value":"StompStation PRO"}\0
```

The same read with a valid password hash:

```text
> token <H(password + nonce)>\r\nread root\sys\_name\r\n\0
< token <nonce> y\r\nroot\sys\_name:{"value":"StompStation PRO"}\0
```

Wrong password produced `n`; a lowercase form of the correct hash also produced
`n` (hash comparison is case-sensitive). The device reports firmware `2.5.3`.

Two concurrent TCP sessions observed the same nonce at the same time. Treat the
nonce as **device-global**, not per-client.

The same pair of reads was repeated over USB CDC-ACM (`/dev/ttyACM0`): the
unauthenticated read returned `n` plus the device name, and the authenticated
read returned `y`. This confirms the auth layer is transport-independent.

No writes were attempted, so the write-side gate itself is confirmed by firmware
analysis and by the reported issue, not by this pass.

## Protocol reference

Protected request:

```text
token <16 uppercase hex hash>\r\n<verb> <path>[:<json>]\r\n\0
```

Hash:

```text
hash = H(password + nonce)
```

Response prefix:

```text
token <16 uppercase hex nonce> y
token <16 uppercase hex nonce> n
```

Rules:

- `y` = the token was accepted; `n` = missing/invalid.
- A `n` response still includes the current nonce, so a retry can use it.
- `read` and `browse` do not require a token; their data is returned with
  either status.
- `write`, `dwrite`, `dread`, `dmove`, and `dswap` require a valid token.
  On `n`, the command was not executed.
- Send **one command per request**. Do not batch multiple writes behind one
  token prefix.
- Always update the stored nonce from every response, including `read root`
  polling. Do not assume a stale nonce will still work.
- If a protected request returns `n`, retry **once** using the nonce from that
  `n` response. If it returns `n` again, report an authentication error; do
  not loop.

### Nonce lifecycle (observed)

The nonce rotates lazily, at most about once per second when requests are
processed:

- Rapid requests within the same ~1 s window see the same nonce.
- The first request after that window is validated against the old nonce and
  then receives a fresh one.
- A successful request may return the same nonce or a new one; always take the
  value from the response.
- Two clients share the nonce, so one client can rotate it between another
  client’s read and write. The `n` + retry rule handles this.

## Hash function

`Security::generateHash` in 2.5.3 is a custom 8-byte-state hash. The tables and
algorithm are identical in 2.2.6.

Input:

```text
input || "voidxdevteam"    (12-byte ASCII salt)
```

Initial state:

```text
4E 02 4C 4D 7B 7C 03 13
```

8-byte permutations:

```text
rKeys1 = 01 05 06 03 02 00 07 04
rKeys2 = 05 00 06 04 02 03 01 07
```

Two **256-byte** S-boxes (`keys1`, `keys2`). The old reverse-engineering notes
described a 64-entry table; that is wrong.

Reference pseudocode (verified against the firmware loop for 305 random strings):

```python
def H(s: bytes) -> str:
    data = s + b"voidxdevteam"
    st = [0x4E, 0x02, 0x4C, 0x4D, 0x7B, 0x7C, 0x03, 0x13]

    for i, c in enumerate(data):
        j = i & 7
        a = RK1[j]
        b = RK2[i & 6]
        e = RK2[j]
        f = RK1[5 & i]

        h = (st[j] + KEYS1[st[a]] + i + c) & 0xFF
        st[j] = h
        h = (h + KEYS2[(st[e] + i) & 0xFF]) & 0xFF
        st[j] = h
        h = (h + KEYS1[st[b]]) & 0xFF
        st[j] = h
        h = (h + KEYS2[st[f]]) & 0xFF
        st[j] = h

        x = (KEYS1[st[i & 2]] + st[e]) & 0xFF
        st[e] = x
        x = (x + KEYS2[st[i & 3]]) & 0xFF
        st[e] = x
        x = (KEYS1[st[5 & i]] + st[a]) & 0xFF
        st[a] = x
        x = (x + KEYS2[st[j]] + (0x20 - i)) & 0xFF
        st[a] = x

    return "".join(f"{b:02X}" for b in st)
```

`KEYS1`:

```text
3f6685dd0060106ef59294d4c21328483a4990bc8a5fb0df7616bb8439e1e4f1
502c2b99bde7231c9802aebe9f1747af3c420bd1cd302a141b454146defe2e01
1ac604ac745c61d9a311e0536ab169379371364f344ee954fa5db97896893ddc
eecfc48733fb7c822fd37e8827e63e35b6ccfcc121b7f67aade50363654b68eb
1ec0771295d2f9d58359db329a8c1829526bc80a2d0e055873f28da17ba9a56f
3831c5cba84dd6b2151970d01dc3755b0c44b5a7e36d5aeac9678ba45e43ceb8
9164f4d808a6edec1f97bfba510d9c079ba255e8f8b424f379abc7fde2f7819d
40d7da26564c720f09f0578f62863bef6c9e250680b320ca7d8e4a22ffa0aa7f
```

`KEYS2`:

```text
fc768ac603f086df968b9316e8d0c56aca17aa6dbde2b3fd3cd65b384c5fc2a5
8e50ff66c0dca604b4805d4bbadde69a055240a36c75f659235e1363b2994248
240cb52fd17a9c9144094fec025828d9602522d4d2b91c8f7babbe4570899ee5
a13df1ee9f10d8e43400a0c37c07277815f562dac8541856ce6e0e46399082ac
9464f7bf303a5aa8afe7de206f12d5b1ebf9e3377fb00db80aa4c19711c7793b
844735a9f3bcd7333fb674bbcc5cfe8dcb2a95e9731988ef4dad432b2c611ba7d
3c4db6983680836ea6567f49dcd1ecfa2018c4a511f26417d068514297efa3efb
5532e0ed1df2b74e49f8e192ae53c91a9b81770f212d0b987157722e6b3187
```

Known-answer vectors (with the salt appended internally):

```text
H("")                               = B005D790879EB63F
H("password")                       = 75FEFAE0FFD86717
H("0123456789ABCDEF")               = 0920A852DE3D7EAE
H("password0123456789ABCDEF")       = 5D56506E30C690B1
H("hunter2A1B2C3D4E5F60718")        = DFE4CAD42781C362
```

Factory default password: `H(H(MAC string))`. This is optional; a user-set
password still requires a prompt. Do not rely on the default until the MAC
string format used by `License::getMAC_str()` is confirmed against the official
app.

## Client design

### State

```rust
struct AuthState {
    password: Option<SecretString>,
    nonce: Option<String>,
    token_seen: bool,
}
```

`token_seen` means the device has a password set. It does **not** mean the
password is correct.

### Connect

1. Open the transport.
2. Read any initial frame and parse a token line if present.
3. Send an unauthenticated `read root\sys\_name`. A password-protected device
   returns `token <nonce> n` plus the name. Store the nonce.
4. If a token line was seen, mark auth as required.
5. If a remembered password is available, validate it with an authenticated
   read (e.g. `read root\sys\_ver`) and expect `y`; on `n`, prompt or report an
   error.
6. If no token line was ever seen, continue in unauthenticated mode.

Reads remain usable while waiting for the user to enter a password. A UI banner
such as “Device password required for changes” is better than blocking the
whole snapshot.

### Requests

- For protected commands, prefix:
  `token <H(password + nonce)>\r\n<command>\r\n\0`
- Update `nonce` from every response, including polls.
- On `n`:
  - update the nonce from the `n` response;
  - retry the same command once;
  - if it returns `n` again, return `AuthenticationRequired`.
- For reads, the token prefix is optional. Prefixing all commands is fine and
  keeps the state machine simple.
- Never send multiple writes in one authenticated buffer.
- For uploads, use the nonce from each `dwrite` ACK. A `n` on a chunk means the
  chunk was rejected; retry that chunk once with the new nonce. The ACK loop
  already provides the required serialization.

### Polling interaction

The actor polls `read root` every 500 ms. Every poll response contains a token
line. Save it; otherwise the next write may use a stale nonce. With multiple
clients, another client can rotate the shared nonce between the poll and the
write; the one-retry rule handles that.

## UI, CLI, and storage

Desktop:

- Password prompt on connection to a protected device, or on the first write
  rejection.
- “Remember password” via the OS keyring (libsecret/Keychain/Credential
  Manager). Never write the password to config, logs, or diagnostics.
- “Forget password” action.
- Errors: `password_required`, `invalid_password`, `token_rejected`. Do not
  surface a generic timeout.

Android:

- Same prompt; store the password with Keystore-backed storage, not plain
  preferences.

CLI:

- Add `--password` or an interactive prompt. Do not put the password in shell
  history by default.

Password change:

- Do **not** add a “change device password” action yet. Writing `root\sys\pwd`
  can lock the device out if anything is wrong. Add it later, with a backup and
  a hardware test.

## Simulator and tests

`crates/stomp-sim` needs a password mode:

- password configured;
- `token … n` on unauthenticated requests;
- accepting `H(password + current_nonce)`;
- rotating the nonce on the observed lazy interval;
- rejecting stale tokens with `n` and a fresh nonce;
- `read` still returning data on `n`;
- tests that write/dwrite are refused without a valid token.

Unit tests:

- hash known-answer vectors;
- token parser accepts `y` and `Y`, rejects a missing token;
- one-retry behavior;
- polling updates the nonce;
- wrong password produces a clear error, not a timeout;
- no-password devices behave exactly as today.

Hardware validation (after implementation, with permission):

1. Read-only snapshot and password-required detection.
2. Authenticated read -> `y`.
3. Wrong password -> `n`, clear error.
4. A reversible write (gate on/off) with read-back.
5. Preset save, chain edit, upload, and list delete in a scratch slot.
6. Reconnect and USB/Wi-Fi parity.
7. Two concurrent Wi-Fi clients rotating the shared nonce.
8. Ten-minute idle polling and reconnect.

## Work estimate

| Task | Estimate |
| --- | --- |
| Hash module + KATs | 0.5–1 day (core already recovered) |
| Auth state in `stomp-device` + framing | 1–2 days |
| Tauri/CLI/UI prompt and error handling | 2–3 days |
| Keyring desktop/Android | 1 day |
| Simulator and protocol tests | 1–2 days |
| Hardware validation | 1 day |
| Documentation and security review | 0.5 day |

Roughly **5–8 development days**, with hardware validation separate.

## Open questions

1. Exact nonce rotation condition. Observed as lazy ~1 s request-driven; the
   implementation should not depend on the exact interval.
2. Password encoding for non-ASCII characters. Validate against the official
   app if needed; ASCII is confirmed.
3. Keyring availability in the AppImage environment and on Android.
4. Factory-default MAC string format (`License::getMAC_str`), if auto-login
   with the factory password is desired.
5. Whether the token is intentionally device-global while the firmware also
   keeps per-client sessions. Observed same nonce across two TCP clients.
6. Safe password-change flow. Deferred.

## Security notes

- The protocol is plaintext. The token is a device-local gate, not transport
  security or a strong password hash.
- Do not log the password or the client hash.
- Do not add password-changing UI until the read/write path and recovery story
  are validated.
- The hash and tables above are extracted from the official 2.5.3 image; the
  2.2.6 tables are identical.

## References

Firmware 2.5.3 functions:

- `Security::generateHash` — `0x309f00`
- `Security::generateToken` — `0x30a830`
- `Security::checkToken` — `0x30a460`
- `Security::hasPassword` — `0x30ab00`
- `ComInterface::processRequest` — `0x2b88d0`
- `keys1` — `0x5c2040`, `keys2` — `0x5c1f40`
- `rKeys1` — `0x5c1f20`, `rKeys2` — `0x5c1f30`

Client code:

- Token parsing: `crates/stomp-protocol/src/frame.rs`
- Connect/write path: `crates/stomp-device/src/device.rs`
- Polling and write serialization: `apps/desktop/src-tauri/src/actor.rs`
- Simulator: `crates/stomp-sim/src/main.rs`

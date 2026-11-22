# VoidX-Control Delete Button Behavior

How the official **VoidX-Control** app removes list entries from a device
(presets, NAM models, IR/amp files, WAV assets, etc.).

This is a focused companion to `stompstation-pro-protocol.md` (see section
10.1 there). It is based on static analysis of the shipped app only; no device
was contacted and no commands were sent to hardware.

---

## 1. Analysis provenance

| Item | Value |
| --- | --- |
| Application | `VoidX-Control.app` |
| Version | `1.28.0` (build 35) |
| Platform | macOS, Flutter/Dart AOT |
| Dart | `3.13.2` |
| Analysis | Dart AOT snapshot parsed/decompiled with `dae` |
| Relevant files | `screens/inspect_list_screen.dart`, `system/lists_management.dart`, `components/single_parameter_drawer/node_par_list_drawer.dart`, `components/single_parameter_drawer/node_preset_drawer.dart` |

Relevant decompiled symbols:

- `InspectListScreen` — generic list inspector (multi-select, rename, move,
  download, upload, delete).
- `InspectListScreenState.deleteUI` — per-item delete worker.
- `InspectListScreenState_anon_closure_32` — shows the confirmation dialog.
- `InspectListScreenState_anon_closure_33` — confirms and loops selected items.
- `deleteAtIdx` — builds and sends the delete command.
- `NodeList` — all deletable lists (presets, NAM, IR, WAV).
- `NodeParList.ref` — for a preset list, points at the `pst` `NodeList`.

---

## 2. TL;DR

There is **one** delete implementation for every list. It sends one `dwrite`
per selected index:

```text
dwrite <listPath>:{"index":<index>,"chunk":-1,"value":"<128 zero bytes as hex>"}
```

The value is the string `"00"` repeated **128 times** (256 hex characters),
i.e. 128 zero bytes. `chunk:-1` is the terminal/delete marker.

- One command per index; no bulk delete command.
- The app sends them sequentially (awaits each).
- The list is not compacted by the app; it blanks its cached name at that
  index and refreshes.
- The same path is used for presets, NAM, IR/amp, WAV, and other `NodeList`s.

---

## 3. UI flow

**Observed** in `inspect_list_screen.dart`:

1. Open the list with the list inspector (`InspectListScreen`). Entry points
   include:
   - the preset drawer / parameter-list drawer ("Open list"),
   - the dynamic-chain block header for NAM/IR lists,
   - the device info module for file lists.
2. Select one or more rows. The screen supports multi-selection
   (`startMultiSelection`, `selectItem`, range selection).
3. Choose the delete action ("Delete selection" in the list menu, or the
   delete toolbar action).
4. The app shows a confirmation dialog:
   - Title: `Items deletion`
   - Message: `Are you sure you want to delete the selected items?`
   - Buttons: `Confirm` / `Back`
5. On `Confirm`, the app iterates the selected indices and calls
   `deleteAtIdx(listNode, index)` once per index, awaiting each call.
6. It clears the selection and refreshes the rows. If any delete failed, it
   shows the snackbar:

   ```text
   Failed to delete some of the items!
   ```

If the list node cannot be resolved, the app logs:

```text
InspectListScreen: _deleteUI error. Can't retrieve the node.
```

---

## 4. Exact wire command

**Observed** in `deleteAtIdx` in `lists_management.dart`.

The command is:

```text
dwrite <listPath>:{"index":<index>,"chunk":-1,"value":"<zeros>"}
```

Where:

- `<listPath>` is the full node path of the list, from `Node.getPath()`
  (for example `root\...\pst` for a preset list).
- `<index>` is the zero-based slot/row being deleted.
- `chunk` is `-1` (terminal/delete marker).
- `<zeros>` is 256 hex characters: the string `"00"` repeated 128 times,
  i.e. 128 zero bytes.

The JSON part therefore looks like:

```json
{"index":3,"chunk":-1,"value":"0000000000...0000000000"}
```

(256 `0` characters.)

### 4.1 Framing

The app's transport writes messages as text and appends a single `0x00`
terminator (and rejects payloads containing `0x00`). A Linux client should
send:

```text
dwrite <listPath>:{"index":N,"chunk":-1,"value":"<256 hex zeros>"}\r\n\0
```

Adding `\r\n` is recommended for consistency with the app's `write` builders
and its CRLF-based response parsing.

### 4.2 Concrete example

Deleting slot 3 from a preset list:

```text
dwrite root\...\pst:{"index":3,"chunk":-1,"value":"000000...000000"}
```

---

## 5. What happens locally (in the app)

**Observed**:

- The app does **not** remove/shift the element in its local list.
- After a successful delete it sets the cached name for that index to `""`
  (`state.listNames[index] = ""`) and triggers a delayed refresh
  (`estimatedItemNamesUpdated`).
- The device is expected to clear the element at that index (content and
  name). Empty slots may remain visible until a re-browse/refresh.
- Normal uploads use chunk indices `0..N-1`; the delete path is the only
  place the app sends `chunk:-1` in a `dwrite`.
- The delete completion is handled like other `dwrite` acknowledgements; the
  app treats a non-failure completion as success.

---

## 6. Applicability

The delete path is generic; only the list node path and the selected index
change.

| Item type | List node | Delete command |
| --- | --- | --- |
| Presets | `preset` `NodeParList`'s `ref`: a `NodeList` with `item_type` starting `pst` | Same `dwrite` zero-fill |
| NAM models | `NodeList` with `item_type` `nam` | Same `dwrite` zero-fill |
| IR / amp files | `NodeList` with `item_type` `vxamp` | Same `dwrite` zero-fill |
| WAV / other assets | `NodeList` with `item_type` starting `wav` | Same `dwrite` zero-fill |

For presets, the list is not the `preset` parameter node itself. The `preset`
`NodeParList` has a `ref` field pointing at the actual `pst` `NodeList`; the
delete targets that `NodeList` path and the preset's index.

---

## 7. What this is NOT

Do not confuse list deletion with these separate operations:

- **"Delete block"** in the dynamic-chain block header removes an effect block
  from the chain. It rewrites the `NodeRouter` matrix
  (`write <routerPath>:{"value":[...]}`), not a file/preset list entry.
- **`FileSystemEntity.delete`** in the app removes local files on the
  computer (for example temporary downloads). It does not touch the device.
- **Firmware/update zero padding** also uses `"00"` strings but is unrelated
  to list deletion.

---

## 8. Suggested Linux implementation

```text
delete_list_item(connection, list_node_path, index):
    zeros = "00" * 128                      # 128 zero bytes as hex
    cmd = 'dwrite ' + list_node_path +
          ':{"index":' + str(index) +
          ',"chunk":-1,"value":"' + zeros + '"}'
    send(cmd + "\r\n\0")
    wait_for_dwrite_completion()            # treat non-failure as success

delete_selected_items(connection, list_node_path, selected_indices):
    for index in sorted(selected_indices):  # or the app's selection order
        delete_list_item(connection, list_node_path, index)
    # refresh the list (re-browse or re-read the list node) to reflect
    # empty slots; the app does not shift indices locally
```

Notes:

- Send one command at a time; the app awaits each delete.
- Keep the slot indices stable; do not renumber after deleting.
- If you need to confirm success, capture the device's normal `dwrite`
  acknowledgement for the list path.
- Re-browse/re-read the list to update names after deleting; the app relies on
  a refresh for empty slots.

---

## 9. Unknowns / verification checklist

1. **Firmware semantics of the zero-filled final chunk.** The app calls this
   `deleteAtIdx` and the confirmation UI says "delete", but the exact firmware
   behavior (clear element vs. write 128 zero bytes) was not observed on
   hardware. Confirm that the slot becomes empty and indices do not shift.
2. **Exact acknowledge string** for `dwrite` on a delete. The app waits for the
   generic `dwrite` completion; a packet capture of the official app against a
   device would confirm the response.
3. **Preset deletion UI entry point.** The generic list inspector performs the
   delete; the preset drawer opens the related list. Confirm the exact menu
   path on your firmware if you need to mirror the UI.
4. **Dependency cleanup.** It is not statically clear whether the device also
   clears dependency/`used` references for a deleted preset. Re-browse after
   deleting to see whether the preset list or dependency lists changed.

---

## 10. Evidence summary

| Claim | Evidence |
| --- | --- |
| One generic list inspector for all lists | `InspectListScreen` is constructed with a list path from the preset drawer, par list drawer, block header, and device info module |
| Delete is multi-select + confirmation | `Items deletion` / `Are you sure you want to delete the selected items?`, `Confirm` / `Back`, `Failed to delete some of the items!` |
| One delete per selected index | `anon_closure_33` loops selected indices and calls `deleteUI(index)` |
| Delete resolves a `NodeList` | `deleteUI` checks class id `0x9ac` (`NodeList`) and logs `_deleteUI error. Can't retrieve the node.` |
| Wire command | `deleteAtIdx` builds `dwrite ` + `Node.getPath()` + `:{"index":` + index + `,"chunk":-1,"value":"` + 128×`"00"` + `"}` |
| No index shift locally | After success, `deleteUI` sets the cached name at the index to `""`; it does not remove/shift the list |
| Preset lists are covered | `isPresetListNode` / `isPresetNode` identify `pst` lists; the inspector handles them like other lists |

---

*End of document. No devices were modified during this analysis.*

#!/usr/bin/env python3
"""
stomp.py -- Core client for the Sonulab StompStation PRO.

This is a rewrite of the original CLI-oriented module using the protocol notes
in ``stompstation-pro-protocol.md`` and the real USB captures.

What it supports
----------------
* USB CDC-ACM serial (``/dev/ttyACM*``) and TCP (mDNS ``_http._tcp``).
* ``browse root`` node-tree snapshots with metadata, plus ``read root`` delta
  polling.
* Dynamic discovery of the current preset, the preset list, the signal-chain
  router, and the blocks in that router.  No hard-coded "12 blocks" list is
  required, although a fallback is kept for firmware that only answers
  ``read root``.
* Block enable/disable via ``<block>\\on_off``.
* Preset select/save.
* ACK-driven NAM, Parametric NAM (``.pnam``) and IR uploads (chunk 0 = name,
  data chunks, ``gz`` marker on the last model chunk).

Running this file directly launches the GTK4 UI in ``stomp_ui.py``::

    python3 stomp.py

The module itself has no GTK dependency and can be used as a library.
"""

from __future__ import annotations

import gzip
import json
import os
import re
import socket
import struct
import sys
import threading
import time
import wave
from contextlib import contextmanager
from dataclasses import dataclass, field
from glob import glob
from typing import Any, Callable, Iterable, Iterator, Sequence

try:  # pyserial is only needed for the USB transport.
    import serial
    import serial.tools.list_ports
except Exception:  # pragma: no cover - exercised on systems without pyserial
    serial = None


# ---------------------------------------------------------------------------
# Protocol / device constants
# ---------------------------------------------------------------------------

NAM_SLOT_SIZE = 1024 * 1024          # NAM payloads are zero-padded to 1 MiB
PNAM_SLOT_SIZE = 2 * 1024 * 1024     # Parametric NAM slots are 2 MiB
CHUNK_SIZE = 1024
NAME_SIZE = 128
MAX_PRESET_NAME_BYTES = 63
IR_LENGTH = 2048
IR_GAIN = 0.3191413049364811         # matches the official app (about -9.92 dB)

DEFAULT_BAUD = 115200
DEFAULT_POLL_INTERVAL = 0.5
DEFAULT_TIMEOUT = 3.0
BROWSE_TIMEOUT = 8.0
COMMAND_SUFFIX = b"\r\n\0"

# Known firmware paths, used only as hints/fallbacks.  The real paths are
# discovered from ``browse root`` whenever the device supports it.
PRESET_PATH = r"root\app\preset"
PRESET_LIST_PATH = r"root\presets"
ROUTER_PATH = r"root\app\router"
NAM_PATH = r"root\nam_amp"
NAM_DRIVE_PATH = r"root\nam_drive"
PNAM_PATH = r"root\pnam_list"
PNAM_DRIVE_PATH = r"root\pnam_drive"
IR_PATH = r"root\ir_list"
MASTER_PATH = r"root\app\output"
GLOBAL_EQ_PATH = r"root\app\output\global_eq"
SETTINGS_PATH = r"root\settings"
TUNER_PATH = SETTINGS_PATH + r"\tuner"
INPUT_PATH = SETTINGS_PATH + r"\input"
CTRL_PATH = SETTINGS_PATH + r"\ctrl"
MISC_PATH = SETTINGS_PATH + r"\misc"
USB_PATH = r"root\usb"
PRESET_EXTRAS_PATH = r"root\app\output\pst"

KNOWN_LISTS = (NAM_PATH, NAM_DRIVE_PATH, PNAM_PATH, PNAM_DRIVE_PATH, IR_PATH)
OPTIONAL_STATE_PATHS = (
    PRESET_PATH,
    PRESET_LIST_PATH,
    ROUTER_PATH,
    NAM_PATH,
    NAM_DRIVE_PATH,
    PNAM_PATH,
    PNAM_DRIVE_PATH,
    IR_PATH,
    MASTER_PATH,
    r"root\sys\_name",
    r"root\sys\_ver",
    r"root\sys\_id",
    r"root\usb\_status",
)

# Friendly names for the standard chain and alternate block types.
BLOCK_LABELS = {
    "gate": "Noise Gate",
    "pitch": "Pitch",
    "pitch_time": "Pitch (Time)",
    "exp": "Expression",
    "comp": "Compressor",
    "dyna_comp": "Compressor (Dyna)",
    "mod_pre": "Modulation (pre)",
    "drive": "Drive / Distortion",
    "amp": "Amp (NAM)",
    "ir": "IR / Cabinet",
    "eq": "EQ",
    "eq2": "EQ 2",
    "parametric_eq": "Parametric EQ",
    "crossover": "Crossover",
    "mod": "Modulation (post)",
    "chorus": "Chorus",
    "flanger": "Flanger",
    "rotary": "Rotary",
    "pickup": "Pickup",
    "dtchr": "Detuner",
    "pcm42": "PCM 42",
    "delay": "Delay",
    "delay2": "Delay 2",
    "reverb": "Reverb",
    "reverb2": "Reverb 2",
}

# Used when browse/read do not expose a router (older firmware).
DEFAULT_CHAIN = (
    "gate", "pitch", "exp", "comp", "mod_pre", "drive",
    "amp", "ir", "eq", "mod", "delay", "reverb",
)

# Signal-chain connectors seen in the captures ("s" = series link).
_ROUTER_IGNORED_CELLS = {"", "s", "S", "p", "P", "parallel", "series"}

# Container item types used by block editors.  ``vfolder_tc`` groups carry an
# ``on_off`` child (Modulation, Pitch, Dual Delay); plain ``vfolder`` groups
# (Tone and Character) do not.
_CONTROL_FOLDER_TYPES = {"vfolder", "vfolder_tc", "hfolder", "sfolder"}


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class StompError(Exception):
    """Base class for all controller errors."""


class StompTimeout(StompError):
    """The device did not answer in time."""


class ConnectionClosed(StompError):
    """The transport was closed by the peer."""


class ProtocolError(StompError):
    """The device sent something we could not understand."""


class UploadRejected(StompError):
    """The device rejected an upload chunk or slot."""


class AuthenticationRequired(StompError):
    """The device requires a password token."""


# ---------------------------------------------------------------------------
# Small data model
# ---------------------------------------------------------------------------

@dataclass
class ParsedLine:
    path: str
    obj: Any
    command: str | None = None
    raw: str = ""


@dataclass
class BlockState:
    path: str
    label: str
    on: bool | None
    on_path: str
    in_chain: bool = True


@dataclass
class ChainSlot:
    """One editable position in the router matrix.

    ``path`` is the block occupying the slot, or ``None`` for an empty slot.
    ``fixed`` cells are locked by the device (Amp/Delay/Reverb on current
    firmware) and cannot be moved or removed.  ``link`` is ``"series"`` or
    ``"parallel"`` for the link running into this slot from the previous slot,
    or ``None`` when the router has no link marker there.
    """

    row: int
    col: int
    path: str | None = None
    fixed: bool = False
    link: str | None = None

    @property
    def occupied(self) -> bool:
        return self.path is not None


@dataclass
class PresetState:
    path: str | None
    list_path: str | None
    current: str
    names: list[str] = field(default_factory=list)


@dataclass
class ControlState:
    path: str
    label: str
    value: float
    min: float
    max: float
    step: float = 1.0


@dataclass
class UploadTarget:
    path: str
    label: str
    kind: str          # "nam", "pnam" or "ir"


@dataclass
class DeviceState:
    connected: bool = False
    device_name: str = ""
    firmware: str = ""
    device_id: str = ""
    usb_status: str = ""
    preset: PresetState = field(default_factory=lambda: PresetState(None, None, "", []))
    blocks: list[BlockState] = field(default_factory=list)
    volume: ControlState | None = None
    tempo: ControlState | None = None
    meter_in: float | None = None
    meter_out: float | None = None
    meters: dict[str, float] = field(default_factory=dict)
    lists: dict[str, list[str]] = field(default_factory=dict)


@dataclass
class DiscoveredDevice:
    service: str
    name: str
    host: str
    port: int
    txt: dict[str, str]
    source: str = ""
    valid: bool = False

    @property
    def address(self) -> str:
        return "%s:%d" % (self.host, self.port)

    @property
    def description(self) -> str:
        mac = self.txt.get("mac", "")
        suffix = " [%s]" % mac if mac else ""
        verified = "" if self.valid else " (unverified)"
        return "%s%s%s  -  %s" % (self.name, verified, suffix, self.address)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def path_parent(path: str) -> str:
    return path.rsplit("\\", 1)[0] if "\\" in path else ""


def path_name(path: str) -> str:
    return path.rsplit("\\", 1)[-1]


def normalize_path(path: str) -> str:
    return path.replace("\\\\", "\\")


def json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _interesting_path(path: str) -> bool:
    return path == "root" or path.startswith("root\\")


def _direct_children(nodes: dict[str, dict[str, Any]],
                     path: str) -> list[tuple[str, dict[str, Any]]]:
    """Return direct children of ``path`` in browse-tree order."""
    prefix = path + "\\"
    result: list[tuple[str, dict[str, Any]]] = []
    for child_path, node in nodes.items():
        if not child_path.startswith(prefix):
            continue
        relative = child_path[len(prefix):]
        if not relative or "\\" in relative:
            continue
        result.append((child_path, node))
    return result


def preset_name_error(name: str) -> str | None:
    """Return why ``name`` cannot be used for a preset slot, if it cannot."""
    if not name:
        return "patch name cannot be empty"
    if any(character == "\0" or ord(character) < 32 for character in name):
        return "patch name cannot contain control characters"
    if len(name.encode("utf-8")) > MAX_PRESET_NAME_BYTES:
        return "patch name must be at most %d bytes" % MAX_PRESET_NAME_BYTES
    return None


def parse_message(text: str) -> list[ParsedLine]:
    """Parse a complete ``path:json`` response message.

    The device uses CRLF-separated lines.  A few commands (notably ``dwrite``)
    echo the command name before the path, so that is stripped and recorded in
    ``ParsedLine.command``.  ``token <nonce> Y/N`` lines are returned as a
    synthetic line with ``command == "token"``.
    """
    out: list[ParsedLine] = []
    text = text.replace("\x00", "")
    for raw_line in re.split(r"\r\n|\n|\r", text):
        raw = raw_line.strip()
        if not raw:
            continue

        fields = raw.split()
        if len(fields) == 3 and fields[0] == "token":
            out.append(ParsedLine(
                path="", obj={"nonce": fields[1], "secure": fields[2] == "Y"},
                command="token", raw=raw,
            ))
            continue

        command = None
        for prefix in ("dwrite", "dmove", "dread", "browse", "write", "read"):
            if raw.startswith(prefix + " "):
                command = prefix
                raw = raw[len(prefix) + 1:].strip()
                break

        path, sep, value_text = raw.partition(":")
        if not sep or not path:
            continue
        try:
            obj: Any = json.loads(value_text)
        except (ValueError, TypeError):
            obj = value_text

        out.append(ParsedLine(path=normalize_path(path), obj=obj,
                              command=command, raw=raw_line.strip()))
    return out


def flatten_router(value: Any) -> list[str]:
    """Return block paths from a router value.

    Supports both the 2-D matrix described in the new protocol notes and the
    flat ``["root\\app\\gate", "s", ...]`` form seen in the USB captures.
    """
    found: list[str] = []

    def walk(item: Any) -> None:
        if isinstance(item, str):
            text = normalize_path(item).strip()
            if text.lower() in _ROUTER_IGNORED_CELLS:
                return
            if text.startswith("root\\") or text == "root":
                if text not in found:
                    found.append(text)
        elif isinstance(item, (list, tuple)):
            for child in item:
                walk(child)

    walk(value)
    return found


def _router_rows(value: Any) -> list[list[Any]]:
    """Normalize a router value to a list of rows, preserving its shape."""
    if not isinstance(value, list) or not value:
        return []
    if all(isinstance(row, list) for row in value):
        return [list(row) for row in value]
    return [list(value)]


def _router_cell_is_link(cell: Any) -> bool:
    """True for connector markers such as ``"s"``; empty cells are slots."""
    return (isinstance(cell, str) and cell.strip() != "" and
            cell.strip().lower() in _ROUTER_IGNORED_CELLS)


def _router_link_type(cell: Any) -> str | None:
    """Return ``"series"``/``"parallel"`` for an inline router link cell."""
    if not isinstance(cell, str):
        return None
    text = cell.strip().lower()
    if text == "p" or text == "parallel":
        return "parallel"
    if text == "s" or text == "series":
        return "series"
    return None


def flatten_editor_parameters(node: dict[str, Any]) -> list[dict[str, Any]]:
    """Return every leaf parameter from a ``get_block_editor`` result."""
    result: list[dict[str, Any]] = []
    for item in node.get("items") or []:
        kind = item.get("kind")
        if kind == "time":
            for key in ("rawdata", "subdivision", "lock"):
                param = item.get(key)
                if param:
                    result.append(param)
            result.extend(flatten_editor_parameters(item))
        elif kind == "group":
            result.extend(flatten_editor_parameters(item))
        else:
            result.append(item)
    return result


def parse_style(style: Any) -> dict[str, str]:
    """Parse a firmware ``style`` string into a key/value mapping.

    Styles look like ``"vname:Drive;vmin:0.000000;visible:true;"``.  Values can
    themselves contain colons (for example ``color:#FF6600``), so only the
    first colon separates the key from its value.
    """
    fields: dict[str, str] = {}
    if not isinstance(style, str):
        return fields
    for part in style.split(";"):
        key, sep, value = part.partition(":")
        key = key.strip()
        if key and sep:
            fields[key] = value.strip()
    return fields


# Legacy tone/model controls used by ordinary NAM amp/drive blocks.  A
# Parametric NAM model replaces these with its own pfloat controls, while the
# output-level controls (``lvl``, pan) remain available.
_LEGACY_NAM_BLOCK_PARAMS = frozenset({"model", "gain", "low", "mid", "treble"})


def _block_model_type(path: str,
                      nodes: dict[str, dict[str, Any]]) -> str:
    """Return ``"nam"``/``"pnam"`` for the model block containing ``path``.

    Amp and Drive blocks expose a ``type`` enum with ``NAM``/``Parametric
    NAM`` options.  The nearest enclosing type node wins so a dual-amp
    ``nam2`` group is classified independently from the primary amp.
    """
    parent = path_parent(path)
    while parent and parent != "root":
        type_node = nodes.get(parent + r"\type")
        if type_node is not None and type_node.get("type") == "enum":
            options = [str(option).strip().casefold()
                       for option in type_node.get("options") or []]
            if "nam" in options and any("parametric" in option
                                        for option in options):
                value = str(type_node.get("value") or "").strip().casefold()
                if "parametric" in value:
                    return "pnam"
                if "nam" in value:
                    return "nam"
                return ""
        parent = path_parent(parent)
    return ""


def _type_aware_visibility(name: str, ntype: str, list_type: str,
                           visible: bool, model_type: str) -> bool:
    """Combine firmware visibility with the block's NAM/PNAM type.

    Firmware updates the ``visible`` style flag after a type change, but the
    update can arrive after the new type value (and can be missed by a stale
    browse snapshot).  Deriving the obvious type-specific rules here keeps the
    editor correct as soon as the Type dropdown changes.
    """
    if not model_type:
        return visible
    parametric = model_type == "pnam"

    if ntype == "pfloat":
        # Parametric model controls never belong to an ordinary NAM block.
        return visible and parametric

    if ntype == "plist":
        if list_type == "pnam":
            return parametric
        if list_type == "nam":
            return not parametric

    if name in _LEGACY_NAM_BLOCK_PARAMS:
        return not parametric

    return visible


def block_label(path: str, node: dict | None = None) -> str:
    name = path_name(path)
    if name in BLOCK_LABELS:
        return BLOCK_LABELS[name]
    desc = (node or {}).get("desc")
    if isinstance(desc, str) and desc.strip():
        return desc.strip()
    return name.replace("_", " ").strip().title() or path


def _as_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_host_port(text: str, default_port: int | None = None) -> tuple[str, int]:
    """Parse ``host:port`` (IPv6 literals may be bracketed)."""
    text = text.strip()
    if not text:
        raise ValueError("empty address")
    if text.startswith("["):
        end = text.find("]")
        if end < 0:
            raise ValueError("invalid IPv6 address")
        host = text[1:end]
        rest = text[end + 1:]
        if rest.startswith(":"):
            return host, int(rest[1:])
        if default_port is not None:
            return host, default_port
        raise ValueError("missing port")
    if text.count(":") == 1:
        host, port_text = text.rsplit(":", 1)
        if not host:
            raise ValueError("missing host")
        return host, int(port_text)
    if text.count(":") > 1:  # bare IPv6 literal
        if default_port is not None:
            return text, default_port
        raise ValueError("IPv6 addresses need a port: [addr]:port")
    if default_port is not None:
        return text, default_port
    raise ValueError("missing port (use host:port)")


def is_usb_serial_device(device: str) -> bool:
    d = device.lower()
    return ("ttyacm" in d or "ttyusb" in d or "usbmodem" in d or
            "cu.usb" in d or "tty.usb" in d)


def list_serial_ports() -> list[tuple[str, str]]:
    """Return ``(device, description)``, USB devices first."""
    if serial is None:
        return []
    try:
        ports = list(serial.tools.list_ports.comports())
    except Exception:
        return []
    result = [(p.device, p.description or "") for p in ports]
    result.sort(key=lambda item: (not is_usb_serial_device(item[0]), item[0]))
    return result


def find_usb_stompstations(sysfs_root: str = "/sys/bus/usb/devices") -> list[dict[str, str]]:
    """Find StompStation USB devices in sysfs, even without a serial driver.

    The pedal is a Linux USB gadget with VID:PID ``1d6b:0104``.  Firmware
    2.4.4 uses the product string ``StompStation PRO``; 2.5.3 uses
    ``StompStation`` and a ``STOMPPRO-…-ACM`` serial number.  Interface 0 is
    CDC-ACM; if the ``cdc_acm`` kernel module is missing or not bound, the
    device still appears here but there is no ``/dev/ttyACM*``.
    """
    found: list[dict[str, str]] = []
    try:
        entries = os.listdir(sysfs_root)
    except OSError:
        return found

    def read(base: str, name: str) -> str:
        try:
            with open(os.path.join(base, name), "r", encoding="utf-8",
                      errors="replace") as handle:
                return handle.read().strip()
        except OSError:
            return ""

    for entry in entries:
        base = os.path.join(sysfs_root, entry)
        if not os.path.isdir(base):
            continue
        product = read(base, "product")
        serial_number = read(base, "serial")
        if "stompstation" not in product.lower() and \
                not serial_number.upper().startswith("STOMPPRO"):
            continue
        vid = read(base, "idVendor")
        pid = read(base, "idProduct")
        # Is the CDC-ACM interface (class 02 / subclass 02) bound to a driver?
        acm_bound = False
        try:
            children = os.listdir(base)
        except OSError:
            children = []
        for child in children:
            if ":" not in child:
                continue
            iface = os.path.join(base, child)
            try:
                with open(os.path.join(iface, "bInterfaceClass"), "r") as handle:
                    if handle.read().strip().lower() != "02":
                        continue
            except OSError:
                continue
            if os.path.exists(os.path.join(iface, "driver")):
                acm_bound = True
        found.append({
            "sysfs": base,
            "device": entry,
            "vendor": vid,
            "product_id": pid,
            "product": product or "StompStation",
            "serial": serial_number,
            "acm_bound": "1" if acm_bound else "0",
        })
    return found


def usb_diagnostic_message() -> str | None:
    """Explain why a connected StompStation has no serial device."""
    devices = find_usb_stompstations()
    if not devices:
        return None

    acm_ports = [p for p, _desc in list_serial_ports()
                 if p.startswith("/dev/ttyACM") or p.startswith("/dev/ttyUSB")]
    if acm_ports:
        return ("StompStation USB serial device found: %s"
                % ", ".join(acm_ports))

    release = os.uname().release
    module_dir = "/lib/modules/%s" % release
    candidates = glob(os.path.join(
        module_dir, "kernel/drivers/usb/class/cdc-acm.ko*"))
    if not os.path.isdir(module_dir):
        detail = ("the running kernel (%s) has no module tree in /lib/modules; "
                  "you probably updated the kernel and have not rebooted"
                  % release)
    elif not candidates:
        detail = ("the cdc_acm module is not installed for the running kernel "
                  "(%s)" % release)
    else:
        detail = ("the cdc_acm module exists for %s but is not loaded or did "
                  "not bind to interface 0" % release)

    return (
        "StompStation PRO is connected over USB, but no /dev/ttyACM device "
        "exists: %s. Reboot into the installed matching kernel, then check "
        "with 'lsmod | grep cdc_acm' and 'ls /dev/ttyACM*'. On a normal "
        "kernel 'sudo modprobe cdc_acm' is enough; if it says the module is "
        "missing, reboot after the kernel update." % detail
    )


def nan_name_from_nam(nam_bytes: bytes) -> str | None:
    try:
        data = json.loads(nam_bytes.decode("utf-8"))
        name = data.get("metadata", {}).get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
    except Exception:
        pass
    return None


def nam_gear_type(nam_bytes: bytes) -> str:
    try:
        data = json.loads(nam_bytes.decode("utf-8"))
        gear = data.get("metadata", {}).get("gear_type", "")
        return gear.lower() if isinstance(gear, str) else ""
    except Exception:
        return ""


def wav_to_ir_samples(filepath: str) -> tuple[list[float], int, int]:
    """Read a WAV and return (2048 float samples, sample_rate, channels)."""
    with wave.open(filepath, "rb") as wf:
        width = wf.getsampwidth()
        channels = wf.getnchannels()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
        if wf.getcomptype() != "NONE":
            raise ValueError("compressed WAV files are not supported")

    if width not in (1, 2, 3, 4):
        raise ValueError("unsupported WAV sample width: %d bytes" % width)

    if width == 1:
        scale = IR_GAIN / 128.0
        def convert(raw: bytes) -> float:
            return (raw[0] - 128) * scale
    else:
        bits = width * 8
        scale = IR_GAIN / float(1 << (bits - 1))
        def convert(raw: bytes) -> float:
            return int.from_bytes(raw, "little", signed=True) * scale

    step = width * channels
    samples: list[float] = []
    for offset in range(0, len(frames) - step + 1, step):
        if len(samples) >= IR_LENGTH:
            break
        samples.append(convert(frames[offset:offset + width]))
    if len(samples) < IR_LENGTH:
        samples.extend([0.0] * (IR_LENGTH - len(samples)))
    return samples, rate, channels


def _encode_name_chunk(name: str) -> bytes:
    encoded = name.encode("utf-8")[:NAME_SIZE]
    return encoded.ljust(NAME_SIZE, b"\x00")


def _split_chunks(data: bytes) -> list[bytes]:
    return [data[i:i + CHUNK_SIZE] for i in range(0, len(data), CHUNK_SIZE)]


def _nam_final_value(tail: bytes) -> str:
    """Build the final NAM chunk value (hex + "gz" + null padding)."""
    # The observed value is exactly 2048 characters: 2*len(tail) hex chars,
    # the literal "gz" marker, then "00" pairs up to 2048 characters.
    pad_pairs = max(0, 1024 - len(tail) - 1)
    return tail.hex() + "gz" + ("00" * pad_pairs)


def _nam_marker_value() -> str:
    """Marker-only final chunk, used when the gzip tail is exactly 1024 bytes."""
    return "gz" + ("00" * 1023)


# ---------------------------------------------------------------------------
# Transports
# ---------------------------------------------------------------------------

class Transport:
    """Minimal byte transport interface."""

    description = "transport"

    def open(self) -> None:
        raise NotImplementedError

    def close(self) -> None:
        raise NotImplementedError

    def write(self, data: bytes) -> None:
        raise NotImplementedError

    def read(self, size: int, timeout: float) -> bytes:
        raise NotImplementedError


class SerialTransport(Transport):
    def __init__(self, port: str, baud: int = DEFAULT_BAUD):
        self.port = port
        self.baud = baud
        self._ser = None
        self.description = "USB serial %s" % port

    def open(self) -> None:
        if serial is None:
            raise StompError(
                "pyserial is not installed; install it with 'pip install pyserial'")
        try:
            self._ser = serial.Serial(self.port, self.baud, timeout=0.1,
                                      write_timeout=5.0)
        except Exception as exc:
            raise StompError("could not open %s: %s" % (self.port, exc)) from exc
        try:
            self._ser.reset_input_buffer()
        except Exception:
            pass

    def close(self) -> None:
        ser, self._ser = self._ser, None
        if ser is not None:
            try:
                ser.close()
            except Exception:
                pass

    def write(self, data: bytes) -> None:
        ser = self._ser
        if ser is None:
            raise ConnectionClosed("serial port is not open")
        try:
            ser.write(data)
            ser.flush()
        except Exception as exc:
            raise ConnectionClosed("serial write failed: %s" % exc) from exc

    def read(self, size: int, timeout: float) -> bytes:
        ser = self._ser
        if ser is None:
            raise ConnectionClosed("serial port is not open")
        try:
            ser.timeout = max(0.01, timeout)
            return ser.read(size)
        except Exception as exc:
            raise ConnectionClosed("serial read failed: %s" % exc) from exc


class TCPTransport(Transport):
    def __init__(self, host: str, port: int, connect_timeout: float = 5.0):
        self.host = host
        self.port = port
        self.connect_timeout = connect_timeout
        self._sock: socket.socket | None = None
        self.description = "network %s:%d" % (host, port)

    def open(self) -> None:
        try:
            sock = socket.create_connection((self.host, self.port),
                                            timeout=self.connect_timeout)
            sock.settimeout(0.1)
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
        except Exception as exc:
            raise StompError(
                "could not connect to %s:%d: %s" % (self.host, self.port, exc)
            ) from exc
        self._sock = sock

    def close(self) -> None:
        sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass

    def write(self, data: bytes) -> None:
        sock = self._sock
        if sock is None:
            raise ConnectionClosed("socket is not open")
        try:
            sock.sendall(data)
        except Exception as exc:
            raise ConnectionClosed("socket write failed: %s" % exc) from exc

    def read(self, size: int, timeout: float) -> bytes:
        sock = self._sock
        if sock is None:
            raise ConnectionClosed("socket is not open")
        try:
            sock.settimeout(max(0.01, timeout))
            data = sock.recv(size)
        except socket.timeout:
            return b""
        except Exception as exc:
            raise ConnectionClosed("socket read failed: %s" % exc) from exc
        if data == b"":
            raise ConnectionClosed("device closed the connection")
        return data


# ---------------------------------------------------------------------------
# mDNS discovery
# ---------------------------------------------------------------------------

def _dns_encode_name(name: str) -> bytes:
    out = bytearray()
    for label in name.rstrip(".").split("."):
        if not label:
            continue
        data = label.encode("utf-8")
        if len(data) > 63:
            raise ValueError("DNS label too long")
        out.append(len(data))
        out.extend(data)
    out.append(0)
    return bytes(out)


def _dns_read_name(data: bytes, offset: int, depth: int = 0) -> tuple[str, int]:
    if depth > 20:
        raise ValueError("DNS compression loop")
    labels: list[str] = []
    while True:
        if offset >= len(data):
            raise ValueError("truncated DNS name")
        length = data[offset]
        if length == 0:
            offset += 1
            break
        if length & 0xC0 == 0xC0:
            if offset + 1 >= len(data):
                raise ValueError("truncated DNS pointer")
            pointer = ((length & 0x3F) << 8) | data[offset + 1]
            suffix, _ = _dns_read_name(data, pointer, depth + 1)
            if suffix:
                labels.append(suffix)
            offset += 2
            break
        offset += 1
        if offset + length > len(data):
            raise ValueError("truncated DNS label")
        labels.append(data[offset:offset + length].decode("utf-8", "replace"))
        offset += length
    return ".".join(labels), offset


@dataclass
class _DnsRecord:
    name: str
    rtype: int
    rdata_offset: int
    rdata: bytes
    packet: bytes


def _parse_dns_packet(data: bytes) -> list[_DnsRecord]:
    if len(data) < 12:
        return []
    try:
        _tid, _flags, qdcount, ancount, nscount, arcount = struct.unpack(
            "!HHHHHH", data[:12])
    except struct.error:
        return []
    offset = 12
    try:
        for _ in range(qdcount):
            _name, offset = _dns_read_name(data, offset)
            offset += 4
            if offset > len(data):
                return []
        records: list[_DnsRecord] = []
        for _ in range(ancount + nscount + arcount):
            name, offset = _dns_read_name(data, offset)
            if offset + 10 > len(data):
                break
            rtype, _rclass, _ttl, rdlength = struct.unpack(
                "!HHIH", data[offset:offset + 10])
            offset += 10
            rdata_offset = offset
            if offset + rdlength > len(data):
                break
            records.append(_DnsRecord(name, rtype, rdata_offset,
                                      data[offset:offset + rdlength], data))
            offset += rdlength
        return records
    except (ValueError, struct.error):
        return []


def _build_mdns_query(service: str) -> bytes:
    header = struct.pack("!HHHHHH", 0, 0, 1, 0, 0, 0)
    # PTR / IN with the unicast-response bit set.  This makes discovery work
    # even when another mDNS daemon owns UDP 5353.
    question = _dns_encode_name(service) + struct.pack("!HH", 12, 0x8001)
    return header + question


def discover_mdns(timeout: float = 2.5,
                  service: str = "_http._tcp.local") -> list[DiscoveredDevice]:
    """Discover VoidX devices advertising ``_http._tcp`` via mDNS.

    This intentionally uses only the standard library.  It sends a PTR query
    and parses the PTR/SRV/TXT/A records in any replies.  Devices are returned
    sorted with VoidX-tagged services first.
    """
    query = _build_mdns_query(service)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        if hasattr(socket, "SO_REUSEPORT"):
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEPORT, 1)
            except OSError:
                pass
        try:
            sock.bind(("", 5353))
        except OSError:
            sock.bind(("", 0))
        try:
            membership = socket.inet_aton("224.0.0.251") + socket.inet_aton("0.0.0.0")
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, membership)
        except OSError:
            pass
        try:
            sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
        except OSError:
            pass
        sock.settimeout(0.2)

        ptrs: dict[str, str] = {}
        srv: dict[str, tuple[int, str]] = {}
        txts: dict[str, dict[str, str]] = {}
        addresses: dict[str, list[str]] = {}
        sources: dict[str, str] = {}

        deadline = time.monotonic() + max(0.5, timeout)
        next_send = 0.0
        while time.monotonic() < deadline:
            now = time.monotonic()
            if now >= next_send:
                try:
                    sock.sendto(query, ("224.0.0.251", 5353))
                except OSError:
                    pass
                next_send = now + 0.8
            try:
                packet, addr = sock.recvfrom(9000)
            except socket.timeout:
                continue
            except OSError:
                break

            for record in _parse_dns_packet(packet):
                name = record.name.rstrip(".").lower()
                try:
                    if record.rtype == 12:  # PTR
                        target, _ = _dns_read_name(record.packet, record.rdata_offset)
                        target = target.rstrip(".")
                        if name == service.rstrip(".").lower() and target:
                            ptrs[target.lower()] = target
                            sources.setdefault(target.lower(), addr[0])
                    elif record.rtype == 33:  # SRV
                        target, _ = _dns_read_name(
                            record.packet, record.rdata_offset + 6)
                        priority, weight, port = struct.unpack(
                            "!HHH", record.rdata[:6])
                        del priority, weight
                        srv[name] = (port, target.rstrip("."))
                        sources.setdefault(name, addr[0])
                    elif record.rtype == 16:  # TXT
                        values: dict[str, str] = {}
                        pos = 0
                        while pos < len(record.rdata):
                            length = record.rdata[pos]
                            pos += 1
                            chunk = record.rdata[pos:pos + length]
                            pos += length
                            text = chunk.decode("utf-8", "replace")
                            key, sep, value = text.partition("=")
                            values[key.strip().lower()] = value if sep else ""
                        txts[name] = values
                        sources.setdefault(name, addr[0])
                    elif record.rtype == 1:  # A
                        if len(record.rdata) == 4:
                            addresses.setdefault(name, []).append(
                                socket.inet_ntoa(record.rdata))
                    elif record.rtype == 28:  # AAAA
                        if len(record.rdata) == 16:
                            addresses.setdefault(name, []).append(
                                socket.inet_ntop(socket.AF_INET6, record.rdata))
                except (ValueError, struct.error, OSError):
                    continue
    finally:
        sock.close()

    result: list[DiscoveredDevice] = []
    seen: set[tuple[str, int]] = set()
    for key, instance in ptrs.items():
        if key not in srv:
            continue
        port, target = srv[key]
        txt = txts.get(key, {})
        candidates = addresses.get(target.rstrip(".").lower(), [])
        if not candidates:
            candidates = addresses.get(key, [])
        v4 = [address for address in candidates if ":" not in address]
        if v4:
            host = v4[0]
        elif candidates:
            host = candidates[0]
        else:
            host = sources.get(key, "")
        # A link-local IPv6 address needs a scope id; the reply's IPv4 source
        # address is much more useful for a TCP connection.
        if host.startswith("fe80:") and sources.get(key):
            host = sources[key]
        if not host:
            host = target or sources.get(key, "")
        if not host or not port:
            continue
        dedupe = (host, port)
        if dedupe in seen:
            continue
        seen.add(dedupe)

        device_id = txt.get("id", "")
        name = txt.get("name") or instance.split(".")[0]
        valid = "voidx" in device_id.lower()
        result.append(DiscoveredDevice(
            service=instance, name=name, host=host, port=port, txt=txt,
            source=sources.get(key, ""), valid=valid,
        ))
    result.sort(key=lambda d: (not d.valid, d.name.lower(), d.address))
    return result


# ---------------------------------------------------------------------------
# Device client
# ---------------------------------------------------------------------------

class Device:
    """Line/JSON node client for a StompStation PRO."""

    def __init__(self, transport: Transport,
                 log: Callable[[str], None] | None = None,
                 poll_interval: float = DEFAULT_POLL_INTERVAL,
                 full_refresh_interval: float = 2.0):
        self.transport = transport
        self.poll_interval = poll_interval
        self.full_refresh_interval = full_refresh_interval
        self._log_cb = log
        self._io_lock = threading.RLock()
        self._cache_lock = threading.RLock()
        self._rx = bytearray()

        self.nodes: dict[str, dict[str, Any]] = {}
        self._connected = False

        self._poll_thread: threading.Thread | None = None
        self._poll_stop = threading.Event()
        self._poll_pause = threading.Event()
        self._poll_errors = 0

        self.device_name = ""
        self.firmware = ""
        self.device_id = ""

    # ---- basic plumbing -------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._connected

    def _log(self, message: str) -> None:
        if self._log_cb:
            try:
                self._log_cb(message)
            except Exception:
                pass

    def _send(self, command: str) -> None:
        if "\x00" in command:
            raise ProtocolError("outgoing command contains a NUL byte")
        try:
            self.transport.write(command.encode("utf-8") + COMMAND_SUFFIX)
        except StompError:
            self._connected = False
            raise

    def _read_frame(self, timeout: float, idle: float = 0.25) -> bytes:
        """Read one NUL-terminated frame.

        A fallback idle timeout is used because some older firmware does not
        NUL-terminate every answer.  The persistent ``_rx`` buffer keeps bytes
        that arrive after the first NUL for the next request.
        """
        with self._io_lock:
            if b"\0" in self._rx:
                frame, _, rest = bytes(self._rx).partition(b"\0")
                self._rx = bytearray(rest)
                return frame

            deadline = time.monotonic() + max(0.05, timeout)
            last_data = time.monotonic()
            while True:
                now = time.monotonic()
                if now >= deadline:
                    break
                wait = min(0.1, max(0.01, deadline - now))
                chunk = self.transport.read(4096, wait)
                if chunk:
                    self._rx.extend(chunk)
                    last_data = now
                    if b"\0" in self._rx:
                        frame, _, rest = bytes(self._rx).partition(b"\0")
                        self._rx = bytearray(rest)
                        return frame
                elif self._rx and (time.monotonic() - last_data) >= idle:
                    frame = bytes(self._rx)
                    self._rx.clear()
                    return frame
            if self._rx:
                # Return what we have rather than losing a response from
                # firmware that omits the final NUL.  Callers parse the lines.
                frame = bytes(self._rx)
                self._rx.clear()
                return frame
            raise StompTimeout("timeout waiting for a response from the device")

    def _handle_lines(self, lines: Sequence[ParsedLine]) -> None:
        secure = False
        for line in lines:
            if line.command == "token":
                nonce = line.obj.get("nonce", "")
                secure = bool(line.obj.get("secure"))
                if secure:
                    self._log("device requested password authentication "
                              "(nonce %s); this client does not implement the "
                              "proprietary VoidX hash" % nonce)
                continue
            if not _interesting_path(line.path):
                continue
            if not isinstance(line.obj, dict):
                continue
            # dwrite ACKs are not node state.
            if line.command == "dwrite" and ("index" in line.obj or "chunk" in line.obj):
                continue
            with self._cache_lock:
                node = self.nodes.setdefault(line.path, {})
                node.update(line.obj)
            if line.path == r"root\sys\_name" and isinstance(line.obj.get("value"), str):
                self.device_name = line.obj["value"]
            elif line.path == r"root\sys\_ver" and isinstance(line.obj.get("value"), str):
                self.firmware = line.obj["value"]
            elif line.path == r"root\sys\_id" and isinstance(line.obj.get("value"), str):
                self.device_id = line.obj["value"]
        if secure:
            raise AuthenticationRequired(
                "this device requires a password; the VoidX token hash is not "
                "implemented. Disable the password or use the official app.")

    def _request(self, command: str,
                 match: Callable[[Sequence[ParsedLine]], bool] | None = None,
                 timeout: float = DEFAULT_TIMEOUT,
                 idle: float = 0.25,
                 accept_empty: bool = False) -> list[ParsedLine]:
        with self._io_lock:
            self._send(command)
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise StompTimeout("no matching response to %r" % command)
                frame = self._read_frame(remaining, idle)
                text = frame.decode("utf-8", "replace")
                lines = parse_message(text)
                self._handle_lines(lines)
                if match is None or match(lines) or (accept_empty and not lines):
                    return lines

    def _ingest_snapshot(self, lines: Sequence[ParsedLine]) -> int:
        snapshot: dict[str, dict[str, Any]] = {}
        for line in lines:
            if line.command is not None:
                continue
            if _interesting_path(line.path) and isinstance(line.obj, dict):
                snapshot[line.path] = dict(line.obj)
        if len(snapshot) < 10:
            return 0
        with self._cache_lock:
            self.nodes = snapshot
        return len(snapshot)

    def _ensure_paths(self, paths: Iterable[str], timeout: float = 0.8) -> None:
        for path in paths:
            with self._cache_lock:
                if path in self.nodes:
                    continue
            try:
                self.read_path(path, timeout=timeout)
            except StompError:
                pass

    # ---- connection -----------------------------------------------------

    def connect(self) -> None:
        self.transport.open()
        self._rx.clear()
        try:
            # Consume an optional immediate "token ..." announcement.  Do not
            # fail if the device says nothing until the first request.
            try:
                frame = self._read_frame(0.35, idle=0.15)
                if frame.strip():
                    lines = parse_message(frame.decode("utf-8", "replace"))
                    self._handle_lines(lines)
            except StompTimeout:
                pass

            try:
                self._request(r"read root\sys\_name", timeout=2.0)
            except StompError as exc:
                self._log("device identity read failed: %s" % exc)

            self.refresh_full_state()
            self._connected = True
            self._log("connected to %s" % self.transport.description)
        except Exception:
            self._connected = False
            try:
                self.transport.close()
            except Exception:
                pass
            raise

    def close(self) -> None:
        self.stop_polling()
        self._connected = False
        try:
            self.transport.close()
        except Exception:
            pass

    def refresh_full_state(self) -> None:
        """Load metadata/state, preferring ``browse root``.

        New firmware returns the full node tree (with ``type``/``item_type``/
        values) from ``browse root``.  Older firmware/captures only answer
        ``read root``; in that case we fall back to explicit reads of the known
        paths.
        """
        browsed = 0
        try:
            browsed = self.browse_root()
        except StompError as exc:
            self._log("browse root unavailable (%s); falling back to read root" % exc)

        try:
            self.read_root()
        except StompError as exc:
            if not browsed:
                raise
            self._log("read root failed after browse: %s" % exc)

        # Core nodes and lists.
        if browsed:
            # A successful browse root is an authoritative snapshot.  Do not
            # waste time probing paths the device already told us are absent;
            # only fetch nodes that were present but had no value field.
            with self._cache_lock:
                nodes = dict(self.nodes)
            missing_values = [path for path in OPTIONAL_STATE_PATHS
                              if path in nodes and "value" not in nodes[path]]
            self._ensure_paths(missing_values)
        else:
            self._ensure_paths(OPTIONAL_STATE_PATHS)

        preset = self.get_preset_state()
        if preset.list_path:
            self._ensure_paths([preset.list_path])

        # Block on/off states may not be present in every browse response.
        block_paths = [b.path for b in self.get_chain_blocks()]
        self._ensure_paths([p + r"\on_off" for p in block_paths])

        master_paths = self._find_master_paths()
        if master_paths:
            self._ensure_paths([
                master_paths["base"] + r"\vol",
                master_paths["base"] + r"\tempo_bpm",
                master_paths["base"] + r"\pst\tmp",
            ])

    # ---- commands -------------------------------------------------------

    def read_root(self, timeout: float = 2.0) -> list[ParsedLine]:
        return self._request("read root", timeout=timeout, idle=0.2,
                             accept_empty=True)

    def browse_root(self, timeout: float = BROWSE_TIMEOUT,
                    quiet: bool = False) -> int:
        def match(lines: Sequence[ParsedLine]) -> bool:
            if not lines:
                return False
            paths = {line.path for line in lines}
            if "root" in paths:
                root = next((line.obj for line in lines if line.path == "root"), None)
                if isinstance(root, dict) and "type" in root:
                    return True
            typed = sum(1 for line in lines
                        if isinstance(line.obj, dict) and "type" in line.obj)
            return typed >= 10 or len(paths) >= 40

        lines = self._request("browse root", match=match, timeout=timeout,
                              idle=0.5)
        count = self._ingest_snapshot(lines)
        if not count:
            # Values-only fallback: merge into the existing tree.
            self._handle_lines(lines)
            with self._cache_lock:
                count = len(self.nodes)
        if not quiet:
            self._log("browse root loaded %d nodes" % count)
        return count

    def read_path(self, path: str,
                  timeout: float = DEFAULT_TIMEOUT) -> list[ParsedLine]:
        return self._request("read %s" % path, match=lambda lines: any(
            line.path == path for line in lines), timeout=timeout)

    def write(self, path: str, value: Any,
              extra: dict[str, Any] | None = None) -> None:
        payload: dict[str, Any] = {"value": value}
        if extra:
            payload.update(extra)
        command = "write %s:%s" % (path, json_compact(payload))
        self._request(command, match=lambda lines: any(
            line.path == path for line in lines), timeout=DEFAULT_TIMEOUT)
        with self._cache_lock:
            self.nodes.setdefault(path, {})["value"] = value

    def set_block(self, block_path: str, on: bool) -> None:
        self.write(block_path + r"\on_off", "ON" if on else "OFF")

    def set_preset(self, name: str) -> None:
        preset = self.get_preset_state()
        self.write(preset.path or PRESET_PATH, name)

    def save_preset(self, name: str | None = None) -> None:
        preset = self.get_preset_state()
        target = preset.path or PRESET_PATH
        value = name if name is not None else preset.current
        if not value:
            raise StompError("there is no current preset to save")
        self.write(target, value, extra={"save": "save"})
        self._log("saved preset %r" % value)

    def rename_preset(self, old_name: str, new_name: str) -> None:
        """Rename a preset slot without rewriting its contents.

        The name table is committed with a single ``dwrite`` of a padded
        128-byte name at ``chunk:-1``.  Other slots' contents are untouched.
        """
        if not old_name:
            raise StompError("there is no preset selected to rename")
        problem = preset_name_error(new_name)
        if problem:
            raise StompError(problem)

        preset = self.get_preset_state()
        list_path = preset.list_path or PRESET_LIST_PATH
        names = self.get_list(list_path)
        if not names:
            raise StompError("the preset list is not available")
        try:
            index = names.index(old_name)
        except ValueError:
            raise StompError("preset %r is not in %s"
                             % (old_name, list_path)) from None
        if new_name == old_name:
            return
        # The pedal treats names case-insensitively and refuses duplicates.
        for other, existing in enumerate(names):
            if other != index and existing and \
                    existing.casefold() == new_name.casefold():
                raise StompError("a preset named %r already exists" % new_name)

        payload = _encode_name_chunk(new_name).hex()
        with self.pause_polling():
            idx, ack = self._ack_for_chunk(list_path, index, -1, payload,
                                           timeout=5.0)
        if idx not in (-1, index):
            raise UploadRejected(
                "device acknowledged the wrong slot for rename "
                "(wanted %d, got %d)" % (index, idx))
        if ack != -1:
            raise ProtocolError(
                "rename did not finish (device asked for chunk %d)" % ack)

        self.read_path(list_path, timeout=DEFAULT_TIMEOUT)
        updated = self.get_list(list_path)
        if index >= len(updated) or updated[index] != new_name:
            raise ProtocolError("device did not rename preset %r" % old_name)
        if preset.path:
            try:
                self.read_path(preset.path, timeout=2.0)
            except StompError:
                pass
        self._log("renamed preset %r to %r" % (old_name, new_name))

    def read_list(self, path: str) -> list[str]:
        try:
            self.read_path(path)
        except StompError:
            pass
        return self.get_list(path)

    # ---- tree queries ---------------------------------------------------

    def _value(self, path: str) -> Any:
        with self._cache_lock:
            return self.nodes.get(path, {}).get("value")

    def get_value(self, path: str) -> Any:
        return self._value(normalize_path(path))

    def get_list(self, path: str) -> list[str]:
        with self._cache_lock:
            value = self.nodes.get(path, {}).get("value")
        if isinstance(value, list):
            return [item if isinstance(item, str) else str(item) for item in value]
        return []

    def get_preset_state(self) -> PresetState:
        with self._cache_lock:
            nodes = dict(self.nodes)

        preset_path: str | None = None
        if PRESET_PATH in nodes:
            preset_path = PRESET_PATH
        else:
            for path, node in nodes.items():
                if (path_name(path) == "preset" and
                        node.get("type") == "plist" and
                        isinstance(node.get("value"), str)):
                    preset_path = path
                    break

        current = ""
        list_path: str | None = None
        if preset_path:
            node = nodes.get(preset_path, {})
            if isinstance(node.get("value"), str):
                current = node["value"]
            ref = node.get("ref")
            if isinstance(ref, str) and _interesting_path(normalize_path(ref)):
                list_path = normalize_path(ref)

        if not list_path:
            list_path = PRESET_LIST_PATH if PRESET_LIST_PATH in nodes else None

        if not list_path:
            for path, node in nodes.items():
                if node.get("type") == "list":
                    item_type = node.get("item_type")
                    if isinstance(item_type, str) and item_type.startswith("pst"):
                        list_path = path
                        break

        names: list[str] = []
        if list_path:
            value = nodes.get(list_path, {}).get("value")
            if isinstance(value, list):
                names = [item if isinstance(item, str) else str(item)
                         for item in value]

        return PresetState(preset_path, list_path, current, names)

    def _find_router_path(self) -> str | None:
        with self._cache_lock:
            nodes = dict(self.nodes)
        if ROUTER_PATH in nodes:
            return ROUTER_PATH
        routers = [path for path, node in nodes.items()
                   if node.get("type") == "router"]
        if routers:
            # Prefer a router whose parent also contains a master/output item.
            for path in routers:
                parent = path_parent(path)
                if any(child in nodes for child in
                       (parent + r"\master", parent + r"\output")):
                    return path
            return routers[0]
        return None

    def get_chain_blocks(self) -> list[BlockState]:
        router_path = self._find_router_path()
        paths: list[str] = []
        with self._cache_lock:
            nodes = dict(self.nodes)

        if router_path:
            value = nodes.get(router_path, {}).get("value")
            paths = flatten_router(value)

        if not paths:
            # Older firmware may not expose a router node; use the known chain
            # if its blocks are present.
            candidate = [r"root\app\%s" % name for name in DEFAULT_CHAIN]
            present = [path for path in candidate
                       if path in nodes or (path + r"\on_off") in nodes]
            if present:
                paths = present

        if not paths:
            # Last resort: every direct child of root\app with an on_off node.
            prefix = "root\\app\\"
            for path in sorted(nodes):
                if path.startswith(prefix) and path.endswith(r"\on_off"):
                    block = path[:-len(r"\on_off")]
                    basename = path_name(block)
                    if basename in BLOCK_LABELS:
                        paths.append(block)

        result: list[BlockState] = []
        seen: set[str] = set()
        for path in paths:
            if path in seen:
                continue
            seen.add(path)
            node = nodes.get(path, {})
            on_path = path + r"\on_off"
            value = nodes.get(on_path, {}).get("value")
            if value == "ON":
                on: bool | None = True
            elif value == "OFF":
                on = False
            else:
                on = None
            result.append(BlockState(path=path,
                                     label=block_label(path, node),
                                     on=on, on_path=on_path))
        return result

    def _chain_layout(self) -> tuple[str, list[list[Any]], list[list[Any]]]:
        """Return ``(router_path, matrix, fixed_matrix)`` from the cache."""
        router_path = self._find_router_path()
        if not router_path:
            raise StompError("the device does not expose a signal-chain router")
        with self._cache_lock:
            node = dict(self.nodes.get(router_path, {}))
        matrix = _router_rows(node.get("value"))
        if not matrix:
            raise StompError("the signal chain is empty or unavailable")
        return router_path, matrix, _router_rows(node.get("fixed"))

    @staticmethod
    def _chain_cell(matrix: list[list[Any]], fixed: list[list[Any]],
                    row: int, col: int) -> tuple[str | None, bool]:
        """Return ``(block_path_or_None, fixed)`` for a router cell."""
        try:
            cell = matrix[row][col]
        except (IndexError, TypeError):
            raise StompError("that chain position does not exist") from None
        if not isinstance(cell, str) or _router_cell_is_link(cell):
            raise StompError("that position is not a usable chain slot")
        text = normalize_path(cell).strip()
        if text and not _interesting_path(text):
            raise StompError("that position is not a usable chain slot")
        is_fixed = False
        try:
            is_fixed = bool(fixed[row][col])
        except (IndexError, TypeError):
            pass
        return (text or None), is_fixed

    def get_chain_slots(self) -> list[ChainSlot]:
        """Return every editable position in the current router matrix.

        This includes empty slots and fixed slots, unlike
        :meth:`get_chain_blocks`, which only returns occupied blocks.
        """
        try:
            _router_path, matrix, fixed = self._chain_layout()
        except StompError:
            return []
        slots: list[ChainSlot] = []
        for row_index, row in enumerate(matrix):
            for col_index, cell in enumerate(row):
                if not isinstance(cell, str) or _router_cell_is_link(cell):
                    continue
                text = normalize_path(cell).strip()
                if text and not _interesting_path(text):
                    continue
                is_fixed = False
                try:
                    is_fixed = bool(fixed[row_index][col_index])
                except (IndexError, TypeError):
                    pass
                link: str | None = None
                if col_index > 0:
                    try:
                        link = _router_link_type(row[col_index - 1])
                    except IndexError:
                        link = None
                slots.append(ChainSlot(row=row_index, col=col_index,
                                       path=text or None, fixed=is_fixed,
                                       link=link))
        return slots

    def get_available_blocks(self) -> list[dict[str, Any]]:
        """Return block items that are not currently referenced by the chain."""
        router_path = self._find_router_path()
        if not router_path:
            return []
        parent = path_parent(router_path)
        used = {slot.path for slot in self.get_chain_slots() if slot.path}
        with self._cache_lock:
            nodes = dict(self.nodes)
        available: list[dict[str, Any]] = []
        for path, node in nodes.items():
            if path_parent(path) != parent:
                continue
            if node.get("item_type") != "block" or path in used:
                continue
            available.append({
                "path": path,
                "name": block_label(path, node),
                "desc": node.get("desc") or "",
            })
        available.sort(key=lambda item: (
            item["name"].casefold(), item["path"]))
        return available

    def _enable_block_and_ancestors(self, block_path: str) -> None:
        """Turn on a block and any parent modules that expose ``on_off``."""
        path = normalize_path(block_path)
        while path and path != "root":
            on_path = path + r"\on_off"
            with self._cache_lock:
                node = self.nodes.get(on_path)
            if node is not None and node.get("value") != "ON":
                self.write(on_path, "ON")
            path = path_parent(path)

    def add_chain_block(self, row: int, col: int, block_path: str) -> None:
        """Place an available block into an empty chain slot."""
        block_path = normalize_path(block_path)
        with self.pause_polling():
            with self._cache_lock:
                node = self.nodes.get(block_path)
            if node is None or node.get("item_type") != "block":
                raise StompError("that block is not available")
            if any(slot.path == block_path
                   for slot in self.get_chain_slots()):
                raise StompError("that block is already in the signal chain")
            router_path, matrix, fixed = self._chain_layout()
            current, is_fixed = self._chain_cell(matrix, fixed, row, col)
            if current is not None:
                raise StompError("that chain slot is already occupied")
            if is_fixed:
                raise StompError("that chain slot is fixed")
            matrix[row][col] = block_path
            self.write(router_path, matrix)
            self._enable_block_and_ancestors(block_path)
            with self._cache_lock:
                label_node = dict(self.nodes.get(block_path, {}))
        self._log("added %s to the signal chain"
                  % block_label(block_path, label_node))

    def remove_chain_block(self, row: int, col: int) -> str:
        """Remove the block in a chain slot and return its path."""
        with self.pause_polling():
            router_path, matrix, fixed = self._chain_layout()
            current, is_fixed = self._chain_cell(matrix, fixed, row, col)
            if current is None:
                raise StompError("that chain slot is empty")
            if is_fixed:
                raise StompError("that block is fixed and cannot be removed")
            matrix[row][col] = ""
            self.write(router_path, matrix)
            with self._cache_lock:
                label_node = dict(self.nodes.get(current, {}))
        self._log("removed %s from the signal chain" %
                  block_label(current, label_node))
        return current

    def move_chain_block(self, row: int, col: int,
                         target_row: int, target_col: int) -> None:
        """Move a block to another slot, swapping with an occupied slot."""
        if (row, col) == (target_row, target_col):
            return
        with self.pause_polling():
            router_path, matrix, fixed = self._chain_layout()
            source, source_fixed = self._chain_cell(matrix, fixed, row, col)
            target, target_fixed = self._chain_cell(
                matrix, fixed, target_row, target_col)
            if source is None:
                raise StompError("that chain slot is empty")
            if source_fixed or target_fixed:
                raise StompError("fixed blocks cannot be moved")
            matrix[row][col] = target or ""
            matrix[target_row][target_col] = source
            self.write(router_path, matrix)
            with self._cache_lock:
                label_node = dict(self.nodes.get(source, {}))
        self._log("moved %s in the signal chain" %
                  block_label(source, label_node))

    def get_chain_link(self, row: int, col: int) -> str:
        """Return the link into a slot: ``"series"`` or ``"parallel"``.

        This is the Series/Parallel selector shown before a block.  The first
        slot in a row has no previous link and raises ``StompError``.
        """
        _router_path, matrix, fixed = self._chain_layout()
        self._chain_cell(matrix, fixed, row, col)
        if col <= 0:
            raise StompError("the first chain slot has no previous link")
        try:
            cell = matrix[row][col - 1]
        except (IndexError, TypeError):
            raise StompError("that chain position has no link") from None
        link = _router_link_type(cell)
        if link is None:
            raise StompError("that chain position has no link")
        return link

    def set_chain_link(self, row: int, col: int, parallel: bool) -> None:
        """Set the link into a slot to Series (``False``) or Parallel.

        Only the link marker between the previous slot and the selected slot
        is changed; the blocks themselves are untouched.
        """
        with self.pause_polling():
            router_path, matrix, fixed = self._chain_layout()
            slot_path, _slot_fixed = self._chain_cell(matrix, fixed, row, col)
            if col <= 0:
                raise StompError("the first chain slot has no previous link")
            try:
                current = matrix[row][col - 1]
            except (IndexError, TypeError):
                raise StompError("that chain position has no link") from None
            if _router_link_type(current) is None:
                raise StompError("that chain position has no link")
            link = "p" if parallel else "s"
            if current.strip().lower() != link:
                matrix[row][col - 1] = link
                self.write(router_path, matrix)
            with self._cache_lock:
                label_node = dict(self.nodes.get(slot_path or "", {}))
        slot_label = (block_label(slot_path, label_node) if slot_path
                      else "empty slot")
        self._log("set the link before %s to %s" %
                  (slot_label, "Parallel" if parallel else "Series"))

    def _find_master_paths(self) -> dict[str, str] | None:
        with self._cache_lock:
            nodes = dict(self.nodes)
        router_path = self._find_router_path()
        candidates: list[str] = []
        if router_path:
            parent = path_parent(router_path)
            candidates.extend([parent + r"\master", parent + r"\output"])
        candidates.extend([MASTER_PATH, r"root\app\master"])
        for base in candidates:
            if base in nodes and (base + r"\vol") in nodes:
                return {"base": base}
        for path in nodes:
            if path_name(path) in ("master", "output") and (path + r"\vol") in nodes:
                return {"base": path}
        return None

    def get_master_controls(self) -> tuple[ControlState | None, ControlState | None]:
        found = self._find_master_paths()
        if not found:
            return None, None
        base = found["base"]
        with self._cache_lock:
            nodes = dict(self.nodes)

        volume = None
        vol_path = base + r"\vol"
        vol_node = nodes.get(vol_path, {})
        vol_value = _as_float(vol_node.get("value"))
        if vol_value is not None:
            volume = ControlState(
                path=vol_path, label="Master volume", value=vol_value,
                min=_as_float(vol_node.get("min")) or 0.0,
                max=_as_float(vol_node.get("max")) or 100.0,
                step=1.0,
            )

        tempo = None
        tempo_path = base + r"\tempo_bpm"
        tempo_node = nodes.get(tempo_path, {})
        tempo_value = _as_float(tempo_node.get("value"))
        if tempo_value is None:
            tempo_path = base + r"\pst\tmp"
            tempo_node = nodes.get(tempo_path, {})
            tempo_value = _as_float(tempo_node.get("value"))
        if tempo_value is not None:
            tempo = ControlState(
                path=tempo_path, label="Tempo", value=tempo_value,
                min=_as_float(tempo_node.get("min")) or 20.0,
                max=_as_float(tempo_node.get("max")) or 300.0,
                step=1.0,
            )
        return volume, tempo

    # ---- settings / system ---------------------------------------------

    def get_control(self, path: str, *,
                    step: float = 1.0) -> ControlState | None:
        """Return a float node as a ``ControlState``, or ``None``."""
        path = normalize_path(path)
        with self._cache_lock:
            node = dict(self.nodes.get(path, {}))
        value = _as_float(node.get("value"))
        if value is None:
            return None
        minimum = _as_float(node.get("min"))
        maximum = _as_float(node.get("max"))
        return ControlState(
            path=path,
            label=str(node.get("desc") or path_name(path)),
            value=value,
            min=0.0 if minimum is None else minimum,
            max=100.0 if maximum is None else maximum,
            step=step,
        )

    def get_enum(self, path: str) -> dict[str, Any] | None:
        """Return an enum node's value/options, or ``None``."""
        path = normalize_path(path)
        with self._cache_lock:
            node = dict(self.nodes.get(path, {}))
        if node.get("type") != "enum":
            return None
        options = [str(option) for option in node.get("options") or []]
        return {
            "path": path,
            "value": "" if node.get("value") is None else str(node.get("value")),
            "options": options,
            "desc": str(node.get("desc") or path_name(path)),
        }

    def get_string(self, path: str) -> dict[str, Any] | None:
        """Return a string-valued node, or ``None``."""
        path = normalize_path(path)
        with self._cache_lock:
            node = dict(self.nodes.get(path, {}))
        value = node.get("value")
        if not isinstance(value, str):
            return None
        return {
            "path": path,
            "value": value,
            "desc": str(node.get("desc") or path_name(path)),
            "item_type": str(node.get("item_type") or ""),
        }

    @staticmethod
    def _enum_is_on(node: dict[str, Any] | None) -> bool | None:
        if not node:
            return None
        value = str(node.get("value") or "").upper()
        if value == "ON":
            return True
        if value == "OFF":
            return False
        return None

    def get_tuner_state(self) -> dict[str, Any] | None:
        """Return the tuner's enable/reference/live frequency state."""
        with self._cache_lock:
            nodes = dict(self.nodes)
        if TUNER_PATH not in nodes:
            return None
        on = self.get_enum(TUNER_PATH + r"\on_off")
        reference = self.get_enum(TUNER_PATH + r"\tuner\ref")
        frequency = self.get_control(TUNER_PATH + r"\tuner\_freq", step=0.1)
        level = self.get_control(TUNER_PATH + r"\tuner\lvl", step=0.1)
        return {
            "path": TUNER_PATH,
            "on_path": TUNER_PATH + r"\on_off",
            "on": self._enum_is_on(on),
            "frequency_path": TUNER_PATH + r"\tuner\_freq",
            "frequency": frequency.value if frequency else None,
            "level_path": TUNER_PATH + r"\tuner\lvl",
            "level": level.value if level else None,
            "reference_path": TUNER_PATH + r"\tuner\ref",
            "reference": reference["value"] if reference else "",
            "references": reference["options"] if reference else [],
        }

    def read_tuner_state(self, *, with_level: bool = True,
                         timeout: float = 1.0) -> dict[str, Any] | None:
        """Read the two live tuner leaves and return fresh tuner state."""
        state = self.get_tuner_state()
        if state is None:
            return None
        paths = [state["frequency_path"]]
        if with_level:
            paths.append(state["level_path"])
        for path in paths:
            try:
                self.read_path(path, timeout=timeout)
            except StompError:
                pass
        return self.get_tuner_state()

    def get_input_settings(self) -> dict[str, Any] | None:
        with self._cache_lock:
            nodes = dict(self.nodes)
        if INPUT_PATH not in nodes:
            return None
        return {
            "path": INPUT_PATH,
            "gain1": self.get_control(INPUT_PATH + r"\gain1", step=0.5),
            "gain2": self.get_control(INPUT_PATH + r"\gain2", step=0.5),
            "connected1": self.get_enum(INPUT_PATH + r"\_connected1"),
            "connected2": self.get_enum(INPUT_PATH + r"\_connected2"),
        }

    def get_ctrl_settings(self) -> dict[str, Any] | None:
        with self._cache_lock:
            nodes = dict(self.nodes)
        if CTRL_PATH not in nodes:
            return None
        return {
            "path": CTRL_PATH,
            "heel": self.get_control(CTRL_PATH + r"\hlv", step=1.0),
            "toe": self.get_control(CTRL_PATH + r"\tev", step=1.0),
            "position": self.get_control(CTRL_PATH + r"\_clvl", step=1.0),
        }

    def get_misc_settings(self) -> dict[str, Any] | None:
        with self._cache_lock:
            nodes = dict(self.nodes)
        if MISC_PATH not in nodes:
            return None
        return {
            "path": MISC_PATH,
            "midi_channel": self.get_enum(MISC_PATH + r"\midi_a"),
            "encoder": self.get_enum(MISC_PATH + r"\encoder"),
            "headphones": self.get_enum(MISC_PATH + r"\headp"),
            "ground_lift": self.get_enum(MISC_PATH + r"\lift"),
            "factory_path": MISC_PATH + r"\factory",
        }

    def get_usb_settings(self) -> dict[str, Any] | None:
        with self._cache_lock:
            nodes = dict(self.nodes)
        if USB_PATH not in nodes:
            return None
        return {
            "path": USB_PATH,
            "mode": self.get_enum(USB_PATH + r"\mode"),
            "status": self.get_enum(USB_PATH + r"\_status"),
            "volume": self.get_control(USB_PATH + r"\_volume", step=0.5),
        }

    def get_preset_extras(self) -> dict[str, Any] | None:
        """Return per-preset level, colour, tempo and controller state."""
        with self._cache_lock:
            nodes = dict(self.nodes)
        if PRESET_EXTRAS_PATH not in nodes:
            return None
        color = self.get_string(PRESET_EXTRAS_PATH + r"\color")
        return {
            "path": PRESET_EXTRAS_PATH,
            "level": self.get_control(PRESET_EXTRAS_PATH + r"\level",
                                      step=0.5),
            "tempo": self.get_control(PRESET_EXTRAS_PATH + r"\tmp",
                                      step=1.0),
            "color_path": PRESET_EXTRAS_PATH + r"\color",
            "color": color["value"] if color else "",
            "global_tempo": self.get_control(
                r"root\app\output\tempo_bpm", step=1.0),
        }

    def get_device_identity(self) -> dict[str, Any]:
        """Return system identity fields used by the About/setup UI."""
        alias = self.get_string(r"root\sys\alias")
        return {
            "alias": alias["value"] if alias else "",
            "alias_path": r"root\sys\alias",
            "name": self.device_name or str(
                self._value(r"root\sys\_name") or ""),
            "firmware": self.firmware or str(
                self._value(r"root\sys\_ver") or ""),
            "arch": str(self._value(r"root\sys\_arch") or ""),
            "author": str(self._value(r"root\sys\_author") or ""),
            "license": str(self._value(r"root\sys\_license") or ""),
            "id": self.device_id or str(self._value(r"root\sys\_id") or ""),
            "logo": str(self._value(r"root\sys\_logo") or ""),
            "usb_status": str(self._value(r"root\usb\_status") or ""),
        }

    def set_alias(self, alias: str) -> None:
        """Set the device's display alias (empty clears it)."""
        alias = alias.strip()
        if any(ord(character) < 32 for character in alias):
            raise ValueError("device alias cannot contain control characters")
        if len(alias) > 128:
            raise ValueError("device alias must be at most 128 characters")
        self.write(r"root\sys\alias", alias)
        self._log("device alias set to %r" % alias)

    # ---- actions / chain utilities --------------------------------------

    def trigger_action(self, path: str, value: str = "run") -> None:
        """Trigger a device NodeAction (for example a confirmation action)."""
        path = normalize_path(path)
        with self._cache_lock:
            node = dict(self.nodes.get(path, {}))
        if node.get("type") != "action":
            raise StompError("%s is not an action node" % path)
        self.write(path, value)
        self._log("triggered device action %s"
                  % (node.get("desc") or path_name(path)))

    def factory_reset(self) -> None:
        """Request the device factory reset (destructive; confirm in the UI)."""
        self.trigger_action(MISC_PATH + r"\factory")

    def clear_chain(self) -> None:
        """Remove all non-fixed blocks, preserving connectors and fixed blocks."""
        with self.pause_polling():
            router_path, matrix, fixed = self._chain_layout()
            cleared: list[list[Any]] = []
            for row_index, row in enumerate(matrix):
                new_row: list[Any] = []
                for col_index, cell in enumerate(row):
                    is_fixed = False
                    try:
                        is_fixed = bool(fixed[row_index][col_index])
                    except (IndexError, TypeError):
                        pass
                    if is_fixed or _router_cell_is_link(cell):
                        new_row.append(cell)
                    else:
                        new_row.append("")
                cleared.append(new_row)
            self.write(router_path, cleared)
        self._log("cleared the signal chain")

    def restore_default_chain(self) -> None:
        """Restore the router's default matrix (the device's ``def`` field)."""
        router_path = self._find_router_path()
        if not router_path:
            raise StompError("the device does not expose a signal-chain router")
        with self._cache_lock:
            node = dict(self.nodes.get(router_path, {}))
        default = _router_rows(node.get("def"))
        if not default:
            raise StompError("the device does not expose a default signal chain")
        matrix = [
            [normalize_path(cell) if isinstance(cell, str) else cell
             for cell in row]
            for row in default
        ]
        with self.pause_polling():
            self.write(router_path, matrix)
        self._log("loaded the default signal chain")

    def _parameter_from_node(self, path: str, node: dict[str, Any],
                             nodes: dict[str, dict[str, Any]]
                             ) -> dict[str, Any] | None:
        """Build a UI parameter dict from one node, or ``None``.

        ``pfloat`` nodes are the controls of a parametric NAM (``.pnam``)
        model.  Their device value is normalized (0..1), while the ``style``
        string carries the user-facing name and range (``vname``/``vmin``/
        ``vmax``/``vdef``).  They are returned as ``kind == "pfloat"`` with
        both the raw and display ranges so the UI can map writes correctly.
        """
        value = node.get("value")
        ntype = node.get("type")
        desc = node.get("desc") or ""
        name = path_name(path)
        style = parse_style(node.get("style"))
        visible = style.get("visible", "").strip().lower() not in (
            "false", "0", "no", "off")
        model_type = _block_model_type(path, nodes)

        if ntype == "pfloat":
            visible = _type_aware_visibility(
                name, ntype, "", visible, model_type)
            raw_min = _as_float(node.get("min"))
            raw_max = _as_float(node.get("max"))
            if raw_min is None:
                raw_min = 0.0
            if raw_max is None or raw_max <= raw_min:
                raw_max = 1.0

            display_min = _as_float(style.get("vmin"))
            display_max = _as_float(style.get("vmax"))
            display_default = _as_float(style.get("vdef"))
            display_decimals = style.get("vdec")
            try:
                decimals = int(float(display_decimals))
            except (TypeError, ValueError):
                decimals = 1

            # A switch control is exposed as a pfloat too.  Older firmware
            # embeds its choices in a dedicated style key; 2.5.3 serializes
            # them as a JSON array in ``vtype`` (for example
            # ``vtype:["ON","OFF"]``).  Accept both spellings.
            raw_vtype = str(style.get("vtype") or "continuous").strip()
            options: list[str] = []
            for key in ("voptions", "vnames", "venums", "vvalues", "vitems",
                        "vlist"):
                raw_options = style.get(key)
                if not raw_options:
                    continue
                parts = [part.strip() for part in
                         re.split(r"[|,]", raw_options) if part.strip()]
                if len(parts) > 1:
                    options = parts
                    break
            if not options and raw_vtype.startswith("["):
                try:
                    parsed_options = json.loads(raw_vtype)
                except (TypeError, ValueError):
                    parsed_options = None
                if isinstance(parsed_options, list):
                    parts = [str(part).strip() for part in parsed_options
                             if str(part).strip()]
                    if len(parts) > 1:
                        options = parts
            vtype = raw_vtype.lower()
            if options and raw_vtype.startswith("["):
                # Tell the UI this is a discrete switch, not a continuous
                # 0..1 control.  The device stores the option index as
                # ``index / (count - 1)``.
                vtype = "switch"

            param: dict[str, Any] = {
                "path": path, "name": name, "kind": "pfloat",
                "value": value,
                "min": raw_min, "max": raw_max,
                "desc": style.get("vname") or desc or name,
                "visible": visible,
                "pfloat": True,
                "vtype": vtype,
                "unit": style.get("vunit") or node.get("unit") or "",
                "display_decimals": max(0, min(6, decimals)),
            }
            if display_min is not None and display_max is not None and \
                    display_max > display_min:
                param["display_min"] = display_min
                param["display_max"] = display_max
                if display_default is not None:
                    param["display_default"] = display_default
            if options:
                param["options"] = options
            return param

        if ntype == "float":
            return {
                "path": path, "name": name, "kind": "float",
                "value": value,
                "min": node.get("min"), "max": node.get("max"),
                "unit": node.get("unit") or "", "dec": node.get("dec"),
                "desc": desc,
                "visible": _type_aware_visibility(
                    name, ntype, "", visible, model_type),
            }
        if ntype == "enum":
            options = node.get("options")
            if isinstance(options, list) and options:
                return {
                    "path": path, "name": name, "kind": "enum",
                    "value": value,
                    "options": [str(option) for option in options],
                    "desc": desc,
                    "visible": _type_aware_visibility(
                        name, ntype, "", visible, model_type),
                }
            return None
        if ntype == "plist":
            # A parameter list references a NodeList of choices (e.g. the
            # drive/amp model or the cabinet IR).  Offer the list entries
            # as selectable options.
            ref = node.get("ref")
            options: list[str] = []
            list_type = ""
            if isinstance(ref, str):
                list_node = nodes.get(normalize_path(ref), {})
                list_value = list_node.get("value")
                list_type = str(list_node.get("item_type") or "")
                if isinstance(list_value, list):
                    options = [str(item) for item in list_value if str(item)]
            return {
                "path": path, "name": name, "kind": "choice",
                "value": value, "options": options, "desc": desc,
                "visible": _type_aware_visibility(
                    name, ntype, list_type, visible, model_type),
                "item_type": list_type,
            }
        if isinstance(value, bool):
            return {"path": path, "name": name, "kind": "bool",
                    "value": value, "desc": desc,
                    "visible": _type_aware_visibility(
                        name, ntype, "", visible, model_type)}
        if isinstance(value, (int, float)):
            return {"path": path, "name": name, "kind": "number",
                    "value": value, "desc": desc,
                    "visible": _type_aware_visibility(
                        name, ntype, "", visible, model_type)}
        if isinstance(value, str) and value != "":
            return {"path": path, "name": name, "kind": "text",
                    "value": value, "desc": desc,
                    "visible": _type_aware_visibility(
                        name, ntype, "", visible, model_type)}
        return None

    def _group_from_node(self, path: str, node: dict[str, Any],
                         nodes: dict[str, dict[str, Any]]) -> dict[str, Any]:
        """Build a folder/module group, including its editable children."""
        item_type = node.get("item_type") or ""
        on_path = path + r"\on_off"
        on_node = nodes.get(on_path)
        on_off = None
        if on_node is not None:
            on_value = on_node.get("value")
            enabled: bool | None = None
            if on_value == "ON":
                enabled = True
            elif on_value == "OFF":
                enabled = False
            on_off = {"path": on_path, "value": enabled}
        params, groups, items = self._collect_control_children(path, nodes)
        style = parse_style(node.get("style"))
        group: dict[str, Any] = {
            "kind": "group",
            "path": path,
            "name": path_name(path),
            "label": node.get("desc") or path_name(path),
            "item_type": item_type,
            "on_off": on_off,
            "parameters": params,
            "groups": groups,
            "items": items,
            "visible": style.get("visible", "").strip().lower() not in (
                "false", "0", "no", "off"),
        }
        if item_type == "module":
            named = {param["name"]: param for param in params}
            rawdata = named.get("rawdata")
            subdivision = named.get("sbdv")
            lock = named.get("lock")
            if rawdata is not None and subdivision is not None:
                keep = [param for param in params
                        if param["name"] not in ("rawdata", "sbdv", "lock")]
                keep_items = [item for item in items
                              if item not in (rawdata, subdivision, lock)]
                unit = rawdata.get("unit") or ""
                manual_label = "Manual (%s)" % unit if unit else "Manual"
                group.update({
                    "kind": "time",
                    "module_value": node.get("value"),
                    "parameters": keep,
                    "items": keep_items,
                    "rawdata": rawdata,
                    "subdivision": subdivision,
                    "lock": lock,
                    "mode_options": [
                        {"value": "partempo", "label": "Tempo Sync"},
                        {"value": "rawdata", "label": manual_label},
                    ],
                })
        return group

    def _collect_control_children(
            self, path: str, nodes: dict[str, dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]],
               list[dict[str, Any]]]:
        params: list[dict[str, Any]] = []
        groups: list[dict[str, Any]] = []
        items: list[dict[str, Any]] = []
        for child_path, node in _direct_children(nodes, path):
            name = path_name(child_path)
            if name == "on_off" or name.startswith("_"):
                continue
            item_type = node.get("item_type") or ""
            if item_type == "link":
                continue
            if item_type in _CONTROL_FOLDER_TYPES or item_type == "module":
                group = self._group_from_node(child_path, node, nodes)
                groups.append(group)
                items.append(group)
                continue
            param = self._parameter_from_node(child_path, node, nodes)
            if param is not None:
                params.append(param)
                items.append(param)
        return params, groups, items

    def get_block_editor(self, block_path: str) -> dict[str, Any]:
        """Return a block's controls, including nested folders/modules.

        The result has ``parameters`` (direct scalar controls), ``groups``
        (folders/modules) and ``items`` (both kinds in browse-tree order).
        Groups may contain further ``parameters``/``groups``/``items``.  Time
        and rate modules are marked ``kind == "time"`` and expose their
        ``rawdata``, ``subdivision`` and ``lock`` controls.
        """
        block_path = normalize_path(block_path)
        with self._cache_lock:
            nodes = dict(self.nodes)
        params, groups, items = self._collect_control_children(
            block_path, nodes)
        return {"parameters": params, "groups": groups, "items": items}

    def get_block_parameters(self, block_path: str) -> list[dict[str, Any]]:
        """Return the editable child parameters of a block node.

        Only direct children are returned (one level below the block).  Each
        entry is a dict with ``path``, ``name``, ``kind`` (one of ``float``,
        ``enum``, ``choice``, ``number``, ``bool``, ``text``), ``value`` and,
        where available, ``min``/``max``/``unit``/``options``/``desc``.
        """
        block_path = normalize_path(block_path)
        with self._cache_lock:
            nodes = dict(self.nodes)

        params: list[dict[str, Any]] = []
        for path, node in _direct_children(nodes, block_path):
            name = path_name(path)
            if name == "on_off" or name.startswith("_"):
                continue
            param = self._parameter_from_node(path, node, nodes)
            if param is not None:
                params.append(param)

        params.sort(key=lambda param: param["name"])
        return params

    def get_global_eq(self) -> dict[str, Any] | None:
        """Return the global parametric EQ controls, if the device has one.

        The result contains ``path``, ``on_path``, ``enabled`` and a list of
        ``bands``.  Each band has ``index`` plus whichever of ``gain``,
        ``frequency``, ``q``, ``type`` and ``slope`` parameter dicts exist.
        """
        with self._cache_lock:
            nodes = dict(self.nodes)
        path = GLOBAL_EQ_PATH if GLOBAL_EQ_PATH in nodes else None
        if path is None:
            for candidate, node in nodes.items():
                if (path_name(candidate) == "global_eq" and
                        node.get("type") == "item"):
                    path = candidate
                    break
        if path is None:
            return None

        on_path = path + r"\on_off"
        on_value = nodes.get(on_path, {}).get("value")
        if on_value == "ON":
            enabled: bool | None = True
        elif on_value == "OFF":
            enabled = False
        else:
            enabled = None

        editor = self.get_block_editor(path)
        bands: dict[int, dict[str, Any]] = {}
        keys = {"band": "gain", "freq": "frequency", "q": "q",
                "type": "type", "slope": "slope"}
        for param in flatten_editor_parameters(editor):
            match = re.match(r"^(band|freq|q|type|slope)_(\d+)$",
                             param["name"])
            if not match:
                continue
            index = int(match.group(2))
            band = bands.setdefault(index, {"index": index})
            band[keys[match.group(1)]] = param
        return {
            "path": path,
            "on_path": on_path,
            "enabled": enabled,
            "bands": [bands[index] for index in sorted(bands)],
        }

    def _get_dual_group(self, block_path: str, folder: str, child: str,
                        kind: str) -> dict[str, Any] | None:
        block_path = normalize_path(block_path)
        folder_path = block_path + "\\" + folder
        on_path = folder_path + r"\on_off"
        with self._cache_lock:
            nodes = dict(self.nodes)
        if folder_path not in nodes or (folder_path + "\\" + child) not in nodes:
            return None

        value = nodes.get(on_path, {}).get("value")
        if value == "ON":
            enabled: bool | None = True
        elif value == "OFF":
            enabled = False
        else:
            enabled = None
        return {
            "kind": kind,
            "path": folder_path,
            "on_path": on_path,
            "enabled": enabled,
            "parameters": self.get_block_parameters(folder_path),
        }

    def get_dual_block(self, block_path: str) -> dict[str, Any] | None:
        """Return the parallel second half of an Amp or IR block, if exposed.

        Firmware with dual NAM puts a second model/gain/tone group under
        ``<amp>\\nam2``; the IR loader has always used the equivalent
        ``<ir>\\ir2`` group.  Older firmware exposes only the direct
        parameters, so callers can use this to decide whether to show the
        second section.
        """
        for folder, child, kind in (
                ("nam2", "model", "nam"), ("ir2", "ir", "ir")):
            dual = self._get_dual_group(block_path, folder, child, kind)
            if dual is not None:
                return dual
        return None

    def get_upload_targets(self) -> list[UploadTarget]:
        with self._cache_lock:
            nodes = dict(self.nodes)
        targets = [
            UploadTarget(NAM_PATH, "Amp model (.nam)", "nam"),
            UploadTarget(NAM_DRIVE_PATH, "Drive model (.nam)", "nam"),
            UploadTarget(IR_PATH, "IR / cabinet (.wav)", "ir"),
        ]
        present = [t for t in targets if t.path in nodes]

        # Parametric NAM libraries are exposed as ordinary NodeLists with
        # item_type "pnam" (2 MiB slots).  Prefer the known amp/drive paths,
        # then include any additional pnam list the firmware exposes.
        pnam_paths: list[str] = []
        for path in (PNAM_PATH, PNAM_DRIVE_PATH):
            node = nodes.get(path)
            if node is not None and str(node.get("item_type", "")).lower() == "pnam":
                pnam_paths.append(path)
        for path, node in sorted(nodes.items()):
            if path in pnam_paths:
                continue
            if (node.get("type") == "list" and
                    str(node.get("item_type", "")).lower() == "pnam"):
                pnam_paths.append(path)

        for path in pnam_paths:
            node = nodes.get(path, {})
            haystack = ("%s %s" % (path, node.get("desc", ""))).lower()
            label = ("Parametric drive (.pnam)" if "drive" in haystack
                     else "Parametric amp (.pnam)")
            present.append(UploadTarget(path, label, "pnam"))

        order = {NAM_PATH: 0, PNAM_PATH: 1, NAM_DRIVE_PATH: 2,
                 PNAM_DRIVE_PATH: 3, IR_PATH: 4}
        present.sort(key=lambda target: order.get(target.path, 10))
        if present:
            return present
        # Before the first browse, show the common targets.
        return [targets[0], targets[2]]

    def state(self) -> DeviceState:
        preset = self.get_preset_state()
        blocks = self.get_chain_blocks()
        volume, tempo = self.get_master_controls()
        lists: dict[str, list[str]] = {}
        for target in self.get_upload_targets():
            lists[target.path] = self.get_list(target.path)
        if preset.list_path:
            lists[preset.list_path] = list(preset.names)

        meters: dict[str, float] = {}
        for key in ("in0", "in1", "out0", "out1"):
            value = _as_float(self._value(r"root\sys\_meters\_" + key))
            if value is not None:
                meters[key] = value
        inputs = [meters[key] for key in ("in0", "in1") if key in meters]
        outputs = [meters[key] for key in ("out0", "out1") if key in meters]
        meter_in = max(inputs) if inputs else None
        meter_out = max(outputs) if outputs else None

        return DeviceState(
            connected=self._connected,
            device_name=self.device_name or str(self._value(r"root\sys\_name") or ""),
            firmware=self.firmware or str(self._value(r"root\sys\_ver") or ""),
            device_id=self.device_id or str(self._value(r"root\sys\_id") or ""),
            usb_status=str(self._value(r"root\usb\_status") or ""),
            preset=preset,
            blocks=blocks,
            volume=volume,
            tempo=tempo,
            meter_in=meter_in,
            meter_out=meter_out,
            meters=meters,
            lists=lists,
        )

    # ---- polling --------------------------------------------------------

    def start_polling(self) -> None:
        if self._poll_thread and self._poll_thread.is_alive():
            return
        self._poll_stop.clear()
        self._poll_thread = threading.Thread(
            target=self._poll_loop, name="stomp-poller", daemon=True)
        self._poll_thread.start()

    def stop_polling(self) -> None:
        self._poll_stop.set()
        thread, self._poll_thread = self._poll_thread, None
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    @contextmanager
    def pause_polling(self) -> Iterator[None]:
        """Stop the poller from stealing upload ACKs for the duration."""
        self._poll_pause.set()
        try:
            with self._io_lock:
                yield
        finally:
            self._poll_pause.clear()

    def _poll_loop(self) -> None:
        last_browse = 0.0
        while not self._poll_stop.is_set():
            if not self._poll_pause.is_set() and self._connected:
                try:
                    # Some firmware only reports live meters via `read root`
                    # on the network transport; periodically refresh the full
                    # tree so parameter/preset/chain changes are picked up.
                    if (self.full_refresh_interval > 0 and
                            time.monotonic() - last_browse >= self.full_refresh_interval):
                        self.browse_root(timeout=5.0, quiet=True)
                        last_browse = time.monotonic()
                    else:
                        self.read_root()
                    self._poll_errors = 0
                except AuthenticationRequired:
                    self._connected = False
                    break
                except StompError as exc:
                    self._poll_errors += 1
                    if self._poll_errors in (1, 10, 50):
                        self._log("poll error: %s" % exc)
                    if isinstance(exc, ConnectionClosed):
                        self._connected = False
                        break
            self._poll_stop.wait(self.poll_interval)

    # ---- uploads --------------------------------------------------------

    def _ack_for_chunk(self, path: str, slot: int, chunk: int, value: str,
                       timeout: float = 15.0) -> tuple[int, int]:
        command = "dwrite %s:%s" % (path, json_compact({
            "index": slot, "chunk": chunk, "value": value,
        }))

        def match(lines: Sequence[ParsedLine]) -> bool:
            return any(line.path == normalize_path(path) and
                       isinstance(line.obj, dict) and
                       "index" in line.obj and "chunk" in line.obj
                       for line in lines)

        lines = self._request(command, match=match, timeout=timeout, idle=0.4)
        for line in lines:
            if isinstance(line.obj, dict) and "index" in line.obj and "chunk" in line.obj:
                try:
                    return int(line.obj["index"]), int(line.obj["chunk"])
                except (TypeError, ValueError):
                    continue
        raise ProtocolError("no valid dwrite ACK for chunk %d" % chunk)

    def _upload(self, path: str, slot: int, name: str, payload: bytes,
                *, nam_final_marker: bool,
                progress: Callable[[float, str], None] | None = None) -> None:
        name_chunk = _encode_name_chunk(name)
        chunks = _split_chunks(payload)
        if not chunks:
            raise ValueError("nothing to upload")

        def report(done: int, total: int, message: str) -> None:
            if progress:
                try:
                    progress(min(1.0, done / max(1, total)), message)
                except Exception:
                    pass

        report(0, len(chunks) + 1, "name chunk")
        idx, ack = self._ack_for_chunk(path, slot, 0, name_chunk.hex())
        if idx == -1:
            raise UploadRejected("device rejected slot %d for %s" % (slot, path))
        if idx != slot:
            raise UploadRejected(
                "device acknowledged wrong slot (wanted %d, got %d)" % (slot, idx))

        total_steps = len(chunks) + 1
        last_ack: int | None = None
        for number, chunk in enumerate(chunks, start=1):
            is_last = number == len(chunks)
            value = chunk.hex()
            if is_last and nam_final_marker and len(chunk) < CHUNK_SIZE:
                value = _nam_final_value(chunk)
            elif is_last and nam_final_marker:
                # A 1024-byte tail cannot carry the marker; send it normally
                # and follow with a marker-only chunk.
                value = chunk.hex()

            report(number, total_steps, "chunk %d/%d" % (number, len(chunks)))
            idx, ack = self._ack_for_chunk(path, slot, number, value)
            if idx == -1:
                raise UploadRejected(
                    "device rejected chunk %d of %s (slot %d)" % (number, path, slot))
            if idx != slot:
                raise UploadRejected(
                    "device acknowledged wrong slot at chunk %d (wanted %d, got %d)"
                    % (number, slot, idx))
            if ack == -1:
                return
            last_ack = ack
            if ack not in (number + 1,):
                # Some firmware repeats the current chunk; accept a repeat,
                # but abort on a clearly bogus next-chunk number.
                if ack != number:
                    raise ProtocolError(
                        "unexpected ACK: sent chunk %d, device asked for %d"
                        % (number, ack))

        if nam_final_marker and len(chunks[-1]) == CHUNK_SIZE:
            marker_number = len(chunks) + 1
            report(marker_number, marker_number, "final marker")
            idx, ack = self._ack_for_chunk(
                path, slot, marker_number, _nam_marker_value())
            if idx == -1:
                raise UploadRejected("device rejected final model marker")
            if ack != -1:
                raise ProtocolError(
                    "model upload did not finish (device asked for chunk %d)"
                    % ack)
        elif last_ack != -1:
            raise ProtocolError(
                "upload did not finish (device asked for chunk %r)" % last_ack)

    def _slot_size_for(self, target: str, default: int) -> int:
        with self._cache_lock:
            node = self.nodes.get(normalize_path(target), {})
        try:
            size = int(node.get("size"))
        except (TypeError, ValueError):
            size = 0
        return size if size > 0 else default

    def _load_model_bytes(self, data: bytes, filepath: str,
                          slot: int | None, target: str, *,
                          default_size: int, kind: str,
                          name: str | None = None,
                          progress: Callable[[float, str], None] | None = None
                          ) -> dict[str, Any]:
        target = normalize_path(target)
        slot_size = self._slot_size_for(target, default_size)
        if len(data) > slot_size:
            raise ValueError("%s file is larger than the %d MiB slot"
                             % (kind, slot_size // (1024 * 1024)))

        if name is None:
            name = nan_name_from_nam(data) or os.path.splitext(
                os.path.basename(filepath))[0]
        name = name.strip()[:NAME_SIZE] or os.path.basename(filepath)

        if slot is None:
            free = [i for i, value in enumerate(self.get_list(target)) if not value]
            if not free:
                raise StompError("no free slots in %s; choose a slot to overwrite"
                                 % target)
            slot = free[0]
        if slot < 0:
            raise ValueError("invalid slot")

        payload = gzip.compress(
            data + b"\x00" * (slot_size - len(data)), compresslevel=6)
        self._log("uploading %s %r (%d KiB -> %d KiB gzip) to %s slot %d"
                  % (kind, name, len(data) // 1024, len(payload) // 1024,
                     target, slot))
        with self.pause_polling():
            self._upload(target, slot, name, payload, nam_final_marker=True,
                         progress=progress)
        self._log("%s upload complete: %r -> slot %d" % (kind, name, slot))
        try:
            time.sleep(0.15)
            self.read_path(target, timeout=3.0)
        except StompError:
            pass
        return {"target": target, "slot": slot, "name": name}

    def load_nam(self, filepath: str, slot: int | None = None,
                 target: str | None = None, name: str | None = None,
                 progress: Callable[[float, str], None] | None = None) -> dict[str, Any]:
        with open(filepath, "rb") as f:
            nam = f.read()

        if target is None:
            gear = nam_gear_type(nam)
            drive_like = any(key in gear for key in
                             ("drive", "pedal", "dist", "fuzz", "boost", "od"))
            if drive_like:
                with self._cache_lock:
                    has_drive = NAM_DRIVE_PATH in self.nodes
                target = NAM_DRIVE_PATH if has_drive else NAM_PATH
            else:
                target = NAM_PATH
        return self._load_model_bytes(
            nam, filepath, slot, target, default_size=NAM_SLOT_SIZE,
            kind="NAM", name=name, progress=progress)

    def _pnam_target(self, gear: str = "") -> str:
        with self._cache_lock:
            nodes = dict(self.nodes)
        drive_like = any(key in gear for key in
                         ("drive", "pedal", "dist", "fuzz", "boost", "od"))
        candidates = ((PNAM_DRIVE_PATH, PNAM_PATH) if drive_like
                      else (PNAM_PATH, PNAM_DRIVE_PATH))
        for path in candidates:
            if path in nodes:
                return path
        for path, node in sorted(nodes.items()):
            if (node.get("type") == "list" and
                    str(node.get("item_type", "")).lower() == "pnam"):
                return path
        raise StompError("this firmware exposes no parametric NAM library")

    def load_pnam(self, filepath: str, slot: int | None = None,
                  target: str | None = None, name: str | None = None,
                  progress: Callable[[float, str], None] | None = None
                  ) -> dict[str, Any]:
        with open(filepath, "rb") as f:
            pnam = f.read()
        if target is None:
            target = self._pnam_target(nam_gear_type(pnam))
        return self._load_model_bytes(
            pnam, filepath, slot, target, default_size=PNAM_SLOT_SIZE,
            kind="PNAM", name=name, progress=progress)

    def load_ir(self, filepath: str, slot: int | None = None,
                name: str | None = None,
                progress: Callable[[float, str], None] | None = None) -> dict[str, Any]:
        if name is None:
            name = os.path.splitext(os.path.basename(filepath))[0]
        name = name.strip()[:NAME_SIZE] or os.path.basename(filepath)

        if slot is None:
            free = [i for i, value in enumerate(self.get_list(IR_PATH)) if not value]
            if not free:
                raise StompError("no free IR slots; choose a slot to overwrite")
            slot = free[0]

        samples, rate, channels = wav_to_ir_samples(filepath)
        if rate != 48000:
            self._log("warning: IR sample rate is %d Hz (48 kHz expected)" % rate)
        if channels != 1:
            self._log("warning: IR has %d channels; using the first channel" % channels)
        payload = struct.pack("<%df" % IR_LENGTH, *samples)
        self._log("uploading IR %r (%d samples) to %s slot %d"
                  % (name, IR_LENGTH, IR_PATH, slot))
        with self.pause_polling():
            self._upload(IR_PATH, slot, name, payload, nam_final_marker=False,
                         progress=progress)
        self._log("IR upload complete: %r -> slot %d" % (name, slot))
        try:
            time.sleep(0.15)
            self.read_path(IR_PATH, timeout=3.0)
        except StompError:
            pass
        return {"target": IR_PATH, "slot": slot, "name": name}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main(argv: Sequence[str] | None = None) -> int:
    """Launch the modern GTK4 UI (or the legacy debug UI with ``--legacy``)."""
    args = list(sys.argv[1:] if argv is None else argv)
    if "--diagnose" in args:
        devices = find_usb_stompstations()
        if devices:
            for device in devices:
                print("USB device: %s  %s:%s  %s  serial=%s  cdc_acm_bound=%s"
                      % (device["device"], device["vendor"],
                         device["product_id"], device["product"],
                         device["serial"] or "-", device["acm_bound"]))
        else:
            print("USB device: no StompStation found in /sys/bus/usb/devices")
        ports = list_serial_ports()
        if ports:
            print("Serial ports:")
            for device, description in ports:
                print("  %s  %s" % (device, description))
        else:
            print("Serial ports: none")
        message = usb_diagnostic_message()
        if message:
            print(message)
        return 0
    if "--legacy" in args:
        args.remove("--legacy")
        try:
            from stomp_ui_legacy import main as legacy_main
        except ImportError as exc:
            print("Could not start the legacy UI: %s" % exc, file=sys.stderr)
            return 1
        return legacy_main(args)
    try:
        from stomp_ui import main as ui_main
    except ImportError as exc:
        print("Could not start the GTK UI: %s" % exc, file=sys.stderr)
        print("Install PyGObject/GTK4 (e.g. 'sudo apt install python3-gi "
              "gir1.2-gtk-4.0') and try again.", file=sys.stderr)
        return 1
    return ui_main(args)


if __name__ == "__main__":
    raise SystemExit(main())

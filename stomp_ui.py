#!/usr/bin/env python3
"""
stomp_ui.py -- modern GTK4 / libadwaita UI for the Sonulab StompStation PRO.

The signal chain is shown as a horizontal row of coloured block cards
(bypassed blocks are dimmed, click a block to select and edit it).  Layout is
modelled on desktop amp/effect modelling software: device + presets on the
left, the chain and the selected-block editor in the middle, and master
controls + file upload + activity log on the right.

The older, simpler GTK4 UI is kept as ``stomp_ui_legacy.py`` for debugging.

Run with::

    python3 stomp_ui.py
    python3 stomp.py
"""

from __future__ import annotations

import argparse
import hashlib
import os
import queue
import re
import sys
import threading
import time
from typing import Any, Callable, Sequence

import gi
gi.require_version("Gtk", "4.0")
gi.require_version("Adw", "1")
from gi.repository import Adw, Gdk, Gio, GLib, Gtk, Pango

import stomp


# ---------------------------------------------------------------------------
# Styling / palette
# ---------------------------------------------------------------------------

BASE_CSS = """
@define-color card-bg alpha(currentColor, 0.16);

.title { font-weight: 800; font-size: 15px; }
.section-title { font-weight: 800; font-size: 12px; letter-spacing: 0.5px;
                 text-transform: uppercase; opacity: 0.85; }
.dim-label { opacity: 0.65; }
.value-label { font-family: monospace; }

.chain-block {
    border-radius: 12px;
    border: 2px solid alpha(currentColor, 0.55);
    background: @card-bg;
    padding: 4px;
}
.chain-block:hover { background: alpha(currentColor, 0.30); }
.chain-block:checked {
    border-color: @theme_fg_color;
    background: alpha(currentColor, 0.34);
}
.chain-block.bypassed { opacity: 0.38; }

.block-abbr { font-weight: 800; font-size: 9px; color: currentColor; }
.block-name  { font-size: 8px; }
.block-status { font-size: 7px; font-weight: 700; }

.status-ok    { color: @success_color; font-weight: 700; }
.status-error { color: @error_color; font-weight: 700; }
.status-idle  { opacity: 0.6; }
"""

# Unique colours for the standard blocks; unknown blocks get a hashed colour.
BLOCK_COLORS = {
    "gate": "#4c9aff", "pitch": "#b26bff", "pitch_time": "#c026d3",
    "exp": "#2dd4bf", "comp": "#f59e0b", "dyna_comp": "#ea580c",
    "mod_pre": "#f472b6", "drive": "#ef4444", "amp": "#fb923c",
    "ir": "#34d399", "eq": "#eab308", "eq2": "#ca8a04",
    "parametric_eq": "#a8a29e", "crossover": "#fb7185",
    "mod": "#8b5cf6", "chorus": "#2aa198", "flanger": "#0ea5e9",
    "rotary": "#f0abfc", "pickup": "#a16207", "dtchr": "#94a3b8",
    "pcm42": "#64748b", "delay": "#06b6d4", "delay2": "#0891b2",
    "reverb": "#818cf8", "reverb2": "#7c3aed",
}
FALLBACK_PALETTE = [
    "#38bdf8", "#f87171", "#fbbf24", "#34d399", "#c084fc", "#fb923c",
    "#818cf8", "#f472b6", "#a3e635", "#22d3ee", "#fca5a5", "#e2e8f0",
]

BLOCK_SHORT = {
    "gate": "GATE", "pitch": "PITCH", "pitch_time": "PITCH 2",
    "exp": "EXP", "comp": "COMP", "dyna_comp": "DYN",
    "mod_pre": "MOD", "drive": "DRIVE", "amp": "AMP", "ir": "CAB",
    "eq": "EQ", "eq2": "EQ 2", "parametric_eq": "PEQ", "crossover": "XOVER",
    "mod": "MOD", "chorus": "CHORUS", "flanger": "FLANGER",
    "rotary": "ROTARY", "pickup": "PICKUP", "dtchr": "DETUNE",
    "pcm42": "PCM42", "delay": "DLY", "delay2": "DLY 2",
    "reverb": "REV", "reverb2": "REV 2",
}


def _key_for_path(path: str) -> str:
    return path.rsplit("\\", 1)[-1]


def _color_for(key: str) -> str:
    if key in BLOCK_COLORS:
        return BLOCK_COLORS[key]
    digest = hashlib.md5(key.encode("utf-8")).hexdigest()
    return FALLBACK_PALETTE[int(digest, 16) % len(FALLBACK_PALETTE)]


def _short_for(key: str, label: str) -> str:
    if key in BLOCK_SHORT:
        return BLOCK_SHORT[key]
    return (label or key).upper()[:6]


def _css_class_for(key: str) -> str:
    return "block-" + re.sub(r"[^A-Za-z0-9_-]", "_", key)


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

class StompApp(Adw.Application):
    def __init__(self, initial_serial: str | None = None,
                 initial_tcp: str | None = None):
        super().__init__(
            application_id="io.github.stompstation.control",
            flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        self._initial_serial = initial_serial
        self._initial_tcp = initial_tcp
        self.window: "MainWindow | None" = None

    def do_activate(self) -> None:
        if self.window is None:
            self.window = MainWindow(self, self._initial_serial, self._initial_tcp)
        self.window.present()

    def do_shutdown(self) -> None:
        if self.window is not None:
            self.window.shutdown()
        Adw.Application.do_shutdown(self)


# ---------------------------------------------------------------------------
# Main window
# ---------------------------------------------------------------------------

class MainWindow(Adw.ApplicationWindow):
    def __init__(self, app: Adw.Application,
                 initial_serial: str | None = None,
                 initial_tcp: str | None = None):
        super().__init__(application=app)
        self.set_title("StompStation Pro Control")
        self.set_default_size(1280, 800)
        self.set_size_request(1000, 640)

        self._alive = True
        self._initial_serial = initial_serial
        self._initial_tcp = initial_tcp
        self._initial_done = False

        self.device: stomp.Device | None = None
        self._state: stomp.DeviceState | None = None
        self._busy = False
        self._uploading = False
        self._syncing = False
        self._scanning = False
        self._refresh_running = False

        self._log_queue: queue.Queue[str] = queue.Queue()
        self._serial_ports: list[tuple[str, str]] = []
        self._discovered: list[stomp.DiscoveredDevice] = []

        self._patch_names: list[str] = []
        self._preset_rows: dict[str, Gtk.ListBoxRow] = {}
        self._last_preset_value: str | None = None

        self._chain_sig: tuple[tuple[str, str], ...] | None = None
        self._chain_cards: dict[str, dict[str, Any]] = {}
        self._chain_keys: list[str] = []
        self._selected_block_path: str | None = None
        self._last_chain_signature: tuple[tuple[str, str], ...] | None = None

        self._targets: list[stomp.UploadTarget] = []
        self._target_signature: tuple[tuple[str, str, str], ...] | None = None
        self._selected_target: stomp.UploadTarget | None = None
        self._slot_names: list[str] = []
        self._slot_signature: tuple[str, tuple[str, ...]] | None = None
        self._selected_slot: int | None = None
        self._selected_file: str | None = None

        self._volume_timer = 0
        self._tempo_timer = 0
        self._volume_dirty = False
        self._tempo_dirty = False
        self._param_timers: dict[str, int] = {}

        self._css_provider = Gtk.CssProvider()
        self._reload_css([])

        self._build_ui()
        self.connect("close-request", self._on_close)

        self._refresh_serial_ports()
        self._start_mdns_scan()
        GLib.timeout_add(250, self._tick)
        GLib.timeout_add(700, self._try_initial_connect)

    # ------------------------------------------------------------------
    # CSS
    # ------------------------------------------------------------------

    def _reload_css(self, keys: Sequence[str]) -> None:
        css = BASE_CSS
        for key in keys:
            css += ".%s { color: %s; }\n" % (_css_class_for(key), _color_for(key))
        self._css_provider.load_from_data(css.encode("utf-8"))
        display = Gdk.Display.get_default()
        if display:
            Gtk.StyleContext.add_provider_for_display(
                display, self._css_provider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def _set_block_color_class(self, widget: Gtk.Widget, key: str) -> None:
        for cls in list(widget.get_css_classes()):
            if cls.startswith("block-"):
                widget.remove_css_class(cls)
        widget.add_css_class(_css_class_for(key))

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        header = Adw.HeaderBar()
        title = Gtk.Label(label="StompStation Pro")
        title.add_css_class("title")
        header.pack_start(title)

        nav = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.prev_btn = Gtk.Button.new_with_label("\u25c0")
        self.prev_btn.set_tooltip_text("Previous patch")
        self.prev_btn.connect("clicked", lambda *_: self._step_patch(-1))
        nav.append(self.prev_btn)
        self.patch_dd = Gtk.DropDown.new_from_strings([])
        self.patch_dd.set_size_request(240, -1)
        self.patch_dd.connect("notify::selected", self._on_patch_selected)
        nav.append(self.patch_dd)
        self.next_btn = Gtk.Button.new_with_label("\u25b6")
        self.next_btn.set_tooltip_text("Next patch")
        self.next_btn.connect("clicked", lambda *_: self._step_patch(1))
        nav.append(self.next_btn)
        self.patch_reload_btn = Gtk.Button.new_with_label("\u21bb")
        self.patch_reload_btn.set_tooltip_text("Reload state from device")
        self.patch_reload_btn.connect("clicked", lambda *_: self._refresh_all_async())
        nav.append(self.patch_reload_btn)
        self.patch_save_btn = Gtk.Button.new_with_label("Save")
        self.patch_save_btn.set_tooltip_text("Save the current settings into this patch")
        self.patch_save_btn.connect("clicked", lambda *_: self._save_patch())
        nav.append(self.patch_save_btn)
        header.set_title_widget(nav)

        self.header_status = Gtk.Label(label="Disconnected")
        self.header_status.add_css_class("status-idle")
        header.pack_end(self.header_status)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        outer.set_margin_top(10)
        outer.set_margin_bottom(10)
        outer.set_margin_start(10)
        outer.set_margin_end(10)

        # Signal chain spans the full width at the top.
        outer.append(self._build_chain_box())

        # The remaining three sections sit below the chain.
        columns = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        columns.set_vexpand(True)
        outer.append(columns)

        left = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        left.set_size_request(260, -1)
        columns.append(left)
        left.append(self._build_presets_box())

        middle = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        middle.set_hexpand(True)
        columns.append(middle)
        middle.append(self._build_details_box())

        right = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        right.set_size_request(320, -1)
        columns.append(right)
        right.append(self._build_master_box())
        right.append(self._build_files_log_box())

        # Device selector + connect/disconnect at the bottom, right-aligned.
        outer.append(self._build_connection_bar())

        toolbar_view = Adw.ToolbarView()
        toolbar_view.add_top_bar(header)
        toolbar_view.set_content(outer)
        self.set_content(toolbar_view)

        self._update_sensitivity()

    def _build_connection_bar(self) -> Gtk.Widget:
        bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)

        self.spinner = Gtk.Spinner()
        self.spinner.set_visible(False)
        bar.append(self.spinner)

        self.status_label = Gtk.Label(label="Ready", xalign=0)
        self.status_label.set_hexpand(True)
        self.status_label.set_ellipsize(Pango.EllipsizeMode.END)
        bar.append(self.status_label)

        bar.append(Gtk.Label(label="Device", xalign=0))
        self.mode_dd = Gtk.DropDown.new_from_strings(
            ["USB serial", "Network (mDNS)", "Manual TCP"])
        self.mode_dd.connect("notify::selected", self._on_mode_changed)
        bar.append(self.mode_dd)

        self.mode_stack = Gtk.Stack()
        self.mode_stack.set_transition_type(Gtk.StackTransitionType.NONE)
        bar.append(self.mode_stack)

        serial_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.port_dd = Gtk.DropDown.new_from_strings(["Scanning..."])
        self.port_dd.set_size_request(180, -1)
        serial_box.append(self.port_dd)
        refresh = Gtk.Button.new_with_label("Refresh")
        refresh.set_tooltip_text("Refresh serial ports")
        refresh.connect("clicked", lambda *_: self._refresh_serial_ports())
        serial_box.append(refresh)
        self.mode_stack.add_named(serial_box, "serial")

        mdns_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.mdns_dd = Gtk.DropDown.new_from_strings(["Scanning..."])
        self.mdns_dd.set_size_request(180, -1)
        mdns_box.append(self.mdns_dd)
        scan = Gtk.Button.new_with_label("Scan")
        scan.set_tooltip_text("Scan for network devices")
        scan.connect("clicked", lambda *_: self._start_mdns_scan())
        mdns_box.append(scan)
        self.mode_stack.add_named(mdns_box, "mdns")

        manual_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.tcp_entry = Gtk.Entry()
        self.tcp_entry.set_placeholder_text("host:port")
        self.tcp_entry.set_size_request(180, -1)
        manual_box.append(self.tcp_entry)
        self.mode_stack.add_named(manual_box, "manual")

        self.connect_btn = Gtk.Button.new_with_label("Connect")
        self.connect_btn.add_css_class("suggested-action")
        self.connect_btn.connect("clicked", lambda *_: self._on_connect_clicked())
        bar.append(self.connect_btn)

        return bar

    def _build_presets_box(self) -> Gtk.Widget:
        frame, box = self._section("Patches")
        frame.set_vexpand(True)
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_vexpand(True)
        self.presets_list = Gtk.ListBox()
        self.presets_list.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.presets_list.connect("row-activated", self._on_preset_activated)
        scrolled.set_child(self.presets_list)
        box.append(scrolled)
        return frame

    def _build_chain_box(self) -> Gtk.Widget:
        frame, box = self._section("Signal chain")
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
        scrolled.set_hexpand(True)
        self._chain_wrap = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                                   spacing=0)
        self._chain_wrap.set_halign(Gtk.Align.START)
        self._chain_wrap.set_valign(Gtk.Align.CENTER)
        self._chain_wrap.set_vexpand(True)
        self.chain_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.chain_box.set_valign(Gtk.Align.CENTER)
        self._chain_wrap.append(self.chain_box)
        scrolled.set_child(self._chain_wrap)
        box.append(scrolled)
        hint = Gtk.Label(
            label="Blocks are shown in chain order. Bypassed blocks are dimmed; "
                  "click a block to select and edit it.", xalign=0)
        hint.add_css_class("dim-label")
        hint.set_wrap(True)
        box.append(hint)
        return frame

    def _build_details_box(self) -> Gtk.Widget:
        frame, box = self._section("Selected block")
        frame.set_vexpand(True)

        self.details_name = Gtk.Label(label="No block selected", xalign=0)
        self.details_name.add_css_class("title")
        box.append(self.details_name)

        power_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        box.append(power_row)
        power_row.append(Gtk.Label(label="Enabled", xalign=0))
        self.details_switch = Gtk.Switch()
        self.details_switch.set_valign(Gtk.Align.CENTER)
        self.details_switch.set_sensitive(False)
        self.details_switch.connect("state-set", self._on_details_switch)
        power_row.append(self.details_switch)
        self.details_status = Gtk.Label(label="", xalign=1)
        self.details_status.set_hexpand(True)
        power_row.append(self.details_status)

        separator = Gtk.Separator()
        box.append(separator)

        params_scroll = Gtk.ScrolledWindow()
        params_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        params_scroll.set_vexpand(True)
        self.params_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        params_scroll.set_child(self.params_box)
        box.append(params_scroll)

        self._details_block_path: str | None = None
        self._show_details_hint()
        return frame

    def _build_master_box(self) -> Gtk.Widget:
        frame, box = self._section("Master")
        vol_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(vol_row)
        vol_row.append(Gtk.Label(label="Volume", xalign=0))
        self.volume_scale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, 0.0, 100.0, 1.0)
        self.volume_scale.set_hexpand(True)
        self.volume_scale.set_draw_value(False)
        self.volume_scale.connect("value-changed", self._on_volume_changed)
        vol_row.append(self.volume_scale)
        self.volume_value_label = Gtk.Label(label="--")
        self.volume_value_label.add_css_class("value-label")
        self.volume_value_label.set_size_request(48, -1)
        vol_row.append(self.volume_value_label)

        tempo_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(tempo_row)
        tempo_row.append(Gtk.Label(label="Tempo", xalign=0))
        self.tempo_spin = Gtk.SpinButton.new_with_range(20.0, 300.0, 1.0)
        self.tempo_spin.set_hexpand(True)
        self.tempo_spin.connect("value-changed", self._on_tempo_changed)
        tempo_row.append(self.tempo_spin)
        tempo_row.append(Gtk.Label(label="BPM", xalign=0))
        return frame

    def _build_files_log_box(self) -> Gtk.Widget:
        notebook = Gtk.Notebook()
        notebook.set_vexpand(True)
        notebook.append_page(self._build_upload_page(), Gtk.Label(label="Files"))
        notebook.append_page(self._build_log_page(), Gtk.Label(label="Activity"))
        return notebook

    def _build_upload_page(self) -> Gtk.Widget:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        box.set_margin_top(10)
        box.set_margin_bottom(10)
        box.set_margin_start(10)
        box.set_margin_end(10)

        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(row)
        row.append(Gtk.Label(label="Target", xalign=0))
        self.target_dd = Gtk.DropDown.new_from_strings(["Waiting for device..."])
        self.target_dd.set_hexpand(True)
        self.target_dd.connect("notify::selected", self._on_target_changed)
        row.append(self.target_dd)

        row2 = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(row2)
        row2.append(Gtk.Label(label="Slot", xalign=0))
        self.slot_dd = Gtk.DropDown.new_from_strings(["--"])
        self.slot_dd.set_hexpand(True)
        self.slot_dd.connect("notify::selected", self._on_slot_changed)
        row2.append(self.slot_dd)

        row3 = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(row3)
        self.file_btn = Gtk.Button.new_with_label("Choose file...")
        self.file_btn.connect("clicked", lambda *_: self._choose_file())
        row3.append(self.file_btn)
        self.file_label = Gtk.Label(label="No file selected", xalign=0)
        self.file_label.set_hexpand(True)
        self.file_label.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        row3.append(self.file_label)

        self.upload_btn = Gtk.Button.new_with_label("Upload")
        self.upload_btn.add_css_class("suggested-action")
        self.upload_btn.connect("clicked", lambda *_: self._on_upload_clicked())
        box.append(self.upload_btn)

        self.progress = Gtk.ProgressBar()
        self.progress.set_show_text(True)
        self.progress.set_text("Idle")
        box.append(self.progress)
        return box

    def _build_log_page(self) -> Gtk.Widget:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        box.set_margin_top(10)
        box.set_margin_bottom(10)
        box.set_margin_start(10)
        box.set_margin_end(10)

        toolbar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(toolbar)
        spacer = Gtk.Box()
        spacer.set_hexpand(True)
        toolbar.append(spacer)
        clear_btn = Gtk.Button.new_with_label("Clear")
        clear_btn.connect("clicked", lambda *_: self._clear_log())
        toolbar.append(clear_btn)

        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_vexpand(True)
        self.log_view = Gtk.TextView()
        self.log_view.set_editable(False)
        self.log_view.set_cursor_visible(False)
        self.log_view.set_monospace(True)
        self.log_view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        scrolled.set_child(self.log_view)
        box.append(scrolled)
        return box

    @staticmethod
    def _section(title: str) -> tuple[Gtk.Frame, Gtk.Box]:
        frame = Gtk.Frame(label=title)
        frame_label = frame.get_label_widget()
        if frame_label is not None:
            frame_label.add_css_class("section-title")
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        box.set_margin_top(8)
        box.set_margin_bottom(8)
        box.set_margin_start(8)
        box.set_margin_end(8)
        frame.set_child(box)
        return frame, box

    # ------------------------------------------------------------------
    # Logging / status
    # ------------------------------------------------------------------

    def _log_threadsafe(self, message: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self._log_queue.put("%s  %s" % (stamp, message))

    def _log(self, message: str) -> None:
        self._log_threadsafe(message)

    def _drain_logs(self) -> None:
        lines: list[str] = []
        while True:
            try:
                lines.append(self._log_queue.get_nowait())
            except queue.Empty:
                break
        if not lines:
            return
        buffer = self.log_view.get_buffer()
        buffer.insert(buffer.get_end_iter(), "\n".join(lines) + "\n")
        if buffer.get_line_count() > 2500:
            start = buffer.get_start_iter()
            cut = buffer.get_iter_at_line(buffer.get_line_count() - 2000)
            buffer.delete(start, cut)
        end = buffer.get_end_iter()
        buffer.place_cursor(end)
        self.log_view.scroll_to_iter(end, 0.0, False, 0.0, 0.0)

    def _clear_log(self) -> None:
        self.log_view.get_buffer().set_text("")

    def _set_status(self, text: str, error: bool = False) -> None:
        self.status_label.set_text(text)
        for cls in ("status-ok", "status-error", "status-idle"):
            self.status_label.remove_css_class(cls)
        self.status_label.add_css_class("status-error" if error else "status-ok")

    def _set_header_status(self, text: str, connected: bool) -> None:
        self.header_status.set_text(text)
        for cls in ("status-ok", "status-error", "status-idle"):
            self.header_status.remove_css_class(cls)
        self.header_status.add_css_class("status-ok" if connected else "status-idle")

    def _set_busy(self, busy: bool, text: str | None = None) -> None:
        self._busy = busy
        if busy:
            self.spinner.set_visible(True)
            self.spinner.start()
            if text:
                self._set_status(text)
        else:
            self.spinner.stop()
            self.spinner.set_visible(False)
            if text:
                self._set_status(text)
        self._update_sensitivity()

    def _update_sensitivity(self) -> None:
        connected = self.device is not None and self.device.connected
        idle = not self._busy and not self._uploading

        if connected:
            self.connect_btn.set_label("Disconnect")
        else:
            self.connect_btn.set_label("Connect")
        self.connect_btn.set_sensitive(idle)
        self.mode_dd.set_sensitive(not connected and idle)
        self.port_dd.set_sensitive(not connected and idle)
        self.mdns_dd.set_sensitive(not connected and idle)
        self.tcp_entry.set_sensitive(not connected and idle)

        for widget in (self.prev_btn, self.next_btn, self.patch_dd,
                       self.patch_reload_btn, self.patch_save_btn,
                       self.presets_list):
            widget.set_sensitive(connected and idle)
        self.chain_box.set_sensitive(connected and idle)
        self.volume_scale.set_sensitive(connected and idle)
        self.tempo_spin.set_sensitive(connected and idle)
        self.target_dd.set_sensitive(connected and idle)
        self.slot_dd.set_sensitive(connected and idle)
        self.file_btn.set_sensitive(connected and idle)
        can_upload = (connected and idle and self._selected_file is not None and
                      self._selected_target is not None and
                      self._selected_slot is not None)
        self.upload_btn.set_sensitive(can_upload)

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def _on_mode_changed(self, dropdown: Gtk.DropDown, _pspec) -> None:
        idx = dropdown.get_selected()
        self.mode_stack.set_visible_child_name(
            {0: "serial", 1: "mdns", 2: "manual"}.get(idx, "serial"))
        if idx == 1 and not self._discovered:
            self._start_mdns_scan()

    def _refresh_serial_ports(self) -> None:
        def worker() -> None:
            ports = stomp.list_serial_ports()
            self._post(self._update_serial_ports, ports)
        threading.Thread(target=worker, daemon=True).start()

    def _update_serial_ports(self, ports: list[tuple[str, str]]) -> None:
        self._serial_ports = ports
        labels = (["No serial ports found"] if not ports else
                  ["%s  -  %s" % (dev, desc) if desc else dev for dev, desc in ports])
        self.port_dd.set_model(Gtk.StringList.new(labels))
        if ports:
            usb = [i for i, (dev, _d) in enumerate(ports)
                   if stomp.is_usb_serial_device(dev)]
            self.port_dd.set_selected(usb[0] if usb else 0)
            if not usb:
                self._log("no USB CDC-ACM port found; the listed ports are "
                          "usually not the pedal")
        diagnostic = stomp.usb_diagnostic_message()
        if diagnostic:
            self._log(diagnostic)

    def _start_mdns_scan(self) -> None:
        if self._scanning:
            return
        self._scanning = True
        self.mdns_dd.set_model(Gtk.StringList.new(["Scanning..."]))
        self._log("scanning mDNS for _http._tcp devices...")

        def worker() -> None:
            try:
                devices = stomp.discover_mdns(timeout=2.5)
            except Exception as exc:
                devices = []
                self._log_threadsafe("mDNS scan failed: %s" % exc)
            self._post(self._update_discovered, devices)

        threading.Thread(target=worker, daemon=True).start()

    def _update_discovered(self, devices: list[stomp.DiscoveredDevice]) -> None:
        self._scanning = False
        valid = [d for d in devices if d.valid]
        visible = valid or devices
        self._discovered = visible
        if not visible:
            self.mdns_dd.set_model(Gtk.StringList.new(["No devices found"]))
            self._log("mDNS scan complete: no _http._tcp devices found")
            return
        self.mdns_dd.set_model(Gtk.StringList.new([d.description for d in visible]))
        self.mdns_dd.set_selected(0)
        self._log("mDNS scan complete: %d device(s)" % len(visible))

    def _on_connect_clicked(self) -> None:
        if self.device is not None and self.device.connected:
            self._disconnect("Disconnected")
            return
        if self._busy:
            return
        mode = self.mode_dd.get_selected()
        try:
            if mode == 0:
                idx = self.port_dd.get_selected()
                if idx == Gtk.INVALID_LIST_POSITION or idx >= len(self._serial_ports):
                    raise ValueError("no USB serial port selected")
                transport: stomp.Transport = stomp.SerialTransport(
                    self._serial_ports[idx][0])
            elif mode == 1:
                idx = self.mdns_dd.get_selected()
                if idx == Gtk.INVALID_LIST_POSITION or idx >= len(self._discovered):
                    raise ValueError("no discovered device selected")
                d = self._discovered[idx]
                transport = stomp.TCPTransport(d.host, d.port)
            else:
                host, port = stomp.parse_host_port(self.tcp_entry.get_text())
                transport = stomp.TCPTransport(host, port)
        except Exception as exc:
            self._log("connection error: %s" % exc)
            self._set_status(str(exc), error=True)
            return
        self._connect_transport(transport)

    def _connect_transport(self, transport: stomp.Transport) -> None:
        self._set_busy(True, "Connecting to %s..." % transport.description)

        def worker() -> None:
            device = stomp.Device(transport, log=self._log_threadsafe)
            try:
                device.connect()
                device.start_polling()
            except Exception as exc:
                try:
                    device.close()
                except Exception:
                    pass
                self._post(self._on_connect_failed, str(exc))
                return
            self._post(self._on_connected, device)

        threading.Thread(target=worker, daemon=True).start()

    def _on_connected(self, device: stomp.Device) -> None:
        self.device = device
        self._set_busy(False, "Connected")
        self._log("connected via %s" % device.transport.description)
        self._set_header_status("Connected", True)
        self._first_state(device)

    def _on_connect_failed(self, error: str) -> None:
        self._set_busy(False, "Connection failed")
        self._set_header_status("Disconnected", False)
        self._log("connection failed: %s" % error)
        self._set_status(error, error=True)
        self._update_sensitivity()

    def _disconnect(self, message: str) -> None:
        device, self.device = self.device, None
        self._set_busy(True, message)
        self._set_header_status("Disconnected", False)

        def worker() -> None:
            if device is not None:
                try:
                    device.close()
                except Exception:
                    pass
            self._post(self._after_disconnected)

        threading.Thread(target=worker, daemon=True).start()

    def _after_disconnected(self) -> None:
        self._set_busy(False, "Disconnected")
        self._state = None
        self._patch_names = []
        self._preset_rows.clear()
        self._clear_presets()
        self._clear_chain()
        self._selected_block_path = None
        self._last_preset_value = None
        self._last_chain_signature = None
        self._details_block_path = None
        self._show_details_hint()
        self._targets = []
        self._target_signature = None
        self._selected_target = None
        self._slot_names = []
        self._slot_signature = None
        self.progress.set_fraction(0.0)
        self.progress.set_text("Idle")
        self._log("disconnected")
        self._update_sensitivity()

    def _on_connection_lost(self) -> None:
        self._log("device connection was lost")
        self._set_status("Connection lost", error=True)
        self._disconnect("Connection lost")

    def _first_state(self, device: stomp.Device) -> None:
        try:
            self._render_state(device.state())
        except Exception as exc:
            self._log("could not read initial state: %s" % exc)
        self._refresh_all_async()

    def _refresh_all_async(self) -> None:
        device = self.device
        if device is None or self._refresh_running:
            return
        self._refresh_running = True
        self._set_status("Refreshing from device...")

        def worker() -> None:
            try:
                device.refresh_full_state()
                self._post(self._refresh_done, None)
            except Exception as exc:
                self._post(self._refresh_done, str(exc))

        threading.Thread(target=worker, daemon=True).start()

    def _refresh_done(self, error: str | None) -> None:
        self._refresh_running = False
        if error:
            self._log("refresh failed: %s" % error)
            self._set_status(error, error=True)
        else:
            self._set_status("Up to date")
            device = self.device
            if device is not None and device.connected:
                try:
                    state = device.state()
                except Exception:
                    state = None
                if state is not None:
                    self._last_preset_value = state.preset.current
                    self._last_chain_signature = self._chain_signature(state.blocks)
                    self._render_state(state)
        self._update_sensitivity()

    # ------------------------------------------------------------------
    # Periodic update
    # ------------------------------------------------------------------

    def _tick(self) -> bool:
        if not self._alive:
            return False
        self._drain_logs()
        device = self.device
        if device is None:
            return True
        if not device.connected:
            self._on_connection_lost()
            return True
        try:
            state = device.state()
        except Exception:
            return True
        self._render_state(state)
        return True

    @staticmethod
    def _chain_signature(blocks: list[stomp.BlockState]) -> tuple[tuple[str, str], ...]:
        return tuple((block.path, block.label) for block in blocks)

    def _render_state(self, state: stomp.DeviceState) -> None:
        self._state = state

        self._render_presets(state.preset)
        self._render_chain(state.blocks)
        self._render_master(state.volume, state.tempo)
        self._render_targets(state)
        self._update_details_switch(state)
        self._update_sensitivity()

        chain_signature = self._chain_signature(state.blocks)
        chain_changed = (self._last_chain_signature is not None and
                         chain_signature != self._last_chain_signature)
        preset_changed = (self._last_preset_value is not None and
                          state.preset.current != self._last_preset_value)

        if (preset_changed or chain_changed) and not self._busy and \
                not self._refresh_running:
            if preset_changed:
                self._log("preset changed externally to %r; refreshing" %
                          state.preset.current)
            else:
                self._log("signal chain changed externally; refreshing")
            GLib.idle_add(self._refresh_all_async)

        self._last_preset_value = state.preset.current
        self._last_chain_signature = chain_signature

    # ------------------------------------------------------------------
    # Presets
    # ------------------------------------------------------------------

    def _render_presets(self, preset: stomp.PresetState) -> None:
        names = [name for name in preset.names if name]
        if tuple(names) != tuple(self._patch_names):
            self._patch_names = names
            self._patch_dd_model(names)
            self._rebuild_presets(names)

        current = preset.current
        index = names.index(current) if current and current in names else \
            Gtk.INVALID_LIST_POSITION

        # Keep the header dropdown in sync with the current patch.
        self._syncing = True
        try:
            if self.patch_dd.get_selected() != index:
                if index == Gtk.INVALID_LIST_POSITION:
                    self.patch_dd.set_selected(Gtk.INVALID_LIST_POSITION)
                else:
                    self.patch_dd.set_selected(index)
        finally:
            self._syncing = False

        # Keep the patch list selection in sync too.
        if index != Gtk.INVALID_LIST_POSITION:
            row = self.presets_list.get_row_at_index(index)
            if row is not None:
                self._syncing = True
                try:
                    self.presets_list.select_row(row)
                finally:
                    self._syncing = False

    def _patch_dd_model(self, names: list[str]) -> None:
        self._syncing = True
        try:
            self.patch_dd.set_model(Gtk.StringList.new(names))
        finally:
            self._syncing = False

    def _rebuild_presets(self, names: list[str]) -> None:
        self._clear_presets()
        for name in names:
            row = Gtk.ListBoxRow()
            row.name = name
            label = Gtk.Label(label=name, xalign=0)
            label.set_margin_top(6)
            label.set_margin_bottom(6)
            label.set_margin_start(8)
            label.set_margin_end(8)
            label.set_ellipsize(Pango.EllipsizeMode.END)
            row.set_child(label)
            self.presets_list.append(row)
            self._preset_rows[name] = row

    def _clear_presets(self) -> None:
        child = self.presets_list.get_first_child()
        while child is not None:
            next_child = child.get_next_sibling()
            self.presets_list.remove(child)
            child = next_child
        self._preset_rows.clear()

    def _on_preset_activated(self, _listbox: Gtk.ListBox, row: Gtk.ListBoxRow) -> None:
        if self._syncing or self.device is None:
            return
        name = getattr(row, "name", None)
        if not name:
            return
        current = self._state.preset.current if self._state else ""
        if name != current:
            self._load_patch(name)

    def _on_patch_selected(self, dropdown: Gtk.DropDown, _pspec) -> None:
        if self._syncing or self.device is None:
            return
        idx = dropdown.get_selected()
        if idx == Gtk.INVALID_LIST_POSITION or idx >= len(self._patch_names):
            return
        name = self._patch_names[idx]
        current = self._state.preset.current if self._state else ""
        if name != current:
            self._load_patch(name)

    def _step_patch(self, direction: int) -> None:
        if not self._patch_names or self.device is None:
            return
        current = self._state.preset.current if self._state else ""
        try:
            idx = self._patch_names.index(current)
        except ValueError:
            idx = 0 if direction > 0 else len(self._patch_names) - 1
        idx = (idx + direction) % len(self._patch_names)
        self._load_patch(self._patch_names[idx])

    def _load_patch(self, name: str) -> None:
        device = self.device
        if device is None:
            return
        self._set_busy(True, "Loading patch %r..." % name)

        def worker() -> None:
            try:
                device.set_preset(name)
                time.sleep(0.25)
                device.refresh_full_state()
                self._post(self._patch_loaded, name, None)
            except Exception as exc:
                self._post(self._patch_loaded, name, str(exc))

        threading.Thread(target=worker, daemon=True).start()

    def _patch_loaded(self, name: str, error: str | None) -> None:
        self._set_busy(False, "Patch loaded" if not error else "Patch change failed")
        if error:
            self._log("patch change to %r failed: %s" % (name, error))
            self._set_status(error, error=True)
        else:
            self._log("loaded patch %r" % name)
            self._set_status("Loaded %r" % name)
        self._update_sensitivity()

    def _save_patch(self) -> None:
        device = self.device
        if device is None:
            return
        self._set_status("Saving patch...")

        def worker() -> None:
            try:
                device.save_preset()
                self._post(self._save_done, None)
            except Exception as exc:
                self._post(self._save_done, str(exc))

        threading.Thread(target=worker, daemon=True).start()

    def _save_done(self, error: str | None) -> None:
        if error:
            self._log("save failed: %s" % error)
            self._set_status(error, error=True)
        else:
            self._set_status("Patch saved")

    # ------------------------------------------------------------------
    # Signal chain
    # ------------------------------------------------------------------

    def _make_chain_card(self, block: stomp.BlockState) -> dict[str, Any]:
        key = _key_for_path(block.path)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
        box.set_size_request(78, 48)

        abbr = Gtk.Label(label=_short_for(key, block.label), xalign=0.5)
        abbr.add_css_class("block-abbr")
        box.append(abbr)

        name = Gtk.Label(label=block.label, xalign=0.5)
        name.add_css_class("block-name")
        name.set_ellipsize(Pango.EllipsizeMode.END)
        name.set_max_width_chars(10)
        box.append(name)

        status = Gtk.Label(label="?", xalign=0.5)
        status.add_css_class("block-status")
        box.append(status)
        return {"box": box, "status": status, "name": name}

    def _clear_chain(self) -> None:
        child = self.chain_box.get_first_child()
        while child is not None:
            next_child = child.get_next_sibling()
            self.chain_box.remove(child)
            child = next_child
        self._chain_cards.clear()
        self._chain_keys = []
        self._chain_sig = None

    def _rebuild_chain(self, blocks: list[stomp.BlockState]) -> None:
        self._clear_chain()
        self._chain_sig = self._chain_signature(blocks)
        for block in blocks:
            key = _key_for_path(block.path)
            self._chain_keys.append(key)
            card = self._make_chain_card(block)
            btn = Gtk.ToggleButton()
            btn.add_css_class("chain-block")
            btn.add_css_class(_css_class_for(key))
            btn.set_valign(Gtk.Align.CENTER)
            btn.set_child(card["box"])
            btn.connect("toggled", self._on_chain_toggled, block.path)
            self.chain_box.append(btn)
            self._chain_cards[block.path] = {"btn": btn, **card}
        self._reload_css(self._chain_keys)

    def _render_chain(self, blocks: list[stomp.BlockState]) -> None:
        signature = self._chain_signature(blocks)
        if signature != self._chain_sig:
            self._rebuild_chain(blocks)

        if self._selected_block_path and not any(
                b.path == self._selected_block_path for b in blocks):
            self._selected_block_path = None
            self._render_details()

        for block in blocks:
            card = self._chain_cards.get(block.path)
            if card is None:
                continue
            card["status"].set_text(
                "ON" if block.on else ("OFF" if block.on is False else "?"))
            if block.on is False:
                card["btn"].add_css_class("bypassed")
            else:
                card["btn"].remove_css_class("bypassed")
            self._syncing = True
            try:
                card["btn"].set_active(block.path == self._selected_block_path)
            finally:
                self._syncing = False

    def _on_chain_toggled(self, btn: Gtk.ToggleButton, path: str) -> None:
        if self._syncing:
            return
        if btn.get_active():
            if self._selected_block_path != path:
                self._selected_block_path = path
                self._syncing = True
                try:
                    for other, card in self._chain_cards.items():
                        if other != path:
                            card["btn"].set_active(False)
                finally:
                    self._syncing = False
                self._render_details()
        elif self._selected_block_path == path:
            self._selected_block_path = None
            self._render_details()

    # ------------------------------------------------------------------
    # Selected-block editor
    # ------------------------------------------------------------------

    def _show_details_hint(self) -> None:
        self.details_name.set_text("No block selected")
        self.details_name.remove_css_class("title")
        self.details_name.add_css_class("dim-label")
        self.details_status.set_text("")
        self.details_switch.set_sensitive(False)
        self._clear_params()

    def _clear_params(self) -> list[Gtk.Widget]:
        children: list[Gtk.Widget] = []
        child = self.params_box.get_first_child()
        while child is not None:
            next_child = child.get_next_sibling()
            self.params_box.remove(child)
            children.append(child)
            child = next_child
        self._param_timers.clear()
        return children

    def _render_details(self) -> None:
        self._clear_params()
        path = self._selected_block_path
        if not path or self.device is None or self._state is None:
            self._show_details_hint()
            return

        block = next((b for b in self._state.blocks if b.path == path), None)
        key = _key_for_path(path)
        self.details_name.set_text(block.label if block else key)
        self.details_name.remove_css_class("dim-label")
        self.details_name.add_css_class("title")
        self._set_block_color_class(self.details_name, key)
        self.details_switch.set_sensitive(block is not None and block.on is not None)
        self._syncing = True
        try:
            self.details_switch.set_active(bool(block.on if block else False))
        finally:
            self._syncing = False
        self.details_status.set_text(
            "ON" if (block and block.on) else
            ("OFF" if (block and block.on is False) else "?"))
        self._details_block_path = path

        if block is None:
            return
        try:
            params = self.device.get_block_parameters(path)
        except Exception:
            params = []
        if not params:
            hint = Gtk.Label(label="No editable parameters for this block", xalign=0)
            hint.add_css_class("dim-label")
            self.params_box.append(hint)
            return
        for param in params:
            self.params_box.append(self._make_param_row(param))

    def _update_details_switch(self, state: stomp.DeviceState) -> None:
        path = self._details_block_path
        if path is None:
            return
        block = next((b for b in state.blocks if b.path == path), None)
        if block is None:
            return
        self.details_status.set_text(
            "ON" if block.on else ("OFF" if block.on is False else "?"))
        self._syncing = True
        try:
            self.details_switch.set_active(bool(block.on))
        finally:
            self._syncing = False

    def _on_details_switch(self, switch: Gtk.Switch, state: bool) -> bool:
        if self._syncing or self.device is None or self._busy:
            return True
        path = self._details_block_path
        if path is None:
            return True
        self._log("block -> %s" % ("ON" if state else "OFF"))

        def worker() -> None:
            try:
                self.device.set_block(path, state)
            except Exception as exc:
                self._post(self._log_threadsafe,
                           "block toggle failed: %s" % exc)

        threading.Thread(target=worker, daemon=True).start()
        return False

    # ------------------------------------------------------------------
    # Parameter editor
    # ------------------------------------------------------------------

    def _make_param_row(self, param: dict[str, Any]) -> Gtk.Widget:
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        label_text = param.get("desc") or param["name"].replace("_", " ").title()
        name = Gtk.Label(label=label_text, xalign=0)
        name.set_size_request(96, -1)
        name.set_ellipsize(Pango.EllipsizeMode.END)
        row.append(name)

        kind = param.get("kind")
        value = param.get("value")
        path = param["path"]

        if kind == "float" and isinstance(param.get("min"), (int, float)) and \
                isinstance(param.get("max"), (int, float)):
            scale = Gtk.Scale.new_with_range(
                Gtk.Orientation.HORIZONTAL, float(param["min"]),
                float(param["max"]), 0.01)
            scale.set_hexpand(True)
            scale.set_draw_value(False)
            self._syncing = True
            try:
                scale.set_value(float(value))
            finally:
                self._syncing = False
            value_label = Gtk.Label(label=self._fmt_param_value(value))
            value_label.add_css_class("value-label")
            value_label.set_size_request(52, -1)
            scale.connect("value-changed", self._on_param_scale_changed,
                          path, value_label)
            row.append(scale)
            row.append(value_label)
            return row

        if kind in ("enum", "choice"):
            options = param.get("options") or []
            dd = Gtk.DropDown.new_from_strings([str(o) for o in options])
            dd.set_hexpand(True)
            if value in options:
                self._syncing = True
                try:
                    dd.set_selected(options.index(value))
                finally:
                    self._syncing = False
            dd.connect("notify::selected", self._on_param_enum_changed, path, options)
            row.append(dd)
            return row

        if kind == "number":
            spin = Gtk.SpinButton.new_with_range(-1e9, 1e9, 0.01)
            spin.set_hexpand(True)
            self._syncing = True
            try:
                spin.set_value(float(value))
            finally:
                self._syncing = False
            spin.connect("value-changed", self._on_param_spin_changed, path)
            row.append(spin)
            return row

        if kind == "bool":
            switch = Gtk.Switch()
            switch.set_hexpand(False)
            switch.set_valign(Gtk.Align.CENTER)
            self._syncing = True
            try:
                switch.set_active(bool(value))
            finally:
                self._syncing = False
            switch.connect("state-set", self._on_param_bool, path)
            row.append(switch)
            return row

        entry = Gtk.Entry()
        entry.set_hexpand(True)
        entry.set_text("" if value is None else str(value))
        entry.connect("activate", self._on_param_entry_activate, path, entry)
        row.append(entry)
        return row

    @staticmethod
    def _fmt_param_value(value: Any) -> str:
        try:
            return ("%.2f" % float(value)).rstrip("0").rstrip(".")
        except (TypeError, ValueError):
            return str(value)

    def _on_param_scale_changed(self, scale: Gtk.Scale, path: str,
                                label: Gtk.Label) -> None:
        label.set_text(self._fmt_param_value(scale.get_value()))
        if self._syncing or self.device is None:
            return
        self._schedule_param(path, round(float(scale.get_value()), 6))

    def _on_param_spin_changed(self, spin: Gtk.SpinButton, path: str) -> None:
        if self._syncing or self.device is None:
            return
        self._schedule_param(path, round(float(spin.get_value()), 6))

    def _on_param_enum_changed(self, dropdown: Gtk.DropDown, _pspec, path: str,
                               options: list[str]) -> None:
        if self._syncing or self.device is None:
            return
        idx = dropdown.get_selected()
        if idx == Gtk.INVALID_LIST_POSITION or idx >= len(options):
            return
        self._write_param(path, options[idx])

    def _on_param_bool(self, switch: Gtk.Switch, state: bool, path: str) -> bool:
        if self._syncing or self.device is None:
            return True
        self._write_param(path, state)
        return False

    def _on_param_entry_activate(self, entry: Gtk.Entry, path: str,
                                 _entry: Gtk.Entry) -> None:
        if self.device is None:
            return
        self._write_param(path, entry.get_text())

    def _schedule_param(self, path: str, value: Any) -> None:
        if path in self._param_timers:
            GLib.source_remove(self._param_timers[path])
        self._param_timers[path] = GLib.timeout_add(350, self._apply_param, path, value)

    def _apply_param(self, path: str, value: Any) -> bool:
        self._param_timers.pop(path, None)
        self._write_param(path, value)
        return False

    def _write_param(self, path: str, value: Any) -> None:
        device = self.device
        if device is None:
            return

        def worker() -> None:
            try:
                device.write(path, value)
            except Exception as exc:
                self._post(self._log_threadsafe,
                           "parameter write failed: %s" % exc)

        threading.Thread(target=worker, daemon=True).start()

    # ------------------------------------------------------------------
    # Master controls
    # ------------------------------------------------------------------

    def _render_master(self, volume: stomp.ControlState | None,
                       tempo: stomp.ControlState | None) -> None:
        if volume is not None:
            self.volume_value_label.set_text("%.1f" % volume.value)
            self.volume_scale.set_range(volume.min, volume.max)
            if not self._volume_dirty and not self.volume_scale.has_focus():
                self._syncing = True
                try:
                    self.volume_scale.set_value(volume.value)
                finally:
                    self._syncing = False
        else:
            self.volume_value_label.set_text("--")

        if tempo is not None:
            self.tempo_spin.set_range(tempo.min, tempo.max)
            if not self._tempo_dirty and not self.tempo_spin.has_focus():
                self._syncing = True
                try:
                    self.tempo_spin.set_value(tempo.value)
                finally:
                    self._syncing = False
        else:
            self.tempo_spin.set_value(120.0)

        self._master_volume = volume
        self._master_tempo = tempo

    def _on_volume_changed(self, scale: Gtk.Scale) -> None:
        self.volume_value_label.set_text("%.1f" % scale.get_value())
        if self._syncing or self.device is None:
            return
        self._volume_dirty = True
        if self._volume_timer:
            GLib.source_remove(self._volume_timer)
        self._volume_timer = GLib.timeout_add(350, self._apply_volume)

    def _apply_volume(self) -> bool:
        self._volume_timer = 0
        device = self.device
        volume = getattr(self, "_master_volume", None)
        if device is None or volume is None:
            self._volume_dirty = False
            return False
        if self._busy:
            self._volume_timer = GLib.timeout_add(250, self._apply_volume)
            return False
        value = round(float(self.volume_scale.get_value()), 6)
        self._log("master volume -> %.1f" % value)

        def worker() -> None:
            try:
                device.write(volume.path, value)
                self._post(self._volume_written, value)
            except Exception as exc:
                self._post(self._control_error, "volume", str(exc))

        threading.Thread(target=worker, daemon=True).start()
        return False

    def _volume_written(self, value: float) -> None:
        self._volume_dirty = False
        self.volume_value_label.set_text("%.1f" % value)

    def _on_tempo_changed(self, spin: Gtk.SpinButton) -> None:
        if self._syncing or self.device is None:
            return
        self._tempo_dirty = True
        if self._tempo_timer:
            GLib.source_remove(self._tempo_timer)
        self._tempo_timer = GLib.timeout_add(400, self._apply_tempo)

    def _apply_tempo(self) -> bool:
        self._tempo_timer = 0
        device = self.device
        tempo = getattr(self, "_master_tempo", None)
        if device is None or tempo is None:
            self._tempo_dirty = False
            return False
        if self._busy:
            self._tempo_timer = GLib.timeout_add(250, self._apply_tempo)
            return False
        value = round(float(self.tempo_spin.get_value()), 6)
        self._log("tempo -> %.1f BPM" % value)

        def worker() -> None:
            try:
                device.write(tempo.path, value)
                self._post(self._tempo_written)
            except Exception as exc:
                self._post(self._control_error, "tempo", str(exc))

        threading.Thread(target=worker, daemon=True).start()
        return False

    def _tempo_written(self) -> None:
        self._tempo_dirty = False

    def _control_error(self, name: str, error: str) -> None:
        if name == "volume":
            self._volume_dirty = False
        else:
            self._tempo_dirty = False
        self._log("%s change failed: %s" % (name, error))
        self._set_status(error, error=True)
        self._refresh_all_async()

    # ------------------------------------------------------------------
    # Uploads
    # ------------------------------------------------------------------

    def _render_targets(self, state: stomp.DeviceState) -> None:
        device = self.device
        if device is None:
            return
        targets = device.get_upload_targets()
        signature = tuple((t.path, t.label, t.kind) for t in targets)
        if signature != self._target_signature:
            old_path = self._selected_target.path if self._selected_target else None
            self._target_signature = signature
            self._targets = targets
            self._syncing = True
            try:
                self.target_dd.set_model(
                    Gtk.StringList.new([t.label for t in targets]))
                selected = 0
                if old_path:
                    for i, target in enumerate(targets):
                        if target.path == old_path:
                            selected = i
                            break
                self.target_dd.set_selected(selected if targets else Gtk.INVALID_LIST_POSITION)
            finally:
                self._syncing = False
            self._selected_target = targets[0] if targets else None
            self._slot_signature = None
            self._refresh_slot_model(state)
        else:
            self._refresh_slot_model(state)

    def _on_target_changed(self, dropdown: Gtk.DropDown, _pspec) -> None:
        if self._syncing:
            return
        idx = dropdown.get_selected()
        if idx == Gtk.INVALID_LIST_POSITION or idx >= len(self._targets):
            self._selected_target = None
            return
        old_kind = self._selected_target.kind if self._selected_target else None
        self._selected_target = self._targets[idx]
        if old_kind is not None and old_kind != self._selected_target.kind:
            self._selected_file = None
            self.file_label.set_text("No file selected")
        self._slot_signature = None
        self._selected_slot = None
        if self._state is not None:
            self._refresh_slot_model(self._state)
        self._update_sensitivity()

    def _refresh_slot_model(self, state: stomp.DeviceState) -> None:
        target = self._selected_target
        if target is None:
            return
        names = state.lists.get(target.path, [])
        signature = (target.path, tuple(names))
        if signature == self._slot_signature:
            return

        previous = self._selected_slot
        self._slot_signature = signature
        self._slot_names = list(names)

        if not names:
            self._syncing = True
            try:
                self.slot_dd.set_model(Gtk.StringList.new(["(slots not loaded)"]))
                self.slot_dd.set_selected(0)
            finally:
                self._syncing = False
            self._selected_slot = None
            return

        labels = ["%d: %s" % (i, name if name else "(empty)")
                  for i, name in enumerate(names)]
        self._syncing = True
        try:
            self.slot_dd.set_model(Gtk.StringList.new(labels))
            if previous is not None and previous < len(names):
                selected = previous
            else:
                free = [i for i, name in enumerate(names) if not name]
                selected = free[0] if free else 0
            self.slot_dd.set_selected(selected)
            self._selected_slot = selected
        finally:
            self._syncing = False
        self._update_sensitivity()

    def _on_slot_changed(self, dropdown: Gtk.DropDown, _pspec) -> None:
        if self._syncing:
            return
        idx = dropdown.get_selected()
        if idx == Gtk.INVALID_LIST_POSITION or idx >= len(self._slot_names):
            self._selected_slot = None
        else:
            self._selected_slot = idx
        self._update_sensitivity()

    def _choose_file(self) -> None:
        target = self._selected_target
        if target is None:
            return
        dialog = Gtk.FileDialog()
        dialog.set_title("Choose a NAM model" if target.kind == "nam"
                         else "Choose an IR WAV file")
        file_filter = Gtk.FileFilter()
        if target.kind == "nam":
            file_filter.set_name("NAM models")
            file_filter.add_pattern("*.nam")
            file_filter.add_pattern("*.NAM")
        else:
            file_filter.set_name("WAV files")
            file_filter.add_pattern("*.wav")
            file_filter.add_pattern("*.WAV")
        filters = Gio.ListStore.new(Gtk.FileFilter)
        filters.append(file_filter)
        dialog.set_filters(filters)
        dialog.open(self, None, self._on_file_open)

    def _on_file_open(self, dialog: Gtk.FileDialog, result: Any) -> None:
        try:
            gfile = dialog.open_finish(result)
        except GLib.Error:
            return
        path = gfile.get_path()
        if not path:
            self._log("the selected file is not a local file")
            return
        self._selected_file = path
        try:
            size_text = "%d KiB" % (os.path.getsize(path) // 1024)
        except OSError:
            size_text = "unknown size"
        self.file_label.set_text("%s  (%s)" % (os.path.basename(path), size_text))
        self._update_sensitivity()

    def _on_upload_clicked(self) -> None:
        if (self.device is None or self._selected_target is None or
                self._selected_slot is None or self._selected_file is None):
            return
        target = self._selected_target
        slot = self._selected_slot
        path = self._selected_file

        if target.kind == "nam" and not path.lower().endswith(".nam"):
            self._log("the selected file is not a .nam model")
            self._set_status("Choose a .nam file", error=True)
            return
        if target.kind == "ir" and not path.lower().endswith(".wav"):
            self._log("the selected file is not a .wav IR")
            self._set_status("Choose a .wav file", error=True)
            return

        names = self._slot_names
        if names and slot < len(names) and names[slot]:
            dialog = Gtk.MessageDialog(
                transient_for=self, modal=True,
                message_type=Gtk.MessageType.QUESTION,
                buttons=Gtk.ButtonsType.NONE,
                text="Overwrite slot %d?" % slot,
                secondary_text=(
                    "Slot %d already contains '%s'. The upload will replace it.\n\n%s"
                    % (slot, names[slot], os.path.basename(path))))
            dialog.add_button("Cancel", Gtk.ResponseType.CANCEL)
            dialog.add_button("Overwrite", Gtk.ResponseType.OK)
            dialog.connect("response", self._on_overwrite_response,
                           target, slot, path)
            dialog.present()
            return
        self._start_upload(target, slot, path)

    def _on_overwrite_response(self, dialog: Gtk.MessageDialog, response: int,
                               target: stomp.UploadTarget, slot: int,
                               path: str) -> None:
        dialog.destroy()
        if response == Gtk.ResponseType.OK:
            self._start_upload(target, slot, path)

    def _start_upload(self, target: stomp.UploadTarget, slot: int,
                      path: str) -> None:
        device = self.device
        if device is None:
            return
        self._uploading = True
        self._update_sensitivity()
        self.spinner.set_visible(True)
        self.spinner.start()
        self.progress.set_fraction(0.0)
        self.progress.set_text("Starting...")
        self._set_status("Uploading %s..." % os.path.basename(path))
        self._log("uploading %s to %s slot %d"
                  % (os.path.basename(path), target.path, slot))

        def on_progress(fraction: float, text: str) -> None:
            self._post(self._upload_progress, fraction, text)

        def worker() -> None:
            try:
                if target.kind == "ir":
                    result = device.load_ir(path, slot=slot, progress=on_progress)
                else:
                    result = device.load_nam(path, slot=slot, target=target.path,
                                             progress=on_progress)
                self._post(self._upload_finished, result, None)
            except Exception as exc:
                self._post(self._upload_finished, None, str(exc))

        threading.Thread(target=worker, daemon=True).start()

    def _upload_progress(self, fraction: float, text: str) -> None:
        self.progress.set_fraction(max(0.0, min(1.0, fraction)))
        self.progress.set_text(text)
        self._set_status("Uploading: %s" % text)

    def _upload_finished(self, result: dict[str, Any] | None,
                         error: str | None) -> None:
        self._uploading = False
        self.spinner.stop()
        self.spinner.set_visible(False)
        if error:
            self.progress.set_fraction(0.0)
            self.progress.set_text("Upload failed")
            self._log("upload failed: %s" % error)
            self._set_status(error, error=True)
        else:
            self.progress.set_fraction(1.0)
            result = result or {}
            self.progress.set_text("Upload complete")
            self._log("upload complete: %r -> slot %s"
                      % (result.get("name", ""), result.get("slot", "?")))
            self._set_status("Upload complete")
            self._slot_signature = None
        self._update_sensitivity()

    # ------------------------------------------------------------------
    # Shutdown / initial connection
    # ------------------------------------------------------------------

    def _post(self, fn: Callable[..., Any], *args: Any) -> None:
        if self._alive:
            GLib.idle_add(fn, *args)

    def _try_initial_connect(self) -> bool:
        if self._initial_done or self._busy or self.device is not None:
            return False
        self._initial_done = True
        if self._initial_tcp:
            self.mode_dd.set_selected(2)
            self.tcp_entry.set_text(self._initial_tcp)
            self._connect_after_delay()
            return False
        if self._initial_serial:
            self.mode_dd.set_selected(0)
            devices = [dev for dev, _desc in self._serial_ports]
            if self._initial_serial in devices:
                self.port_dd.set_selected(devices.index(self._initial_serial))
            else:
                self._serial_ports = [(self._initial_serial, "requested")] + self._serial_ports
                self.port_dd.set_model(Gtk.StringList.new(
                    ["%s  -  requested" % self._initial_serial] +
                    ["%s  -  %s" % (d, s) if s else d
                     for d, s in self._serial_ports[1:]]))
                self.port_dd.set_selected(0)
            self._connect_after_delay()
            return False
        return False

    def _connect_after_delay(self) -> None:
        GLib.timeout_add(100, lambda: (self._on_connect_clicked(), False)[1])

    def _on_close(self, *_args: Any) -> bool:
        self._alive = False
        device, self.device = self.device, None
        if device is not None:
            try:
                device.close()
            except Exception:
                pass
        return False

    def shutdown(self) -> None:
        if self._alive:
            self._on_close()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="StompStation Pro controller (modern GTK4 UI)")
    parser.add_argument("port", nargs="?", metavar="PORT",
                        help="legacy positional USB serial port")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--serial", metavar="PORT",
                       help="connect to a USB serial port (e.g. /dev/ttyACM0)")
    group.add_argument("--tcp", metavar="HOST:PORT",
                       help="connect to a network address")
    args = parser.parse_args(list(argv) if argv is not None else None)

    serial_port = args.serial or args.port
    if serial_port and args.tcp:
        parser.error("choose either a serial port or --tcp, not both")

    style = Adw.StyleManager.get_default()
    style.set_color_scheme(Adw.ColorScheme.FORCE_DARK)

    app = StompApp(serial_port, args.tcp)
    return app.run([sys.argv[0]])


if __name__ == "__main__":
    raise SystemExit(main())

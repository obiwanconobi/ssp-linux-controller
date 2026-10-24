#!/usr/bin/env python3
"""
stomp_ui.py -- modern GTK4 / libadwaita UI for the Sonulab StompStation PRO.

The signal chain is shown as a horizontal row of coloured block cards
(bypassed blocks are dimmed, click a block to select and edit it, or
right-click it to enable/disable it).  Layout is
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
/* -- Palette -------------------------------------------------------- */
@define-color window_bg_color #0f1118;
@define-color window_fg_color #f4f6fb;
@define-color view_bg_color #12141d;
@define-color view_fg_color #f4f6fb;
@define-color headerbar_bg_color #131521;
@define-color headerbar_fg_color #f4f6fb;
@define-color card_bg_color #191c2a;
@define-color card_fg_color #f4f6fb;
@define-color popover_bg_color #1a1d2b;
@define-color popover_fg_color #f4f6fb;
@define-color accent_color #4ade80;
@define-color accent_bg_color #22c55e;
@define-color accent_fg_color #052e16;
@define-color success_color #4ade80;
@define-color success_bg_color #14532d;
@define-color warning_color #fbbf24;
@define-color warning_bg_color #78350f;
@define-color error_color #f87171;
@define-color error_bg_color #7f1d1d;
@define-color destructive_bg_color #dc2626;
@define-color destructive_fg_color #ffffff;
@define-color borders alpha(@window_fg_color, 0.10);
@define-color shade_color rgba(0, 0, 0, 0.30);

window { background-color: @window_bg_color; color: @window_fg_color; }
headerbar { box-shadow: none; border-bottom: 1px solid alpha(@window_fg_color, 0.06); }

/* -- Surfaces ------------------------------------------------------- */
.panel {
    background-color: alpha(@window_fg_color, 0.035);
    border: 1px solid alpha(@window_fg_color, 0.075);
    border-radius: 14px;
    padding: 14px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
}
.footer-bar {
    background-color: alpha(@window_fg_color, 0.035);
    border: 1px solid alpha(@window_fg_color, 0.075);
    border-radius: 14px;
    padding: 8px 12px;
}
.panel-header { margin-bottom: 1px; }
.section-title {
    font-weight: 700;
    font-size: 14px;
    color: @window_fg_color;
}
.section-caption {
    font-size: 12px;
    font-weight: 500;
    color: alpha(@window_fg_color, 0.50);
}
.dim-label { opacity: 0.60; font-size: 12px; }
.value-label { font-family: monospace; font-size: 12px; font-weight: 600;
               color: alpha(@window_fg_color, 0.82); }
.value-chip {
    font-family: monospace;
    font-size: 12px;
    font-weight: 700;
    background-color: alpha(@window_fg_color, 0.06);
    border-radius: 7px;
    padding: 2px 7px;
}
.field-label {
    font-size: 12px;
    font-weight: 600;
    color: alpha(@window_fg_color, 0.50);
}
.count-pill {
    background-color: alpha(@window_fg_color, 0.07);
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 11px;
    font-weight: 600;
    color: alpha(@window_fg_color, 0.65);
}

/* -- Header --------------------------------------------------------- */
.patch-nav {
    background-color: alpha(@window_fg_color, 0.045);
    border: 1px solid alpha(@window_fg_color, 0.07);
    border-radius: 12px;
    padding: 3px;
}
.patch-nav button { min-height: 30px; border-radius: 9px; }
.status-pill {
    background-color: alpha(@window_fg_color, 0.05);
    border: 1px solid alpha(@window_fg_color, 0.07);
    border-radius: 999px;
    padding: 4px 10px;
}
.status-pill label { font-size: 12px; font-weight: 600; }
.status-dot {
    min-width: 7px;
    min-height: 7px;
    border-radius: 999px;
    background-color: alpha(@window_fg_color, 0.30);
    transition: background-color 160ms ease;
}
.status-dot.status-ok {
    background-color: @success_color;
    box-shadow: 0 0 6px alpha(@success_color, 0.55);
}
.status-dot.status-error { background-color: @error_color; }
.status-dot.status-idle  { background-color: alpha(@window_fg_color, 0.28); }

/* -- Patch list ----------------------------------------------------- */
.patch-list { background-color: transparent; }
.patch-row {
    border-radius: 9px;
    min-height: 32px;
    margin: 1px 0;
    padding: 0;
    transition: background-color 130ms ease;
}
.patch-row:hover { background-color: alpha(@window_fg_color, 0.05); }
.patch-row:selected {
    background-color: alpha(@accent_color, 0.13);
    box-shadow: inset 3px 0 0 @accent_color;
}
.patch-row label { padding: 7px 10px; font-size: 13px; }
.patch-row:selected label { font-weight: 600; }

/* -- Signal chain --------------------------------------------------- */
.chain-scroll { background-color: transparent; }
.chain-block {
    min-width: 84px;
    min-height: 60px;
    padding: 7px 8px 6px;
    border-radius: 12px;
    border: 1px solid alpha(@window_fg_color, 0.10);
    background-color: alpha(@window_fg_color, 0.035);
    transition: background-color 140ms ease, border-color 140ms ease,
                opacity 140ms ease;
}
.chain-block:hover {
    background-color: alpha(@window_fg_color, 0.075);
    border-color: alpha(@window_fg_color, 0.20);
}
.chain-block:focus-visible { box-shadow: 0 0 0 2px @accent_color; }
.chain-block.bypassed { opacity: 0.60; }
.chain-block.bypassed:hover { opacity: 0.80; }
.block-dot {
    min-width: 7px;
    min-height: 7px;
    border-radius: 999px;
    background-color: alpha(@window_fg_color, 0.30);
}
.block-abbr {
    font-weight: 800;
    font-size: 12px;
    color: @window_fg_color;
}
.block-name { font-size: 11px; color: alpha(@window_fg_color, 0.65); }
.block-status { font-size: 11px; font-weight: 700; }
.chain-arrow { opacity: 0.26; }
.state-on  { color: @success_color; }
.state-off { color: alpha(@window_fg_color, 0.55); }

/* -- Selected block ------------------------------------------------- */
.details-title {
    font-size: 17px;
    font-weight: 800;
    color: @window_fg_color;
}
.status-chip {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-weight: 700;
    background-color: alpha(@window_fg_color, 0.06);
    color: alpha(@window_fg_color, 0.50);
}
.status-chip.state-on {
    color: @success_color;
    background-color: alpha(@success_color, 0.12);
}
.status-chip.state-off {
    color: alpha(@window_fg_color, 0.50);
}
.param-row {
    padding: 3px 5px;
    border-radius: 8px;
    transition: background-color 120ms ease;
}
.param-row:hover { background-color: alpha(@window_fg_color, 0.035); }
.param-label {
    font-size: 12px;
    color: alpha(@window_fg_color, 0.68);
}

/* -- Dual NAM editor ------------------------------------------------ */
.dual-card {
    background-color: alpha(@window_fg_color, 0.035);
    border: 1px solid alpha(@window_fg_color, 0.09);
    border-radius: 12px;
    padding: 9px 10px;
}
.dual-card-secondary {
    background-color: alpha(@window_fg_color, 0.02);
}
.dual-card-title {
    font-size: 11px;
    font-weight: 800;
    color: alpha(@window_fg_color, 0.82);
}
.dual-card-subtitle {
    font-size: 11px;
    color: alpha(@window_fg_color, 0.48);
}
.dual-card-body { margin-top: 2px; }
.dual-card.dual-off .dual-card-body { opacity: 0.62; }
.dual-expander { background-color: transparent; }
.dual-subhead {
    font-size: 10px;
    font-weight: 700;
    color: alpha(@window_fg_color, 0.48);
}

/* -- Status / empty states ------------------------------------------ */
.status-ok    { color: @success_color; font-weight: 600; }
.status-error { color: @error_color; font-weight: 600; }
.status-idle  { opacity: 0.65; }
.empty-state { padding: 22px 12px; }
.empty-state.compact { padding: 8px 12px; }
.empty-icon { opacity: 0.32; }
.empty-title { font-weight: 700; font-size: 13px; }
.empty-caption {
    font-size: 12px;
    color: alpha(@window_fg_color, 0.50);
}

/* -- Utilities ------------------------------------------------------ */
.log-scroll {
    background-color: rgba(0, 0, 0, 0.16);
    border: 1px solid alpha(@window_fg_color, 0.06);
    border-radius: 10px;
}
.log-view, .log-view text { background-color: transparent; }
.log-view { font-size: 12px; }
.file-name {
    font-size: 12px;
    color: alpha(@window_fg_color, 0.50);
}
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


def _chain_display_name(label: str) -> str:
    """Use the descriptive half of labels such as 'Drive / distortion'."""
    if " / " in label:
        suffix = label.split(" / ", 1)[1].strip()
        if suffix:
            return suffix[0].upper() + suffix[1:]
    return label


def _css_class_for(key: str) -> str:
    return "tone-" + re.sub(r"[^A-Za-z0-9_-]", "_", key)


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
        self.set_default_size(1280, 860)
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
        self._param_controls: dict[str, dict[str, Any]] = {}
        self._param_dirty: set[str] = set()

        self._css_provider = Gtk.CssProvider()
        self._reload_css([])

        self._build_ui()
        self.connect("close-request", self._on_close)

        # Network discovery is the default transport; USB remains available.
        self.mode_dd.set_selected(1)
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
            cls = _css_class_for(key)
            color = _color_for(key)
            css += (
                ".block-dot.%s { background-color: %s; }\n"
                ".details-title.%s { color: %s; }\n"
                ".chain-block.%s:checked {\n"
                "    border-color: alpha(%s, 0.80);\n"
                "    background-color: alpha(%s, 0.13);\n"
                "}\n"
                ".chain-block.%s:checked:hover {\n"
                "    background-color: alpha(%s, 0.18);\n"
                "}\n"
            ) % (cls, color, cls, color, cls, color, color, cls, color)
        self._css_provider.load_from_data(css.encode("utf-8"))
        display = Gdk.Display.get_default()
        if display:
            Gtk.StyleContext.add_provider_for_display(
                display, self._css_provider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def _set_block_color_class(self, widget: Gtk.Widget, key: str) -> None:
        for cls in list(widget.get_css_classes()):
            if cls.startswith("tone-"):
                widget.remove_css_class(cls)
        widget.add_css_class(_css_class_for(key))

    # ------------------------------------------------------------------
    # Construction
    # ------------------------------------------------------------------

    def _build_ui(self) -> None:
        header = Adw.HeaderBar()

        title = Adw.WindowTitle(title="StompStation Pro",
                                subtitle="Sonulab StompStation PRO")
        header.pack_start(title)

        # Patch navigation lives in the header centre so the current rig is
        # always visible, with its related actions grouped beside it.
        nav = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        nav.add_css_class("patch-nav")

        self.prev_btn = self._icon_button(
            "go-previous-symbolic", "Previous patch", "Previous patch")
        self.prev_btn.connect("clicked", lambda *_: self._step_patch(-1))
        nav.append(self.prev_btn)

        self.patch_dd = Gtk.DropDown.new_from_strings(["No patches"])
        self.patch_dd.set_size_request(240, -1)
        self.patch_dd.set_tooltip_text("Select a patch")
        self.patch_dd.connect("notify::selected", self._on_patch_selected)
        nav.append(self.patch_dd)

        self.next_btn = self._icon_button(
            "go-next-symbolic", "Next patch", "Next patch")
        self.next_btn.connect("clicked", lambda *_: self._step_patch(1))
        nav.append(self.next_btn)

        nav.append(Gtk.Separator(orientation=Gtk.Orientation.VERTICAL))

        self.patch_reload_btn = self._icon_button(
            "view-refresh-symbolic", "Reload state from device",
            "Reload state from device")
        self.patch_reload_btn.connect(
            "clicked", lambda *_: self._refresh_all_async())
        nav.append(self.patch_reload_btn)

        self.patch_save_btn = self._icon_button(
            "document-save-symbolic", "Save the current settings into this patch",
            "Save patch")
        self.patch_save_btn.connect("clicked", lambda *_: self._save_patch())
        nav.append(self.patch_save_btn)

        header.set_title_widget(nav)

        status_pill = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=7)
        status_pill.add_css_class("status-pill")
        self.header_dot = Gtk.Box()
        self.header_dot.set_size_request(7, 7)
        self.header_dot.set_valign(Gtk.Align.CENTER)
        self.header_dot.set_halign(Gtk.Align.CENTER)
        self.header_dot.add_css_class("status-dot")
        self.header_dot.add_css_class("status-idle")
        status_pill.append(self.header_dot)
        self.header_status = Gtk.Label(label="Offline")
        self.header_status.add_css_class("status-idle")
        status_pill.append(self.header_status)
        header.pack_end(status_pill)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        outer.set_margin_top(12)
        outer.set_margin_bottom(12)
        outer.set_margin_start(14)
        outer.set_margin_end(14)

        # Signal chain spans the full width at the top.
        outer.append(self._build_chain_box())

        # The remaining sections sit below the chain.
        columns = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=12)
        columns.set_vexpand(True)
        outer.append(columns)

        left = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        left.set_size_request(250, -1)
        columns.append(left)
        left.append(self._build_presets_box())

        middle = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        middle.set_hexpand(True)
        columns.append(middle)
        middle.append(self._build_details_box())

        right = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        right.set_size_request(324, -1)
        columns.append(right)
        right.append(self._build_master_box())
        right.append(self._build_files_log_box())

        # Device selector + connect/disconnect at the bottom.
        outer.append(self._build_connection_bar())

        toolbar_view = Adw.ToolbarView()
        toolbar_view.add_top_bar(header)
        toolbar_view.set_content(outer)
        self.set_content(toolbar_view)

        self._update_sensitivity()

    @staticmethod
    def _set_accessible_label(widget: Gtk.Widget, label: str) -> None:
        widget.update_property([Gtk.AccessibleProperty.LABEL], [label])

    @staticmethod
    def _icon_button(icon_name: str, tooltip: str,
                     accessible_label: str | None = None) -> Gtk.Button:
        button = Gtk.Button.new_from_icon_name(icon_name)
        button.add_css_class("flat")
        button.set_tooltip_text(tooltip)
        MainWindow._set_accessible_label(button, accessible_label or tooltip)
        return button

    @staticmethod
    def _empty_state(icon_name: str, title: str,
                     caption: str, compact: bool = False) -> Gtk.Widget:
        box = Gtk.Box(
            orientation=Gtk.Orientation.HORIZONTAL if compact
            else Gtk.Orientation.VERTICAL,
            spacing=12 if compact else 6)
        box.add_css_class("empty-state")
        if compact:
            box.add_css_class("compact")
        box.set_halign(Gtk.Align.CENTER)
        box.set_valign(Gtk.Align.CENTER)
        box.set_vexpand(not compact)

        image = Gtk.Image.new_from_icon_name(icon_name)
        image.set_pixel_size(26 if compact else 30)
        image.add_css_class("empty-icon")
        box.append(image)

        text = Gtk.Box(orientation=Gtk.Orientation.VERTICAL,
                       spacing=0 if compact else 2)
        heading = Gtk.Label(label=title, justify=Gtk.Justification.CENTER)
        heading.add_css_class("empty-title")
        text.append(heading)

        detail = Gtk.Label(label=caption, justify=Gtk.Justification.CENTER)
        detail.add_css_class("empty-caption")
        detail.set_wrap(True)
        detail.set_max_width_chars(48 if compact else 34)
        text.append(detail)
        box.append(text)
        return box

    @staticmethod
    def _field(label: str, widget: Gtk.Widget) -> Gtk.Widget:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        caption = Gtk.Label(label=label, xalign=0)
        caption.add_css_class("field-label")
        box.append(caption)
        box.append(widget)
        return box

    def _build_connection_bar(self) -> Gtk.Widget:
        bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        bar.add_css_class("footer-bar")

        self.spinner = Gtk.Spinner()
        self.spinner.set_visible(False)
        bar.append(self.spinner)

        self.status_dot = Gtk.Box()
        self.status_dot.set_size_request(7, 7)
        self.status_dot.set_valign(Gtk.Align.CENTER)
        self.status_dot.set_halign(Gtk.Align.CENTER)
        self.status_dot.add_css_class("status-dot")
        self.status_dot.add_css_class("status-idle")
        bar.append(self.status_dot)

        self.status_label = Gtk.Label(label="Ready", xalign=0)
        self.status_label.set_hexpand(True)
        self.status_label.set_ellipsize(Pango.EllipsizeMode.END)
        self.status_label.add_css_class("status-idle")
        bar.append(self.status_label)

        # Source controls are hidden once connected; the header and status
        # line carry the connection state, so the footer stays uncluttered.
        self.source_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                                  spacing=8)
        bar.append(self.source_box)

        source_label = Gtk.Label(label="Device", xalign=0)
        source_label.add_css_class("field-label")
        self.source_box.append(source_label)

        self.mode_dd = Gtk.DropDown.new_from_strings(
            ["USB serial", "Network (mDNS)", "Manual TCP"])
        self.mode_dd.set_tooltip_text("Choose how to reach the pedal")
        self.mode_dd.connect("notify::selected", self._on_mode_changed)
        self.source_box.append(self.mode_dd)

        self.mode_stack = Gtk.Stack()
        self.mode_stack.set_transition_type(Gtk.StackTransitionType.NONE)
        self.source_box.append(self.mode_stack)

        serial_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.port_dd = Gtk.DropDown.new_from_strings(["Scanning..."])
        self.port_dd.set_size_request(180, -1)
        self._set_accessible_label(self.port_dd, "Serial port")
        serial_box.append(self.port_dd)
        refresh = self._icon_button(
            "view-refresh-symbolic", "Refresh serial ports",
            "Refresh serial ports")
        refresh.connect("clicked", lambda *_: self._refresh_serial_ports())
        serial_box.append(refresh)
        self.mode_stack.add_named(serial_box, "serial")

        mdns_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.mdns_dd = Gtk.DropDown.new_from_strings(["Scanning..."])
        self.mdns_dd.set_size_request(180, -1)
        self._set_accessible_label(self.mdns_dd, "Discovered network device")
        mdns_box.append(self.mdns_dd)
        scan = self._icon_button("edit-find-symbolic",
                                 "Scan for network devices",
                                 "Scan for network devices")
        scan.connect("clicked", lambda *_: self._start_mdns_scan())
        mdns_box.append(scan)
        self.mode_stack.add_named(mdns_box, "mdns")

        manual_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.tcp_entry = Gtk.Entry()
        self.tcp_entry.set_placeholder_text("host:port")
        self.tcp_entry.set_size_request(180, -1)
        self._set_accessible_label(self.tcp_entry, "Network address")
        manual_box.append(self.tcp_entry)
        self.mode_stack.add_named(manual_box, "manual")

        self.connect_btn = Gtk.Button()
        self.connect_btn.add_css_class("suggested-action")
        self.connect_content = Adw.ButtonContent(
            icon_name="network-wired-symbolic", label="Connect")
        self.connect_btn.set_child(self.connect_content)
        self.connect_btn.set_tooltip_text("Connect to the pedal")
        self._set_accessible_label(self.connect_btn, "Connect")
        self.connect_btn.connect("clicked", lambda *_: self._on_connect_clicked())
        bar.append(self.connect_btn)

        return bar

    def _build_presets_box(self) -> Gtk.Widget:
        panel, box, header = self._section("Patches")
        panel.set_vexpand(True)

        self.patch_count_label = Gtk.Label(label="0")
        self.patch_count_label.add_css_class("count-pill")
        self.patch_count_label.set_visible(False)
        header.append(self.patch_count_label)

        self.patch_search = Gtk.SearchEntry()
        self.patch_search.set_placeholder_text("Search patches")
        self.patch_search.set_tooltip_text("Filter the patch list")
        self.patch_search.set_visible(False)
        self._set_accessible_label(self.patch_search, "Search patches")
        self.patch_search.connect("search-changed",
                                  self._on_patch_search_changed)
        box.append(self.patch_search)

        self.presets_stack = Gtk.Stack()
        self.presets_stack.set_transition_type(
            Gtk.StackTransitionType.CROSSFADE)
        self.presets_stack.set_transition_duration(140)
        self.presets_stack.set_vexpand(True)
        box.append(self.presets_stack)

        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_vexpand(True)
        self.presets_list = Gtk.ListBox()
        self.presets_list.add_css_class("patch-list")
        self.presets_list.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.presets_list.set_activate_on_single_click(True)
        self.presets_list.connect("row-activated", self._on_preset_activated)
        scrolled.set_child(self.presets_list)
        self.presets_stack.add_named(scrolled, "list")

        empty = self._empty_state(
            "folder-music-symbolic", "No patches loaded",
            "Connect to the pedal to browse and load its patches.")
        self.presets_stack.add_named(empty, "empty")
        no_results = self._empty_state(
            "edit-find-symbolic", "No matches",
            "Try a different search term.")
        self.presets_stack.add_named(no_results, "no-results")
        self.presets_stack.set_visible_child_name("empty")
        return panel

    def _build_chain_box(self) -> Gtk.Widget:
        panel, box, header = self._section("Signal chain")
        hint = Gtk.Label(
            label="Click a block to edit it; right-click to enable/disable")
        hint.add_css_class("section-caption")
        hint.set_visible(False)
        self.chain_hint = hint
        header.append(hint)

        self.chain_stack = Gtk.Stack()
        self.chain_stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self.chain_stack.set_transition_duration(140)
        self.chain_stack.set_size_request(-1, 76)
        box.append(self.chain_stack)

        scrolled = Gtk.ScrolledWindow()
        scrolled.add_css_class("chain-scroll")
        scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER)
        scrolled.set_hexpand(True)
        scrolled.set_min_content_height(76)
        self._chain_wrap = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                                   spacing=0)
        self._chain_wrap.set_halign(Gtk.Align.START)
        self._chain_wrap.set_valign(Gtk.Align.CENTER)
        self._chain_wrap.set_vexpand(False)
        self.chain_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL,
                                 spacing=6)
        self.chain_box.set_valign(Gtk.Align.CENTER)
        self._chain_wrap.append(self.chain_box)
        scrolled.set_child(self._chain_wrap)
        self.chain_stack.add_named(scrolled, "chain")

        empty = self._empty_state(
            "emblem-music-symbolic", "No signal chain yet",
            "Connect to your pedal to load the current rig.", compact=True)
        self.chain_stack.add_named(empty, "empty")
        self.chain_stack.set_visible_child_name("empty")
        return panel

    def _build_details_box(self) -> Gtk.Widget:
        panel, box, _header = self._section("Selected block")
        panel.set_vexpand(True)
        box.set_vexpand(True)

        self.details_stack = Gtk.Stack()
        self.details_stack.set_transition_type(
            Gtk.StackTransitionType.CROSSFADE)
        self.details_stack.set_transition_duration(140)
        self.details_stack.set_vexpand(True)
        box.append(self.details_stack)

        empty = self._empty_state(
            "view-list-symbolic", "No block selected",
            "Choose a block in the signal chain to edit its controls.")
        self.details_stack.add_named(empty, "empty")

        editor = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        editor.set_vexpand(True)
        self.details_stack.add_named(editor, "editor")

        heading = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        editor.append(heading)

        self.details_dot = Gtk.Box()
        self.details_dot.set_size_request(8, 8)
        self.details_dot.add_css_class("block-dot")
        self.details_dot.set_valign(Gtk.Align.CENTER)
        heading.append(self.details_dot)

        self.details_name = Gtk.Label(label="No block selected", xalign=0)
        self.details_name.add_css_class("details-title")
        self.details_name.set_hexpand(True)
        self.details_name.set_ellipsize(Pango.EllipsizeMode.END)
        heading.append(self.details_name)

        self.details_status = Gtk.Label(label="")
        self.details_status.add_css_class("status-chip")
        self._set_accessible_label(self.details_status, "Block state")
        heading.append(self.details_status)

        self.details_switch = Gtk.Switch()
        self.details_switch.set_valign(Gtk.Align.CENTER)
        self.details_switch.set_sensitive(False)
        self.details_switch.set_tooltip_text("Enable or bypass this block")
        self._set_accessible_label(self.details_switch,
                                   "Enable selected block")
        self.details_switch.connect("state-set", self._on_details_switch)
        heading.append(self.details_switch)

        editor.append(Gtk.Separator())

        params_scroll = Gtk.ScrolledWindow()
        params_scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        params_scroll.set_overlay_scrolling(False)
        params_scroll.set_vexpand(True)
        self.params_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        params_scroll.set_child(self.params_box)
        editor.append(params_scroll)

        self.details_stack.set_visible_child_name("empty")
        self._details_block_path: str | None = None
        self._details_dual_path: str | None = None
        self._dual_card: Gtk.Widget | None = None
        self._dual_expander: Gtk.Expander | None = None
        self._dual_switch: Gtk.Switch | None = None
        self._dual_status: Gtk.Label | None = None
        self._dual_on: bool | None = None
        self._show_details_hint()
        return panel

    def _build_master_box(self) -> Gtk.Widget:
        panel, box, _header = self._section("Master")

        vol_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        box.append(vol_row)
        vol_label = Gtk.Label(label="Volume", xalign=0)
        vol_label.add_css_class("param-label")
        vol_label.set_size_request(58, -1)
        vol_row.append(vol_label)
        self.volume_scale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, 0.0, 100.0, 1.0)
        self.volume_scale.set_hexpand(True)
        self.volume_scale.set_draw_value(False)
        self.volume_scale.set_tooltip_text("Master output volume")
        self._set_accessible_label(self.volume_scale, "Master volume")
        self.volume_scale.connect("value-changed", self._on_volume_changed)
        vol_row.append(self.volume_scale)
        self.volume_value_label = Gtk.Label(label="--")
        self.volume_value_label.add_css_class("value-label")
        self.volume_value_label.add_css_class("value-chip")
        self.volume_value_label.set_size_request(52, -1)
        vol_row.append(self.volume_value_label)

        tempo_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        box.append(tempo_row)
        tempo_label = Gtk.Label(label="Tempo", xalign=0)
        tempo_label.add_css_class("param-label")
        tempo_label.set_size_request(58, -1)
        tempo_row.append(tempo_label)
        self.tempo_spin = Gtk.SpinButton.new_with_range(20.0, 300.0, 1.0)
        self.tempo_spin.set_hexpand(True)
        self.tempo_spin.set_value(120.0)
        self.tempo_spin.set_tooltip_text("Patch tempo in beats per minute")
        self._set_accessible_label(self.tempo_spin, "Tempo in BPM")
        self.tempo_spin.connect("value-changed", self._on_tempo_changed)
        tempo_row.append(self.tempo_spin)
        bpm = Gtk.Label(label="BPM", xalign=0)
        bpm.add_css_class("field-label")
        tempo_row.append(bpm)
        return panel

    def _build_files_log_box(self) -> Gtk.Widget:
        panel = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
        panel.add_css_class("panel")
        panel.set_vexpand(True)

        self.utility_stack = Adw.ViewStack()
        self.utility_stack.set_vexpand(True)
        self.utility_stack.add_titled_with_icon(
            self._build_upload_page(), "files", "Files",
            "folder-download-symbolic")
        self.utility_stack.add_titled_with_icon(
            self._build_log_page(), "activity", "Activity",
            "utilities-terminal-symbolic")

        switcher = Adw.ViewSwitcher()
        switcher.set_stack(self.utility_stack)
        switcher.set_policy(Adw.ViewSwitcherPolicy.WIDE)
        switcher.set_halign(Gtk.Align.CENTER)
        panel.append(switcher)
        panel.append(self.utility_stack)
        return panel

    def _build_upload_page(self) -> Gtk.Widget:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)

        self.target_dd = Gtk.DropDown.new_from_strings(
            ["Waiting for device..."])
        self.target_dd.set_hexpand(True)
        self.target_dd.set_tooltip_text("Choose which library receives the file")
        self._set_accessible_label(self.target_dd, "Upload target")
        self.target_dd.connect("notify::selected", self._on_target_changed)
        box.append(self._field("Upload target", self.target_dd))

        self.slot_dd = Gtk.DropDown.new_from_strings(["--"])
        self.slot_dd.set_hexpand(True)
        self.slot_dd.set_tooltip_text("Choose the destination slot")
        self._set_accessible_label(self.slot_dd, "Upload slot")
        self.slot_dd.connect("notify::selected", self._on_slot_changed)
        box.append(self._field("Slot", self.slot_dd))

        self.file_btn = Gtk.Button()
        self.file_btn.set_child(Adw.ButtonContent(
            icon_name="document-open-symbolic", label="Choose file"))
        self.file_btn.set_tooltip_text("Choose a NAM model or IR WAV file")
        self._set_accessible_label(self.file_btn, "Choose file")
        self.file_btn.connect("clicked", lambda *_: self._choose_file())

        self.file_label = Gtk.Label(label="No file selected", xalign=0)
        self.file_label.add_css_class("file-name")
        self.file_label.set_hexpand(True)
        self.file_label.set_ellipsize(Pango.EllipsizeMode.MIDDLE)

        file_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        file_box.append(self.file_btn)
        file_box.append(self.file_label)
        box.append(self._field("File", file_box))

        self.upload_btn = Gtk.Button()
        self.upload_btn.add_css_class("suggested-action")
        self.upload_btn.set_child(Adw.ButtonContent(
            icon_name="document-send-symbolic", label="Upload"))
        self.upload_btn.set_tooltip_text("Upload the selected file to the pedal")
        self._set_accessible_label(self.upload_btn, "Upload file")
        self.upload_btn.connect("clicked", lambda *_: self._on_upload_clicked())
        box.append(self.upload_btn)

        self.progress = Gtk.ProgressBar()
        self.progress.set_show_text(True)
        self.progress.set_text("Idle")
        self.progress.set_visible(False)
        box.append(self.progress)
        return box

    def _build_log_page(self) -> Gtk.Widget:
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)

        toolbar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(toolbar)
        caption = Gtk.Label(label="Session events", xalign=0)
        caption.add_css_class("section-caption")
        caption.set_hexpand(True)
        toolbar.append(caption)
        clear_btn = self._icon_button("user-trash-symbolic",
                                      "Clear activity log",
                                      "Clear activity log")
        clear_btn.connect("clicked", lambda *_: self._clear_log())
        toolbar.append(clear_btn)

        self.log_placeholder = Gtk.Label(
            label="Connection and device events will appear here.")
        self.log_placeholder.add_css_class("empty-caption")
        self.log_placeholder.set_wrap(True)
        self.log_placeholder.set_max_width_chars(32)
        self.log_placeholder.set_halign(Gtk.Align.CENTER)
        self.log_placeholder.set_valign(Gtk.Align.CENTER)
        self.log_placeholder.set_can_target(False)

        scrolled = Gtk.ScrolledWindow()
        scrolled.add_css_class("log-scroll")
        scrolled.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_overlay_scrolling(False)
        scrolled.set_vexpand(True)
        self.log_view = Gtk.TextView()
        self.log_view.add_css_class("log-view")
        self.log_view.set_editable(False)
        self.log_view.set_cursor_visible(False)
        self.log_view.set_monospace(True)
        self.log_view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self.log_view.set_top_margin(10)
        self.log_view.set_bottom_margin(10)
        self.log_view.set_left_margin(10)
        self.log_view.set_right_margin(10)
        scrolled.set_child(self.log_view)

        overlay = Gtk.Overlay()
        overlay.set_child(scrolled)
        overlay.add_overlay(self.log_placeholder)
        overlay.set_vexpand(True)
        box.append(overlay)
        return box

    @staticmethod
    def _section(title: str) -> tuple[Gtk.Box, Gtk.Box, Gtk.Box]:
        panel = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        panel.add_css_class("panel")
        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        header.add_css_class("panel-header")
        label = Gtk.Label(label=title, xalign=0)
        label.add_css_class("section-title")
        label.set_hexpand(True)
        header.append(label)
        panel.append(header)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        panel.append(box)
        return panel, box, header

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
        self.log_placeholder.set_visible(False)
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
        self.log_placeholder.set_visible(True)

    def _set_status(self, text: str, error: bool = False) -> None:
        self.status_label.set_text(text)
        for cls in ("status-ok", "status-error", "status-idle"):
            self.status_label.remove_css_class(cls)
            self.status_dot.remove_css_class(cls)
        cls = "status-error" if error else "status-ok"
        self.status_label.add_css_class(cls)
        self.status_dot.add_css_class(cls)

    def _set_header_status(self, text: str, connected: bool) -> None:
        self.header_status.set_text(text)
        for cls in ("status-ok", "status-error", "status-idle"):
            self.header_status.remove_css_class(cls)
            self.header_dot.remove_css_class(cls)
        cls = "status-ok" if connected else "status-idle"
        self.header_status.add_css_class(cls)
        self.header_dot.add_css_class(cls)

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
            self.connect_content.set_label("Disconnect")
            self.connect_btn.remove_css_class("suggested-action")
            self.connect_btn.set_tooltip_text("Disconnect from the pedal")
            self._set_accessible_label(self.connect_btn, "Disconnect")
        else:
            self.connect_content.set_label("Connect")
            self.connect_btn.add_css_class("suggested-action")
            self.connect_btn.set_tooltip_text("Connect to the pedal")
            self._set_accessible_label(self.connect_btn, "Connect")
        self.connect_btn.set_sensitive(idle)
        self.source_box.set_visible(not connected)
        self.mode_dd.set_sensitive(not connected and idle)
        self.port_dd.set_sensitive(not connected and idle)
        self.mdns_dd.set_sensitive(not connected and idle)
        self.tcp_entry.set_sensitive(not connected and idle)

        for widget in (self.prev_btn, self.next_btn, self.patch_dd,
                       self.patch_reload_btn, self.patch_save_btn,
                       self.presets_list, self.patch_search):
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
        if can_upload:
            self.upload_btn.add_css_class("suggested-action")
        else:
            self.upload_btn.remove_css_class("suggested-action")

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
        self._patch_dd_model([])
        self.patch_search.set_text("")
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
        self.progress.set_visible(False)
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
        self._update_param_values()
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
            self.patch_dd.set_model(
                Gtk.StringList.new(names if names else ["No patches"]))
            if not names:
                self.patch_dd.set_selected(0)
        finally:
            self._syncing = False

    def _rebuild_presets(self, names: list[str]) -> None:
        self._clear_presets()
        for name in names:
            row = Gtk.ListBoxRow()
            row.name = name
            row.add_css_class("patch-row")
            row.set_tooltip_text("Load %s" % name)
            label = Gtk.Label(label=name, xalign=0)
            label.set_ellipsize(Pango.EllipsizeMode.END)
            row.set_child(label)
            self.presets_list.append(row)
            self._preset_rows[name] = row
        self._filter_patches()

    def _clear_presets(self) -> None:
        child = self.presets_list.get_first_child()
        while child is not None:
            next_child = child.get_next_sibling()
            self.presets_list.remove(child)
            child = next_child
        self._preset_rows.clear()
        self.patch_count_label.set_text("0")
        self.patch_count_label.set_visible(False)
        self.patch_search.set_visible(False)
        self.presets_stack.set_visible_child_name("empty")

    def _on_patch_search_changed(self, _entry: Gtk.SearchEntry) -> None:
        self._filter_patches()

    def _filter_patches(self) -> None:
        query = self.patch_search.get_text().strip().casefold()
        visible = 0
        for name, row in self._preset_rows.items():
            match = not query or query in name.casefold()
            row.set_visible(match)
            visible += int(match)
        total = len(self._preset_rows)
        if total == 0:
            self.patch_count_label.set_text("0")
            self.patch_count_label.set_visible(False)
            self.patch_search.set_visible(False)
            self.presets_stack.set_visible_child_name("empty")
            return
        self.patch_search.set_visible(True)
        self.patch_count_label.set_visible(True)
        self.patch_count_label.set_text(
            str(total) if not query else "%d / %d" % (visible, total))
        if visible == 0:
            self.presets_stack.set_visible_child_name("no-results")
        else:
            self.presets_stack.set_visible_child_name("list")

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
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2)
        box.set_size_request(84, 60)

        top = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=5)
        top.set_halign(Gtk.Align.CENTER)
        dot = Gtk.Box()
        dot.set_size_request(7, 7)
        dot.set_valign(Gtk.Align.CENTER)
        dot.add_css_class("block-dot")
        dot.add_css_class(_css_class_for(key))
        top.append(dot)

        abbr = Gtk.Label(label=_short_for(key, block.label), xalign=0.5)
        abbr.add_css_class("block-abbr")
        top.append(abbr)
        box.append(top)

        name = Gtk.Label(label=_chain_display_name(block.label), xalign=0.5)
        name.add_css_class("block-name")
        name.set_ellipsize(Pango.EllipsizeMode.END)
        name.set_max_width_chars(12)
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
        self.chain_hint.set_visible(False)
        self.chain_stack.set_visible_child_name("empty")

    def _rebuild_chain(self, blocks: list[stomp.BlockState]) -> None:
        self._clear_chain()
        self._chain_sig = self._chain_signature(blocks)
        for block in blocks:
            key = _key_for_path(block.path)
            self._chain_keys.append(key)
            if self.chain_box.get_first_child() is not None:
                arrow = Gtk.Image.new_from_icon_name("go-next-symbolic")
                arrow.set_pixel_size(12)
                arrow.add_css_class("chain-arrow")
                arrow.set_valign(Gtk.Align.CENTER)
                self.chain_box.append(arrow)
            card = self._make_chain_card(block)
            btn = Gtk.ToggleButton()
            btn.add_css_class("chain-block")
            btn.add_css_class(_css_class_for(key))
            btn.set_valign(Gtk.Align.CENTER)
            btn.set_tooltip_text(
                "Select %s block; right-click to enable/disable" % block.label)
            self._set_accessible_label(btn, "%s block" % block.label)
            btn.set_child(card["box"])
            btn.connect("toggled", self._on_chain_toggled, block.path)
            right_click = Gtk.GestureClick()
            right_click.set_button(Gdk.BUTTON_SECONDARY)
            right_click.connect("pressed", self._on_chain_right_click,
                                block.path)
            btn.add_controller(right_click)
            self.chain_box.append(btn)
            self._chain_cards[block.path] = {"btn": btn, **card}
        self._reload_css(self._chain_keys)
        self.chain_hint.set_visible(bool(blocks))
        self.chain_stack.set_visible_child_name(
            "chain" if blocks else "empty")

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
            self._set_state_label(card["status"], block.on)
            state_text = ("on" if block.on else
                          ("off" if block.on is False else "state unknown"))
            self._set_accessible_label(
                card["btn"], "%s block, %s" % (block.label, state_text))
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

    def _on_chain_right_click(self, gesture: Gtk.GestureClick,
                              _n_press: int, _x: float, _y: float,
                              path: str) -> None:
        gesture.set_state(Gtk.EventSequenceState.CLAIMED)
        device = self.device
        if device is None or self._busy or self._state is None:
            return
        block = next((b for b in self._state.blocks if b.path == path), None)
        if block is None:
            return
        if block.on is None:
            self._log("cannot toggle %s: block state is unknown" % block.label)
            return

        state = not block.on
        self._log("%s block -> %s" % (block.label, "ON" if state else "OFF"))
        # Apply immediately; the next device poll confirms the new state.
        block.on = state
        self._render_state(self._state)

        def worker() -> None:
            try:
                device.set_block(path, state)
            except Exception as exc:
                self._post(self._log_threadsafe,
                           "block toggle failed: %s" % exc)

        threading.Thread(target=worker, daemon=True).start()

    # ------------------------------------------------------------------
    # Selected-block editor
    # ------------------------------------------------------------------

    def _show_details_hint(self) -> None:
        self.details_stack.set_visible_child_name("empty")
        self.details_name.set_text("No block selected")
        self.details_name.remove_css_class("details-title")
        self.details_name.add_css_class("dim-label")
        self.details_status.set_text("")
        for cls in ("state-on", "state-off"):
            self.details_status.remove_css_class(cls)
        self.details_switch.set_sensitive(False)
        self._clear_params()

    @staticmethod
    def _set_state_label(label: Gtk.Label, on: bool | None) -> None:
        for cls in ("state-on", "state-off"):
            label.remove_css_class(cls)
        if on is True:
            label.set_text("ON")
            label.add_css_class("state-on")
        elif on is False:
            label.set_text("OFF")
            label.add_css_class("state-off")
        else:
            label.set_text("?")
            label.add_css_class("state-off")

    def _clear_params(self) -> list[Gtk.Widget]:
        children: list[Gtk.Widget] = []
        child = self.params_box.get_first_child()
        while child is not None:
            next_child = child.get_next_sibling()
            self.params_box.remove(child)
            children.append(child)
            child = next_child
        self._param_timers.clear()
        self._param_controls.clear()
        self._param_dirty.clear()
        self._details_dual_path = None
        self._dual_card = None
        self._dual_expander = None
        self._dual_switch = None
        self._dual_status = None
        self._dual_on = None
        return children

    def _render_details(self) -> None:
        self._clear_params()
        path = self._selected_block_path
        if not path or self.device is None or self._state is None:
            self._show_details_hint()
            return

        block = next((b for b in self._state.blocks if b.path == path), None)
        if block is None:
            self._show_details_hint()
            return
        key = _key_for_path(path)
        self.details_stack.set_visible_child_name("editor")
        self.details_name.set_text(block.label)
        self.details_name.remove_css_class("dim-label")
        self.details_name.add_css_class("details-title")
        self._set_block_color_class(self.details_name, key)
        self._set_block_color_class(self.details_dot, key)
        self.details_switch.set_sensitive(block.on is not None)
        self._syncing = True
        try:
            self.details_switch.set_active(bool(block.on))
        finally:
            self._syncing = False
        self._set_state_label(self.details_status, block.on)
        self._details_block_path = path

        try:
            params = self.device.get_block_parameters(path)
        except Exception:
            params = []
        try:
            dual_block = self.device.get_dual_block(path)
        except Exception:
            dual_block = None
        if dual_block is not None:
            self._render_dual_block(params, dual_block)
            return
        if not params:
            hint = Gtk.Label(label="No editable parameters for this block",
                             xalign=0)
            hint.add_css_class("dim-label")
            self.params_box.append(hint)
            return
        for param in params:
            self.params_box.append(self._make_param_row(param))

    @staticmethod
    def _order_dual_params(params: list[dict[str, Any]]) -> list[dict[str, Any]]:
        order = {name: index for index, name in enumerate((
            "model", "ir", "gain", "lvl", "low", "mid", "treble",
            "locut", "hicut", "blend", "balance1", "balance2", "pan1", "pan2"))}
        return sorted(params, key=lambda param: (
            order.get(param["name"], len(order)), param["name"]))

    @staticmethod
    def _dual_ui_config(kind: str) -> dict[str, Any]:
        if kind == "ir":
            return {
                "first_title": "IR 1",
                "first_subtitle": "Primary cabinet",
                "second_title": "IR 2",
                "second_subtitle": "Stereo IR \u00b7 runs in parallel",
                "secondary_params": ("balance1", "balance2", "pan1", "pan2"),
                "secondary_heading": "LEVEL & PAN",
                "switch_tooltip": "Enable the second IR in parallel",
                "switch_label": "Enable second IR",
                "status_label": "Second IR state",
            }
        return {
            "first_title": "NAM 1",
            "first_subtitle": "Primary model",
            "second_title": "NAM 2",
            "second_subtitle": "Dual amp \u00b7 runs in parallel",
            "secondary_params": ("pan1", "pan2"),
            "secondary_heading": "STEREO PLACEMENT",
            "switch_tooltip": "Enable the second NAM model in parallel",
            "switch_label": "Enable second NAM model",
            "status_label": "Second NAM model state",
        }

    def _make_dual_header(self, title: str, subtitle: str) -> Gtk.Box:
        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        labels = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=1)
        labels.set_hexpand(True)
        title_label = Gtk.Label(label=title, xalign=0)
        title_label.add_css_class("dual-card-title")
        labels.append(title_label)
        subtitle_label = Gtk.Label(label=subtitle, xalign=0)
        subtitle_label.add_css_class("dual-card-subtitle")
        labels.append(subtitle_label)
        header.append(labels)
        return header

    def _add_group_param_rows(self, body: Gtk.Box,
                              params: list[dict[str, Any]]) -> None:
        if not params:
            hint = Gtk.Label(label="No editable parameters", xalign=0)
            hint.add_css_class("dim-label")
            body.append(hint)
            return
        for param in self._order_dual_params(params):
            body.append(self._make_param_row(param))

    def _make_dual_card(self, title: str, subtitle: str,
                        params: list[dict[str, Any]]) -> Gtk.Widget:
        card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        card.add_css_class("dual-card")
        card.append(self._make_dual_header(title, subtitle))
        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        body.add_css_class("dual-card-body")
        self._add_group_param_rows(body, params)
        card.append(body)
        return card

    def _make_dual_secondary_card(self, dual_block: dict[str, Any],
                                  config: dict[str, Any]) -> Gtk.Widget:
        card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        card.add_css_class("dual-card")
        card.add_css_class("dual-card-secondary")

        header = self._make_dual_header(
            config["second_title"], config["second_subtitle"])
        status = Gtk.Label(label="?")
        status.add_css_class("status-chip")
        self._set_accessible_label(status, config["status_label"])
        header.append(status)

        switch = Gtk.Switch()
        switch.set_valign(Gtk.Align.CENTER)
        switch.set_tooltip_text(config["switch_tooltip"])
        self._set_accessible_label(switch, config["switch_label"])
        switch.connect("state-set", self._on_dual_switch)
        header.append(switch)

        body = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
        body.add_css_class("dual-card-body")
        params = list(dual_block["parameters"])
        secondary_names = config["secondary_params"]
        tone_params = [param for param in params
                       if param["name"] not in secondary_names]
        secondary_params = [param for param in params
                            if param["name"] in secondary_names]
        self._add_group_param_rows(body, tone_params)
        if secondary_params:
            body.append(Gtk.Separator())
            subhead = Gtk.Label(label=config["secondary_heading"], xalign=0)
            subhead.add_css_class("dual-subhead")
            body.append(subhead)
            for param in self._order_dual_params(secondary_params):
                body.append(self._make_param_row(param))

        expander = Gtk.Expander()
        expander.add_css_class("dual-expander")
        expander.set_label_widget(header)
        expander.set_child(body)
        card.append(expander)

        self._dual_card = card
        self._dual_expander = expander
        self._dual_switch = switch
        self._dual_status = status
        self._apply_dual_state(dual_block["enabled"], initial=True)
        return card

    def _render_dual_block(self, params: list[dict[str, Any]],
                           dual_block: dict[str, Any]) -> None:
        config = self._dual_ui_config(dual_block.get("kind", "nam"))
        self._details_dual_path = dual_block["path"]
        self.params_box.append(self._make_dual_card(
            config["first_title"], config["first_subtitle"], params))
        self.params_box.append(
            self._make_dual_secondary_card(dual_block, config))

    def _apply_dual_state(self, on: bool | None, *,
                          initial: bool = False,
                          sync_switch: bool = True) -> None:
        changed = initial or on != self._dual_on
        self._dual_on = on
        if self._dual_card is not None:
            if on is False:
                self._dual_card.add_css_class("dual-off")
            else:
                self._dual_card.remove_css_class("dual-off")
        if self._dual_status is not None:
            self._set_state_label(self._dual_status, on)
        if sync_switch and self._dual_switch is not None and \
                self._dual_switch.get_active() != bool(on):
            self._syncing = True
            try:
                self._dual_switch.set_active(bool(on))
            finally:
                self._syncing = False
        if changed and self._dual_expander is not None:
            self._dual_expander.set_expanded(on is not False)

    def _on_dual_switch(self, switch: Gtk.Switch, state: bool) -> bool:
        if self._syncing or self.device is None or self._busy:
            return True
        path = self._details_dual_path
        if path is None:
            return True
        on_path = path + r"\on_off"
        self._log("parallel section -> %s" % ("ON" if state else "OFF"))
        self._param_dirty.add(on_path)
        self._apply_dual_state(state, sync_switch=False)
        self._write_param(on_path, "ON" if state else "OFF")
        return False

    def _update_dual_state(self, device: stomp.Device) -> None:
        path = self._details_dual_path
        if path is None or self._dual_switch is None:
            return
        on_path = path + r"\on_off"
        if on_path in self._param_dirty:
            return
        value = device.get_value(on_path)
        if value == "ON":
            on: bool | None = True
        elif value == "OFF":
            on = False
        else:
            on = None
        self._apply_dual_state(on)

    def _update_details_switch(self, state: stomp.DeviceState) -> None:
        path = self._details_block_path
        if path is None:
            return
        block = next((b for b in state.blocks if b.path == path), None)
        if block is None:
            return
        self._set_state_label(self.details_status, block.on)
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
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        row.add_css_class("param-row")
        label_text = param.get("desc") or param["name"].replace("_", " ").title()
        name = Gtk.Label(label=label_text, xalign=0)
        name.add_css_class("param-label")
        name.set_size_request(110, -1)
        name.set_ellipsize(Pango.EllipsizeMode.END)
        name.set_tooltip_text(label_text)
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
            scale.set_tooltip_text(label_text)
            self._set_accessible_label(scale, label_text)
            self._syncing = True
            try:
                scale.set_value(float(value))
            finally:
                self._syncing = False
            value_label = Gtk.Label(label=self._fmt_param_value(value))
            value_label.add_css_class("value-label")
            value_label.set_size_request(46, -1)
            value_label.set_xalign(1)
            scale.connect("value-changed", self._on_param_scale_changed,
                          path, value_label)
            row.append(scale)
            row.append(value_label)
            self._param_controls[path] = {
                "kind": "scale", "widget": scale, "value_label": value_label,
            }
            return row

        if kind in ("enum", "choice"):
            options = param.get("options") or []
            dd = Gtk.DropDown.new_from_strings([str(o) for o in options])
            dd.set_hexpand(True)
            dd.set_tooltip_text(label_text)
            self._set_accessible_label(dd, label_text)
            if value in options:
                self._syncing = True
                try:
                    dd.set_selected(options.index(value))
                finally:
                    self._syncing = False
            dd.connect("notify::selected", self._on_param_enum_changed, path, options)
            row.append(dd)
            self._param_controls[path] = {
                "kind": "dropdown", "widget": dd, "options": options,
            }
            return row

        if kind == "number":
            spin = Gtk.SpinButton.new_with_range(-1e9, 1e9, 0.01)
            spin.set_hexpand(True)
            spin.set_tooltip_text(label_text)
            self._set_accessible_label(spin, label_text)
            self._syncing = True
            try:
                spin.set_value(float(value))
            finally:
                self._syncing = False
            spin.connect("value-changed", self._on_param_spin_changed, path)
            row.append(spin)
            self._param_controls[path] = {"kind": "spin", "widget": spin}
            return row

        if kind == "bool":
            spacer = Gtk.Box()
            spacer.set_hexpand(True)
            row.append(spacer)
            switch = Gtk.Switch()
            switch.set_hexpand(False)
            switch.set_valign(Gtk.Align.CENTER)
            switch.set_tooltip_text(label_text)
            self._set_accessible_label(switch, label_text)
            self._syncing = True
            try:
                switch.set_active(bool(value))
            finally:
                self._syncing = False
            switch.connect("state-set", self._on_param_bool, path)
            row.append(switch)
            self._param_controls[path] = {"kind": "switch", "widget": switch}
            return row

        entry = Gtk.Entry()
        entry.set_hexpand(True)
        entry.set_text("" if value is None else str(value))
        entry.set_tooltip_text(label_text)
        self._set_accessible_label(entry, label_text)
        entry.connect("activate", self._on_param_entry_activate, path, entry)
        row.append(entry)
        self._param_controls[path] = {"kind": "entry", "widget": entry}
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
        self._param_dirty.add(path)
        self._schedule_param(path, round(float(scale.get_value()), 6))

    def _on_param_spin_changed(self, spin: Gtk.SpinButton, path: str) -> None:
        if self._syncing or self.device is None:
            return
        self._param_dirty.add(path)
        self._schedule_param(path, round(float(spin.get_value()), 6))

    def _on_param_enum_changed(self, dropdown: Gtk.DropDown, _pspec, path: str,
                               options: list[str]) -> None:
        if self._syncing or self.device is None:
            return
        idx = dropdown.get_selected()
        if idx == Gtk.INVALID_LIST_POSITION or idx >= len(options):
            return
        self._param_dirty.add(path)
        self._write_param(path, options[idx])

    def _on_param_bool(self, switch: Gtk.Switch, state: bool, path: str) -> bool:
        if self._syncing or self.device is None:
            return True
        self._param_dirty.add(path)
        self._write_param(path, state)
        return False

    def _on_param_entry_activate(self, entry: Gtk.Entry, path: str,
                                 _entry: Gtk.Entry) -> None:
        if self.device is None:
            return
        self._param_dirty.add(path)
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
            finally:
                self._post(self._param_written, path)

        threading.Thread(target=worker, daemon=True).start()

    def _param_written(self, path: str) -> None:
        self._param_dirty.discard(path)

    def _update_param_values(self) -> None:
        """Refresh the parameter controls from the device cache.

        Called on each poll tick so changes made directly on the device are
        reflected in the selected-block editor.  Controls the user is actively
        editing are skipped.
        """
        path = self._details_block_path
        device = self.device
        if path is None or device is None:
            return
        try:
            params = device.get_block_parameters(path)
            if self._details_dual_path is not None:
                params += device.get_block_parameters(self._details_dual_path)
        except Exception:
            return
        by_path = {param["path"]: param for param in params}

        for param_path, control in list(self._param_controls.items()):
            if param_path in self._param_dirty:
                continue
            param = by_path.get(param_path)
            if param is None:
                continue
            value = param.get("value")
            kind = control["kind"]
            widget = control["widget"]

            if kind == "dropdown":
                options = control["options"]
                index = (options.index(value) if value in options
                         else Gtk.INVALID_LIST_POSITION)
                if widget.get_selected() != index:
                    self._syncing = True
                    try:
                        widget.set_selected(index)
                    finally:
                        self._syncing = False
            elif kind in ("scale", "spin"):
                if widget.has_focus():
                    continue
                try:
                    float_value = float(value)
                except (TypeError, ValueError):
                    continue
                self._syncing = True
                try:
                    widget.set_value(float_value)
                finally:
                    self._syncing = False
                if kind == "scale" and "value_label" in control:
                    control["value_label"].set_text(self._fmt_param_value(value))
            elif kind == "switch":
                self._syncing = True
                try:
                    widget.set_active(bool(value))
                finally:
                    self._syncing = False
            elif kind == "entry":
                if widget.has_focus():
                    continue
                self._syncing = True
                try:
                    widget.set_text("" if value is None else str(value))
                finally:
                    self._syncing = False

        self._update_dual_state(device)

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
            self.file_label.set_tooltip_text(None)
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
        display_name = "%s  (%s)" % (os.path.basename(path), size_text)
        self.file_label.set_text(display_name)
        self.file_label.set_tooltip_text(path)
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
        self.progress.set_visible(True)
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

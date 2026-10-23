#!/usr/bin/env python3
"""
stomp_ui_legacy.py -- GTK4 desktop UI for the Sonulab StompStation PRO.

This is the *original* GTK4 interface, kept as a debugging/backup tool.  The
current polished interface lives in ``stomp_ui.py``.

Run with::

    python3 stomp_ui_legacy.py
    python3 stomp.py --legacy

Requires PyGObject with GTK 4 (``python3-gi`` / ``gir1.2-gtk-4.0`` on
Debian/Ubuntu) and pyserial for the USB transport.
"""

from __future__ import annotations

import argparse
import os
import queue
import sys
import threading
import time
from typing import Any, Callable, Sequence

try:
    import gi
    gi.require_version("Gtk", "4.0")
    gi.require_version("Gdk", "4.0")
    from gi.repository import Gdk, Gio, GLib, Gtk, Pango
except (ImportError, ValueError) as exc:  # pragma: no cover
    print("The GTK4 UI requires PyGObject and GTK 4.\n"
          "Install them with: sudo apt install python3-gi gir1.2-gtk-4.0\n"
          "Details: %s" % exc, file=sys.stderr)
    raise SystemExit(1)

import stomp


CSS = b"""
.section-title { font-weight: bold; }
.block-on      { color: #26a269; font-weight: bold; }
.block-off     { color: #c01c28; }
.block-unknown { color: #77767b; }
.status-ok     { color: #26a269; font-weight: bold; }
.status-error  { color: #c01c28; font-weight: bold; }
.status-idle   { color: #77767b; }
.value-label   { font-family: monospace; }
.connect-status { font-weight: bold; }
"""


class StompWindow(Gtk.ApplicationWindow):
    def __init__(self, app: Gtk.Application,
                 initial_serial: str | None = None,
                 initial_tcp: str | None = None):
        super().__init__(application=app)
        self.set_title("StompStation Pro Control")
        self.set_default_size(1120, 780)
        self.set_size_request(880, 600)

        self._alive = True
        self._initial_serial = initial_serial
        self._initial_tcp = initial_tcp
        self._initial_attempts = 0
        self._initial_connect_done = False

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
        self._last_preset_value: str | None = None
        self._last_chain_signature: tuple[tuple[str, str], ...] | None = None
        self._block_rows: dict[str, tuple[Gtk.Switch, Gtk.Label]] = {}
        self._block_signature: tuple[tuple[str, str], ...] | None = None

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

        self._install_css()
        self._build_ui()
        self._update_sensitivity()
        self.connect("close-request", self._on_close)

        self._refresh_serial_ports()
        self._start_mdns_scan()
        GLib.timeout_add(250, self._tick)
        GLib.timeout_add(700, self._try_initial_connect)

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _install_css() -> None:
        provider = Gtk.CssProvider()
        provider.load_from_data(CSS)
        display = Gdk.Display.get_default()
        if display:
            Gtk.StyleContext.add_provider_for_display(
                display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    def _build_ui(self) -> None:
        header = Gtk.HeaderBar()
        title = Gtk.Label(label="StompStation Pro")
        title.add_css_class("section-title")
        header.set_title_widget(title)

        self.header_status = Gtk.Label(label="Disconnected")
        self.header_status.add_css_class("connect-status")
        self.header_status.add_css_class("status-idle")
        header.pack_end(self.header_status)

        self.set_titlebar(header)

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        outer.set_margin_top(10)
        outer.set_margin_bottom(10)
        outer.set_margin_start(12)
        outer.set_margin_end(12)
        self.set_child(outer)

        outer.append(self._build_connection_box())

        paned = Gtk.Paned(orientation=Gtk.Orientation.HORIZONTAL)
        paned.set_wide_handle(True)
        paned.set_position(570)
        paned.set_vexpand(True)
        outer.append(paned)

        left = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        left.set_size_request(480, -1)
        paned.set_start_child(left)
        paned.set_resize_start_child(True)

        right = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        right.set_size_request(380, -1)
        paned.set_end_child(right)
        paned.set_resize_end_child(True)
        paned.set_shrink_start_child(False)
        paned.set_shrink_end_child(False)

        left.append(self._build_info_box())
        left.append(self._build_patch_box())
        left.append(self._build_blocks_box())
        left.append(self._build_master_box())

        right.append(self._build_upload_box())
        right.append(self._build_log_box())

        status_bar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.spinner = Gtk.Spinner()
        self.spinner.set_visible(False)
        status_bar.append(self.spinner)
        self.status_label = Gtk.Label(label="Ready", xalign=0)
        self.status_label.set_hexpand(True)
        self.status_label.set_ellipsize(Pango.EllipsizeMode.END)
        status_bar.append(self.status_label)
        outer.append(status_bar)

    @staticmethod
    def _section(title: str) -> tuple[Gtk.Frame, Gtk.Box]:
        frame = Gtk.Frame(label=title)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
        box.set_margin_top(8)
        box.set_margin_bottom(8)
        box.set_margin_start(8)
        box.set_margin_end(8)
        frame.set_child(box)
        return frame, box

    def _build_connection_box(self) -> Gtk.Widget:
        frame, box = self._section("Device connection")

        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(row)

        row.append(Gtk.Label(label="Transport:"))
        self.mode_dd = Gtk.DropDown.new_from_strings(
            ["USB serial", "Network (mDNS / TCP)"])
        self.mode_dd.connect("notify::selected", self._on_mode_changed)
        row.append(self.mode_dd)

        self.mode_stack = Gtk.Stack()
        self.mode_stack.set_hexpand(True)
        self.mode_stack.set_transition_type(Gtk.StackTransitionType.NONE)
        row.append(self.mode_stack)

        serial_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        serial_box.append(Gtk.Label(label="Port:"))
        self.port_dd = Gtk.DropDown.new_from_strings(["Scanning..."])
        self.port_dd.set_hexpand(True)
        serial_box.append(self.port_dd)
        self.port_refresh_btn = Gtk.Button.new_with_label("Refresh")
        self.port_refresh_btn.connect("clicked", lambda *_: self._refresh_serial_ports())
        serial_box.append(self.port_refresh_btn)
        self.mode_stack.add_named(serial_box, "serial")

        network_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        network_box.append(Gtk.Label(label="Found:"))
        self.mdns_dd = Gtk.DropDown.new_from_strings(["Scanning..."])
        self.mdns_dd.set_hexpand(True)
        network_box.append(self.mdns_dd)
        self.scan_btn = Gtk.Button.new_with_label("Scan")
        self.scan_btn.connect("clicked", lambda *_: self._start_mdns_scan())
        network_box.append(self.scan_btn)
        network_box.append(Gtk.Label(label="or"))
        self.tcp_entry = Gtk.Entry()
        self.tcp_entry.set_placeholder_text("host:port")
        self.tcp_entry.set_width_chars(22)
        self.tcp_entry.set_tooltip_text(
            "Optional manual address. Overrides the discovered device above.")
        network_box.append(self.tcp_entry)
        self.mode_stack.add_named(network_box, "network")

        self.connect_btn = Gtk.Button.new_with_label("Connect")
        self.connect_btn.add_css_class("suggested-action")
        self.connect_btn.connect("clicked", lambda *_: self._on_connect_clicked())
        row.append(self.connect_btn)

        self.disconnect_btn = Gtk.Button.new_with_label("Disconnect")
        self.disconnect_btn.set_sensitive(False)
        self.disconnect_btn.connect("clicked", lambda *_: self._on_disconnect_clicked())
        row.append(self.disconnect_btn)

        self.connection_detail = Gtk.Label(label="Not connected", xalign=0)
        self.connection_detail.add_css_class("status-idle")
        box.append(self.connection_detail)

        return frame

    def _build_info_box(self) -> Gtk.Widget:
        frame, box = self._section("Device")
        self.info_label = Gtk.Label(label="Not connected", xalign=0)
        self.info_label.set_selectable(True)
        self.info_label.set_wrap(True)
        box.append(self.info_label)
        self.meter_label = Gtk.Label(label="", xalign=0)
        self.meter_label.add_css_class("value-label")
        box.append(self.meter_label)
        return frame

    def _build_patch_box(self) -> Gtk.Widget:
        frame, box = self._section("Patch")
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        box.append(row)

        self.prev_btn = Gtk.Button.new_with_label("\u25c0")
        self.prev_btn.set_tooltip_text("Previous patch")
        self.prev_btn.connect("clicked", lambda *_: self._step_patch(-1))
        row.append(self.prev_btn)

        self.patch_dd = Gtk.DropDown.new_from_strings([])
        self.patch_dd.set_hexpand(True)
        self.patch_dd.connect("notify::selected", self._on_patch_selected)
        row.append(self.patch_dd)

        self.next_btn = Gtk.Button.new_with_label("\u25b6")
        self.next_btn.set_tooltip_text("Next patch")
        self.next_btn.connect("clicked", lambda *_: self._step_patch(1))
        row.append(self.next_btn)

        self.patch_refresh_btn = Gtk.Button.new_with_label("Reload")
        self.patch_refresh_btn.connect("clicked", lambda *_: self._refresh_all_async())
        row.append(self.patch_refresh_btn)

        self.patch_save_btn = Gtk.Button.new_with_label("Save")
        self.patch_save_btn.set_tooltip_text("Save the current settings into this patch slot")
        self.patch_save_btn.connect("clicked", lambda *_: self._save_patch())
        row.append(self.patch_save_btn)

        self.patch_status = Gtk.Label(label="", xalign=0)
        self.patch_status.set_ellipsize(Pango.EllipsizeMode.END)
        box.append(self.patch_status)
        return frame

    def _build_blocks_box(self) -> Gtk.Widget:
        frame, box = self._section("Signal chain")
        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_min_content_height(230)
        scrolled.set_vexpand(True)
        self.blocks_list = Gtk.ListBox()
        self.blocks_list.set_selection_mode(Gtk.SelectionMode.NONE)
        self.blocks_list.add_css_class("boxed-list")
        self.blocks_list.set_show_separators(True)
        scrolled.set_child(self.blocks_list)
        box.append(scrolled)

        hint = Gtk.Label(
            label="Switch a block on or off. The chain order is read from the "
                  "device's router.", xalign=0)
        hint.add_css_class("dim-label")
        hint.set_wrap(True)
        box.append(hint)
        return frame

    def _build_master_box(self) -> Gtk.Widget:
        frame, box = self._section("Master")
        self.master_frame = frame

        vol_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(vol_row)
        vol_row.append(Gtk.Label(label="Volume", xalign=0))
        self.volume_scale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, 0.0, 100.0, 1.0)
        self.volume_scale.set_hexpand(True)
        self.volume_scale.set_size_request(120, 24)
        self.volume_scale.set_draw_value(False)
        self.volume_scale.connect("value-changed", self._on_volume_changed)
        vol_row.append(self.volume_scale)
        self.volume_value_label = Gtk.Label(label="--")
        self.volume_value_label.add_css_class("value-label")
        self.volume_value_label.set_size_request(52, -1)
        vol_row.append(self.volume_value_label)

        tempo_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(tempo_row)
        tempo_row.append(Gtk.Label(label="Tempo", xalign=0))
        self.tempo_spin = Gtk.SpinButton.new_with_range(20.0, 300.0, 1.0)
        self.tempo_spin.set_hexpand(False)
        self.tempo_spin.connect("value-changed", self._on_tempo_changed)
        tempo_row.append(self.tempo_spin)
        tempo_row.append(Gtk.Label(label="BPM", xalign=0))

        self._set_master_visible(False)
        return frame

    def _build_upload_box(self) -> Gtk.Widget:
        frame, box = self._section("Load model / IR")

        target_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(target_row)
        target_row.append(Gtk.Label(label="Target", xalign=0))
        self.target_dd = Gtk.DropDown.new_from_strings(["Waiting for device..."])
        self.target_dd.set_hexpand(True)
        self.target_dd.connect("notify::selected", self._on_target_changed)
        target_row.append(self.target_dd)

        slot_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(slot_row)
        slot_row.append(Gtk.Label(label="Slot", xalign=0))
        self.slot_dd = Gtk.DropDown.new_from_strings(["--"])
        self.slot_dd.set_hexpand(True)
        self.slot_dd.connect("notify::selected", self._on_slot_changed)
        slot_row.append(self.slot_dd)

        file_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(file_row)
        self.file_btn = Gtk.Button.new_with_label("Choose file...")
        self.file_btn.connect("clicked", lambda *_: self._choose_file())
        file_row.append(self.file_btn)
        self.file_label = Gtk.Label(label="No file selected", xalign=0)
        self.file_label.set_hexpand(True)
        self.file_label.set_ellipsize(Pango.EllipsizeMode.MIDDLE)
        file_row.append(self.file_label)

        self.upload_btn = Gtk.Button.new_with_label("Upload")
        self.upload_btn.add_css_class("suggested-action")
        self.upload_btn.set_sensitive(False)
        self.upload_btn.connect("clicked", lambda *_: self._on_upload_clicked())
        box.append(self.upload_btn)

        self.progress = Gtk.ProgressBar()
        self.progress.set_show_text(True)
        self.progress.set_text("Idle")
        box.append(self.progress)

        hint = Gtk.Label(
            label="NAM: chunk 0 carries the 128-byte display name, then the "
                  "zero-padded/gzipped model is sent with per-chunk ACKs. Some "
                  "firmware rejects uploads to empty NAM slots; overwriting a "
                  "used slot is more reliable.", xalign=0)
        hint.add_css_class("dim-label")
        hint.set_wrap(True)
        box.append(hint)

        return frame

    def _build_log_box(self) -> Gtk.Widget:
        frame, box = self._section("Activity")
        frame.set_vexpand(True)

        toolbar = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        box.append(toolbar)
        spacer = Gtk.Box()
        spacer.set_hexpand(True)
        toolbar.append(spacer)
        clear_btn = Gtk.Button.new_with_label("Clear")
        clear_btn.connect("clicked", lambda *_: self._clear_log())
        toolbar.append(clear_btn)

        scrolled = Gtk.ScrolledWindow()
        scrolled.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC)
        scrolled.set_vexpand(True)
        scrolled.set_min_content_height(180)
        self.log_view = Gtk.TextView()
        self.log_view.set_editable(False)
        self.log_view.set_cursor_visible(False)
        self.log_view.set_monospace(True)
        self.log_view.set_wrap_mode(Gtk.WrapMode.WORD_CHAR)
        self.log_view.set_left_margin(6)
        self.log_view.set_right_margin(6)
        self.log_view.set_top_margin(6)
        self.log_view.set_bottom_margin(6)
        scrolled.set_child(self.log_view)
        box.append(scrolled)
        return frame

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
        text = "\n".join(lines) + "\n"
        buffer.insert(buffer.get_end_iter(), text)

        # Keep the log bounded.
        if buffer.get_line_count() > 2500:
            start = buffer.get_start_iter()
            cut = buffer.get_iter_at_line(max(0, buffer.get_line_count() - 2000))
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

        self.connect_btn.set_sensitive(not connected and idle)
        self.disconnect_btn.set_sensitive(connected and idle)
        self.port_dd.set_sensitive(not connected and idle)
        self.port_refresh_btn.set_sensitive(not connected and idle)
        self.mode_dd.set_sensitive(not connected and idle)
        self.mdns_dd.set_sensitive(not connected and idle)
        self.scan_btn.set_sensitive(not connected and idle)
        self.tcp_entry.set_sensitive(not connected and idle)

        for widget in (self.patch_dd, self.prev_btn, self.next_btn,
                       self.patch_refresh_btn, self.patch_save_btn):
            widget.set_sensitive(connected and idle)
        self.blocks_list.set_sensitive(connected and idle)
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
        self.mode_stack.set_visible_child_name("network" if idx == 1 else "serial")
        if idx == 1 and not self._discovered:
            self._start_mdns_scan()

    def _refresh_serial_ports(self) -> None:
        def worker() -> None:
            ports = stomp.list_serial_ports()
            self._post(self._update_serial_ports, ports)
        threading.Thread(target=worker, daemon=True).start()

    def _update_serial_ports(self, ports: list[tuple[str, str]]) -> None:
        self._serial_ports = ports
        if not ports:
            labels = ["No serial ports found"]
        else:
            labels = ["%s  -  %s" % (dev, desc) if desc else dev
                      for dev, desc in ports]

        self.port_dd.set_model(Gtk.StringList.new(labels))
        if ports:
            usb_indexes = [i for i, (dev, _desc) in enumerate(ports)
                           if stomp.is_usb_serial_device(dev)]
            self.port_dd.set_selected(usb_indexes[0] if usb_indexes else 0)
            if not usb_indexes:
                self._log("no USB CDC-ACM port found; the listed ports are "
                          "usually not the pedal")
        self.port_dd.set_sensitive(bool(ports) and not self._busy)

        diagnostic = stomp.usb_diagnostic_message()
        if diagnostic:
            self._log(diagnostic)

        if not ports:
            self._log("no serial ports detected (is the pedal connected and "
                      "are you in the dialout group?)")

    def _start_mdns_scan(self) -> None:
        if self._scanning:
            return
        self._scanning = True
        self.mdns_dd.set_model(Gtk.StringList.new(["Scanning..."]))
        self.scan_btn.set_sensitive(False)
        self._log("scanning mDNS for _http._tcp devices...")

        def worker() -> None:
            try:
                devices = stomp.discover_mdns(timeout=2.5)
            except Exception as exc:  # pragma: no cover - network dependent
                devices = []
                self._log_threadsafe("mDNS scan failed: %s" % exc)
            self._post(self._update_discovered, devices)

        threading.Thread(target=worker, daemon=True).start()

    def _update_discovered(self, devices: list[stomp.DiscoveredDevice]) -> None:
        self._scanning = False
        self.scan_btn.set_sensitive(True)
        valid = [d for d in devices if d.valid]
        visible = valid or devices
        self._discovered = visible

        if not visible:
            self.mdns_dd.set_model(Gtk.StringList.new(["No devices found"]))
            self._log("mDNS scan complete: no _http._tcp devices found")
            return

        self.mdns_dd.set_model(Gtk.StringList.new([d.description for d in visible]))
        self.mdns_dd.set_selected(0)
        self._log("mDNS scan complete: %d device(s)%s" % (
            len(visible), "" if valid else " (none had a VoidX id tag)"))

    def _parse_tcp_entry(self) -> tuple[str, int]:
        text = self.tcp_entry.get_text().strip()
        if text:
            return stomp.parse_host_port(text)
        idx = self.mdns_dd.get_selected()
        if idx == Gtk.INVALID_LIST_POSITION or idx >= len(self._discovered):
            raise ValueError("choose a discovered device or enter host:port")
        device = self._discovered[idx]
        return device.host, device.port

    def _on_connect_clicked(self) -> None:
        if self.device is not None or self._busy:
            return
        mode = self.mode_dd.get_selected()
        try:
            if mode == 0:
                idx = self.port_dd.get_selected()
                if idx == Gtk.INVALID_LIST_POSITION or idx >= len(self._serial_ports):
                    raise ValueError("no USB serial port selected")
                port = self._serial_ports[idx][0]
                transport: stomp.Transport = stomp.SerialTransport(port)
            else:
                host, port_num = self._parse_tcp_entry()
                transport = stomp.TCPTransport(host, port_num)
        except Exception as exc:
            self._log("connection error: %s" % exc)
            self._set_status(str(exc), error=True)
            return
        self._connect_transport(transport)

    def _connect_transport(self, transport: stomp.Transport) -> None:
        self._set_busy(True, "Connecting to %s..." % transport.description)
        self.connection_detail.set_text("Connecting to %s..." % transport.description)

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
        self.connection_detail.set_text("Connected via %s" % device.transport.description)
        self.connection_detail.remove_css_class("status-idle")
        self.connection_detail.add_css_class("status-ok")
        self._set_header_status("Connected", True)
        self._first_state(device)

    def _on_connect_failed(self, error: str) -> None:
        self._set_busy(False, "Connection failed")
        self.connection_detail.set_text("Connection failed")
        self.connection_detail.remove_css_class("status-ok")
        self.connection_detail.add_css_class("status-error")
        self._set_header_status("Disconnected", False)
        self._log("connection failed: %s" % error)
        self._set_status(error, error=True)
        self._update_sensitivity()

    def _on_disconnect_clicked(self) -> None:
        self._disconnect("Disconnected")

    def _disconnect(self, message: str) -> None:
        device, self.device = self.device, None
        self._set_busy(True, message)
        self._set_header_status("Disconnected", False)
        self.connection_detail.set_text(message)
        self.connection_detail.remove_css_class("status-ok")
        self.connection_detail.remove_css_class("status-error")
        self.connection_detail.add_css_class("status-idle")

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
        self._last_preset_value = None
        self._last_chain_signature = None
        self._patch_dd_model([])
        self._clear_blocks()
        self._set_master_visible(False)
        self._volume_dirty = False
        self._tempo_dirty = False
        self._targets = []
        self._target_signature = None
        self._selected_target = None
        self._slot_names = []
        self._slot_signature = None
        self.progress.set_fraction(0.0)
        self.progress.set_text("Idle")
        self.info_label.set_text("Not connected")
        self.meter_label.set_text("")
        self.patch_status.set_text("")
        self._log("disconnected")
        self._update_sensitivity()

    def _on_connection_lost(self) -> None:
        self._log("device connection was lost")
        self._set_status("Connection lost", error=True)
        self._disconnect("Connection lost")

    def _first_state(self, device: stomp.Device) -> None:
        # Device.connect() has already loaded a snapshot.  Render it now and
        # then do a background refresh to pick up anything that arrived late.
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
                    # Baseline the "last seen" values to the freshly loaded
                    # state so the next poll tick does not mistake our own
                    # re-browse for an external change.
                    self._last_preset_value = state.preset.current
                    self._last_chain_signature = self._chain_signature(state.blocks)
                    self._render_state(state)
        self._update_sensitivity()

    # ------------------------------------------------------------------
    # Periodic UI update
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

    def _render_state(self, state: stomp.DeviceState) -> None:
        self._state = state

        bits = []
        if state.device_name:
            bits.append(state.device_name)
        if state.firmware:
            bits.append("firmware %s" % state.firmware)
        if state.usb_status:
            bits.append("USB %s" % state.usb_status)
        self.info_label.set_text("  |  ".join(bits) if bits else "Connected")

        meters = []
        if state.meter_in is not None:
            meters.append("IN %6.1f dB" % state.meter_in)
        if state.meter_out is not None:
            meters.append("OUT %6.1f dB" % state.meter_out)
        self.meter_label.set_text("   ".join(meters))

        self._render_patch(state.preset)
        self._render_blocks(state.blocks)
        self._render_master(state.volume, state.tempo)
        self._render_targets(state)
        self._update_sensitivity()

        # Detect changes made on the device itself (footswitch, chain edits,
        # preset changes from another controller, ...) and re-browse so the
        # full chain, block states, and lists are reloaded.
        chain_signature = self._chain_signature(state.blocks)
        chain_changed = (self._last_chain_signature is not None and
                         chain_signature != self._last_chain_signature)

        current_preset = state.preset.current
        preset_changed = (self._last_preset_value is not None and
                          current_preset != self._last_preset_value)

        if (preset_changed or chain_changed) and not self._busy and \
                not self._refresh_running:
            if preset_changed:
                self._log("preset changed externally to %r; refreshing" %
                          current_preset)
            else:
                self._log("signal chain changed externally; refreshing")
            GLib.idle_add(self._refresh_all_async)

        self._last_preset_value = current_preset
        self._last_chain_signature = chain_signature

    def _render_patch(self, preset: stomp.PresetState) -> None:
        names = [name for name in preset.names if name]
        if tuple(names) != tuple(self._patch_names):
            self._patch_names = names
            self._patch_dd_model(names)

        if preset.current:
            self.patch_status.set_text("Current: %s" % preset.current)
        else:
            self.patch_status.set_text("Current patch unknown")

        idx = names.index(preset.current) if preset.current in names else Gtk.INVALID_LIST_POSITION
        self._syncing = True
        try:
            if self.patch_dd.get_selected() != idx:
                if idx == Gtk.INVALID_LIST_POSITION:
                    self.patch_dd.set_selected(Gtk.INVALID_LIST_POSITION)
                else:
                    self.patch_dd.set_selected(idx)
        finally:
            self._syncing = False

    def _patch_dd_model(self, names: list[str]) -> None:
        self._syncing = True
        try:
            self.patch_dd.set_model(Gtk.StringList.new(names))
        finally:
            self._syncing = False

    @staticmethod
    def _chain_signature(blocks: list[stomp.BlockState]) -> tuple[tuple[str, str], ...]:
        return tuple((block.path, block.label) for block in blocks)

    def _render_blocks(self, blocks: list[stomp.BlockState]) -> None:
        signature = self._chain_signature(blocks)
        if signature != self._block_signature:
            self._clear_blocks()
            self._block_signature = signature
            for block in blocks:
                self._add_block_row(block)

        for block in blocks:
            row = self._block_rows.get(block.path)
            if row is None:
                continue
            switch, state_label = row
            self._syncing = True
            try:
                if block.on is not None:
                    switch.set_active(block.on)
                else:
                    switch.set_active(False)
            finally:
                self._syncing = False
            switch.set_sensitive(block.on is not None and not self._busy)
            state_label.set_text("ON" if block.on else ("OFF" if block.on is False else "?"))
            for cls in ("block-on", "block-off", "block-unknown"):
                state_label.remove_css_class(cls)
            state_label.add_css_class(
                "block-on" if block.on else
                ("block-off" if block.on is False else "block-unknown"))

    def _clear_blocks(self) -> None:
        child = self.blocks_list.get_first_child()
        while child is not None:
            next_child = child.get_next_sibling()
            self.blocks_list.remove(child)
            child = next_child
        self._block_rows.clear()
        self._block_signature = None

    def _add_block_row(self, block: stomp.BlockState) -> None:
        row = Gtk.ListBoxRow()
        row.set_activatable(False)
        row.set_tooltip_text(block.path)
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        box.set_margin_top(5)
        box.set_margin_bottom(5)
        box.set_margin_start(8)
        box.set_margin_end(8)

        label = Gtk.Label(label=block.label, xalign=0)
        label.set_hexpand(True)
        label.set_ellipsize(Pango.EllipsizeMode.END)
        box.append(label)

        state_label = Gtk.Label(label="?", xalign=1)
        state_label.set_size_request(38, -1)
        state_label.add_css_class("block-unknown")
        box.append(state_label)

        switch = Gtk.Switch()
        switch.set_valign(Gtk.Align.CENTER)
        switch.set_active(bool(block.on))
        switch.set_sensitive(block.on is not None)
        switch.connect("state-set", self._on_block_state_set, block.path, block.label)
        box.append(switch)

        row.set_child(box)
        self.blocks_list.append(row)
        self._block_rows[block.path] = (switch, state_label)

    def _render_master(self, volume: stomp.ControlState | None,
                       tempo: stomp.ControlState | None) -> None:
        self._set_master_visible(volume is not None or tempo is not None)

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
            self._volume_dirty = False

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
            self._tempo_dirty = False

        self._master_volume = volume
        self._master_tempo = tempo

    def _set_master_visible(self, visible: bool) -> None:
        self.master_frame.set_visible(visible)
        self.volume_scale.set_visible(visible)
        self.volume_value_label.set_visible(visible)
        self.tempo_spin.set_visible(visible)

    # ------------------------------------------------------------------
    # Patch actions
    # ------------------------------------------------------------------

    def _on_patch_selected(self, dropdown: Gtk.DropDown, _pspec) -> None:
        if self._syncing or self.device is None:
            return
        idx = dropdown.get_selected()
        if idx == Gtk.INVALID_LIST_POSITION or idx >= len(self._patch_names):
            return
        name = self._patch_names[idx]
        current = self._state.preset.current if self._state else ""
        if name == current:
            return
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
        self._set_status("Loading patch %r..." % name)
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
    # Block actions
    # ------------------------------------------------------------------

    def _on_block_state_set(self, switch: Gtk.Switch, state: bool,
                            path: str, label: str) -> bool:
        if self._syncing or self.device is None or self._busy:
            return True
        self._set_status("%s %s..." % (label, "on" if state else "off"))
        self._log("%s -> %s" % (label, "ON" if state else "OFF"))

        def worker() -> None:
            try:
                self.device.set_block(path, state)
                self._post(self._block_done, label, state, None)
            except Exception as exc:
                self._post(self._block_done, label, state, str(exc))

        threading.Thread(target=worker, daemon=True).start()
        return False  # let the switch animate immediately

    def _block_done(self, label: str, state: bool, error: str | None) -> None:
        if error:
            self._log("%s toggle failed: %s" % (label, error))
            self._set_status(error, error=True)
            self._refresh_all_async()
        else:
            self._set_status("%s %s" % (label, "enabled" if state else "disabled"))

    # ------------------------------------------------------------------
    # Master controls
    # ------------------------------------------------------------------

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
            size = os.path.getsize(path)
            size_text = "%d KiB" % (size // 1024)
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
        if self._initial_connect_done or self._busy or self.device is not None:
            return False
        self._initial_connect_done = True

        if self._initial_tcp:
            self.mode_dd.set_selected(1)
            self.tcp_entry.set_text(self._initial_tcp)
            self._connect_from_initial()
            return False
        if self._initial_serial:
            self.mode_dd.set_selected(0)
            devices = [dev for dev, _ in self._serial_ports]
            if self._initial_serial in devices:
                self.port_dd.set_selected(devices.index(self._initial_serial))
            else:
                # Add the requested port even if enumeration has not found it.
                self._serial_ports = [(self._initial_serial, "requested")] + self._serial_ports
                self.port_dd.set_model(Gtk.StringList.new(
                    ["%s  -  requested" % self._initial_serial] +
                    ["%s  -  %s" % (d, s) if s else d
                     for d, s in self._serial_ports[1:]]))
                self.port_dd.set_selected(0)
            self._connect_from_initial()
            return False
        return False

    def _connect_from_initial(self) -> None:
        # Delay one turn so the mode stack has switched.
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


class StompApplication(Gtk.Application):
    def __init__(self, initial_serial: str | None = None,
                 initial_tcp: str | None = None):
        super().__init__(
            application_id="io.github.stompstation.control.legacy",
            flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        self._initial_serial = initial_serial
        self._initial_tcp = initial_tcp
        self.window: StompWindow | None = None

    def do_activate(self) -> None:
        if self.window is None:
            self.window = StompWindow(self, self._initial_serial, self._initial_tcp)
        self.window.present()

    def do_shutdown(self) -> None:
        if self.window is not None:
            self.window.shutdown()
        Gio.Application.do_shutdown(self)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="StompStation Pro controller (GTK4 UI)")
    parser.add_argument("port", nargs="?", metavar="PORT",
                        help="legacy positional USB serial port "
                             "(same as --serial)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--serial", metavar="PORT",
                       help="connect to a USB serial port (e.g. /dev/ttyACM0)")
    group.add_argument("--tcp", metavar="HOST:PORT",
                       help="connect to a network address")
    args = parser.parse_args(list(argv) if argv is not None else None)

    serial_port = args.serial or args.port
    if serial_port and args.tcp:
        parser.error("choose either a serial port or --tcp, not both")

    app = StompApplication(serial_port, args.tcp)
    return app.run([sys.argv[0]])


if __name__ == "__main__":
    raise SystemExit(main())

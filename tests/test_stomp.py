"""Unit tests for the StompStation PRO client.

Run with::

    python3 -m unittest discover -s tests -v
"""

import gzip
import json
import os
import struct
import tempfile
import unittest
import wave

import stomp


def compact(value):
    return json.dumps(value, separators=(",", ":"))


def base_nodes():
    return {
        "root": {"type": "root", "value": ""},
        "root\\app": {"type": "item", "item_type": "module", "value": ""},
        "root\\app\\preset": {"type": "plist", "value": "Patch B",
                              "ref": "root\\presets"},
        "root\\presets": {"type": "list", "item_type": "pst_pst",
                          "value": ["Patch A", "Patch B", ""]},
        "root\\app\\router": {
            "type": "router",
            "value": [["root\\app\\gate", "s", "root\\app\\drive"],
                      ["root\\app\\amp", ""]],
        },
        "root\\app\\gate": {"type": "item", "item_type": "block",
                            "desc": "Gate"},
        "root\\app\\gate\\on_off": {"type": "enum", "value": "ON",
                                    "options": ["ON", "A", "B", "OFF"]},
        "root\\app\\drive": {"type": "item", "item_type": "block",
                             "desc": "Drive"},
        "root\\app\\drive\\on_off": {"type": "enum", "value": "OFF",
                                     "options": ["ON", "A", "B", "OFF"]},
        "root\\app\\amp": {"type": "item", "item_type": "block",
                           "desc": "Amp"},
        "root\\app\\amp\\on_off": {"type": "enum", "value": "ON",
                                   "options": ["ON", "A", "B", "OFF"]},
        "root\\app\\output": {"type": "item", "value": ""},
        "root\\app\\output\\vol": {"type": "float", "value": 75.0,
                                   "min": 0, "max": 100},
        "root\\app\\output\\tempo_bpm": {"type": "float", "value": 120.0,
                                         "min": 20, "max": 300},
        "root\\sys\\_name": {"type": "item", "value": "StompStation PRO"},
        "root\\sys\\_ver": {"type": "item", "value": "2.2.6"},
        "root\\sys\\_id": {"type": "item", "value": "test-id"},
        "root\\usb\\_status": {"type": "item", "value": "ON"},
        "root\\nam_amp": {"type": "list", "item_type": "wav",
                          "value": ["old amp"] + [""] * 63},
        "root\\nam_drive": {"type": "list", "item_type": "wav",
                            "value": [""] * 64},
        "root\\ir_list": {"type": "list", "item_type": "wav",
                          "value": ["old ir"] + [""] * 63},
    }


class FakeTransport(stomp.Transport):
    """A tiny in-memory device speaking the same framing."""

    description = "fake device"

    def __init__(self, nodes=None):
        self.nodes = base_nodes() if nodes is None else nodes
        self.commands = []
        self.dwrites = []
        self.buffer = bytearray()
        self._emit_empty_initial = True

    def open(self):
        pass

    def close(self):
        pass

    def write(self, data):
        if not data.endswith(b"\0"):
            raise AssertionError("command is not NUL terminated")
        raw = data[:-1]
        if raw.endswith(b"\r\n"):
            raw = raw[:-2]
        command = raw.decode("utf-8")
        self.commands.append(command)

        if command == "browse root":
            lines = [path + ":" + compact(node)
                     for path, node in self.nodes.items()]
            self.buffer.extend(("\r\n".join(lines) + "\0").encode())
        elif command.startswith("read "):
            path = command[5:]
            node = self.nodes.get(path)
            if node is not None:
                self.buffer.extend((path + ":" + compact(node) + "\0").encode())
            else:
                self.buffer.extend(b"\0")
        elif command.startswith("write "):
            body = command[6:]
            path, _, payload = body.partition(":")
            obj = json.loads(payload)
            if path in self.nodes:
                self.nodes[path]["value"] = obj.get("value")
            self.buffer.extend((path + ":" + compact(obj) + "\0").encode())
        elif command.startswith("dwrite "):
            body = command[7:]
            path, _, payload = body.partition(":")
            obj = json.loads(payload)
            self.dwrites.append((path, obj))
            value = str(obj.get("value", ""))
            done = "gz" in value or (path.endswith("ir_list") and
                                     obj.get("chunk") == 8)
            ack = -1 if done else int(obj.get("chunk", 0)) + 1
            self.buffer.extend((
                "dwrite " + path + ":" +
                compact({"index": obj.get("index", -1), "chunk": ack}) + "\0"
            ).encode())
        else:
            self.buffer.extend(b"\0")

    def read(self, size, timeout):
        if self._emit_empty_initial:
            self._emit_empty_initial = False
            return b"\0"
        if self.buffer:
            data = bytes(self.buffer[:size])
            del self.buffer[:size]
            return data
        return b""


def make_device(nodes=None):
    transport = FakeTransport(nodes)
    device = stomp.Device(transport, log=lambda _message: None)
    device.connect()
    return device, transport


class ParseTests(unittest.TestCase):
    def test_parse_message_values(self):
        lines = stomp.parse_message(
            'root\\app\\preset:{"value":" Dookie"}\r\n'
            'root\\app\\drive\\on_off:{"value":"ON"}\r\n')
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0].path, r"root\app\preset")
        self.assertEqual(lines[0].obj["value"], " Dookie")
        self.assertIsNone(lines[0].command)
        self.assertEqual(lines[1].obj["value"], "ON")

    def test_parse_dwrite_ack(self):
        lines = stomp.parse_message(
            'dwrite root\\nam_amp:{"index":22,"chunk":1}\r\n')
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0].command, "dwrite")
        self.assertEqual(lines[0].path, r"root\nam_amp")
        self.assertEqual(lines[0].obj, {"index": 22, "chunk": 1})

    def test_parse_token(self):
        lines = stomp.parse_message("token abcdef0123456789 Y\r\n")
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0].command, "token")
        self.assertTrue(lines[0].obj["secure"])
        self.assertEqual(lines[0].obj["nonce"], "abcdef0123456789")

    def test_flatten_router_matrix_and_flat(self):
        matrix = [["root\\\\app\\\\gate", "s", "root\\\\app\\\\amp"],
                  ["", "root\\\\app\\\\ir"]]
        self.assertEqual(stomp.flatten_router(matrix),
                         [r"root\app\gate", r"root\app\amp", r"root\app\ir"])
        flat = ["root\\app\\gate", "s", "", "root\\app\\delay"]
        self.assertEqual(stomp.flatten_router(flat),
                         [r"root\app\gate", r"root\app\delay"])

    def test_parse_host_port(self):
        self.assertEqual(stomp.parse_host_port("192.168.1.5:8080"),
                         ("192.168.1.5", 8080))
        self.assertEqual(stomp.parse_host_port("[fe80::1]:8080"),
                         ("fe80::1", 8080))


class DeviceStateTests(unittest.TestCase):
    def test_connect_and_discover_state(self):
        device, _ = make_device()
        self.assertTrue(device.connected)
        state = device.state()
        self.assertEqual(state.device_name, "StompStation PRO")
        self.assertEqual(state.firmware, "2.2.6")
        self.assertEqual(state.preset.current, "Patch B")
        self.assertEqual(state.preset.list_path, r"root\presets")
        self.assertEqual([block.label for block in state.blocks],
                         ["Noise Gate", "Drive / Distortion", "Amp (NAM)"])
        self.assertEqual([block.on for block in state.blocks],
                         [True, False, True])
        self.assertIsNotNone(state.volume)
        self.assertEqual(state.volume.value, 75.0)
        self.assertIsNotNone(state.tempo)
        device.close()

    def test_set_block_and_save_preset(self):
        device, transport = make_device()
        device.set_block(r"root\app\drive", True)
        self.assertIn(
            'write root\\app\\drive\\on_off:{"value":"ON"}', transport.commands)
        self.assertTrue(device.state().blocks[1].on)

        device.save_preset()
        self.assertIn(
            'write root\\app\\preset:{"value":"Patch B","save":"save"}',
            transport.commands)
        device.close()

    def test_preset_state_without_metadata(self):
        nodes = {
            r"root\app\preset": {"value": "Current"},
            r"root\presets": {"value": ["Current", "Other"]},
        }
        # No browse metadata; this is the read-root-only fallback.
        transport = FakeTransport(nodes)
        device = stomp.Device(transport, log=lambda _message: None)
        device.nodes = dict(nodes)
        preset = device.get_preset_state()
        self.assertEqual(preset.path, r"root\app\preset")
        self.assertEqual(preset.list_path, r"root\presets")
        self.assertEqual(preset.current, "Current")
        self.assertEqual(preset.names, ["Current", "Other"])

    def test_block_parameters(self):
        nodes = {
            r"root\app\drive": {"type": "item", "item_type": "block"},
            r"root\app\drive\on_off": {"type": "enum", "value": "ON"},
            r"root\app\drive\model": {"type": "plist", "value": "The Green Box",
                                       "ref": r"root\nam_drive",
                                       "desc": "Model"},
            r"root\app\drive\gain": {"type": "float", "value": 3.5,
                                      "min": 0.0, "max": 10.0},
            r"root\app\drive\level": {"type": "float", "value": 1.0},
            r"root\app\drive\folder\sub": {"type": "float", "value": 2.0},
            r"root\nam_drive": {"type": "list",
                                "value": ["The Green Box", "The Orange Box", ""]},
        }
        transport = FakeTransport(nodes)
        device = stomp.Device(transport, log=lambda _message: None)
        device.nodes = dict(nodes)
        params = device.get_block_parameters(r"root\app\drive")
        self.assertEqual([param["name"] for param in params],
                         ["gain", "level", "model"])
        self.assertEqual([param["kind"] for param in params],
                         ["float", "float", "choice"])
        self.assertEqual(params[0]["min"], 0.0)
        self.assertEqual(params[0]["max"], 10.0)
        self.assertEqual(params[2]["options"],
                         ["The Green Box", "The Orange Box"])
        self.assertEqual(params[2]["desc"], "Model")

    def test_dual_nam_state(self):
        nodes = {
            r"root\app\amp": {"type": "item", "item_type": "block"},
            r"root\app\amp\on_off": {"type": "enum", "value": "ON"},
            r"root\app\amp\model": {"type": "plist", "value": "Amp A",
                                     "ref": r"root\nam_amp",
                                     "desc": "Model (1)"},
            r"root\app\amp\gain": {"type": "float", "value": 4.0,
                                    "min": -20.0, "max": 20.0},
            r"root\app\amp\nam2": {"type": "item", "item_type": "vfolder",
                                    "desc": "Dual Amp"},
            r"root\app\amp\nam2\on_off": {"type": "enum", "value": "OFF"},
            r"root\app\amp\nam2\model": {"type": "plist", "value": "Amp B",
                                          "ref": r"root\nam_amp",
                                          "desc": "Model (2)"},
            r"root\app\amp\nam2\pan1": {"type": "float", "value": -100.0,
                                         "min": -100.0, "max": 100.0,
                                         "desc": "Pan Model 1"},
            r"root\nam_amp": {"type": "list",
                              "value": ["Amp A", "Amp B", ""]},
        }
        device = stomp.Device(FakeTransport(nodes),
                              log=lambda _message: None)
        device.nodes = dict(nodes)

        dual = device.get_dual_block(r"root\app\amp")
        self.assertIsNotNone(dual)
        self.assertEqual(dual["kind"], "nam")
        self.assertEqual(dual["path"], r"root\app\amp\nam2")
        self.assertEqual(dual["on_path"], r"root\app\amp\nam2\on_off")
        self.assertFalse(dual["enabled"])
        self.assertEqual([param["name"] for param in dual["parameters"]],
                         ["model", "pan1"])
        self.assertEqual(dual["parameters"][0]["options"],
                         ["Amp A", "Amp B"])
        self.assertEqual(device.get_value(dual["on_path"]), "OFF")
        self.assertIsNone(device.get_dual_block(r"root\app\drive"))

    def test_dual_ir_state(self):
        nodes = {
            r"root\app\ir": {"type": "item", "item_type": "block"},
            r"root\app\ir\on_off": {"type": "enum", "value": "ON"},
            r"root\app\ir\ir": {"type": "plist", "value": "Cab A",
                                "ref": r"root\ir_list",
                                "desc": "IR (1)"},
            r"root\app\ir\blend": {"type": "float", "value": 100.0,
                                    "min": 0.0, "max": 100.0},
            r"root\app\ir\ir2": {"type": "item", "item_type": "vfolder",
                                  "desc": "Stereo IR"},
            r"root\app\ir\ir2\on_off": {"type": "enum", "value": "OFF"},
            r"root\app\ir\ir2\ir": {"type": "plist", "value": "Cab B",
                                     "ref": r"root\ir_list",
                                     "desc": "IR (2)"},
            r"root\app\ir\ir2\pan1": {"type": "float", "value": -100.0,
                                       "min": -100.0, "max": 100.0,
                                       "desc": "Pan IR 1"},
            r"root\ir_list": {"type": "list",
                              "value": ["Cab A", "Cab B", ""]},
        }
        device = stomp.Device(FakeTransport(nodes),
                              log=lambda _message: None)
        device.nodes = dict(nodes)

        dual = device.get_dual_block(r"root\app\ir")
        self.assertIsNotNone(dual)
        self.assertEqual(dual["kind"], "ir")
        self.assertEqual(dual["path"], r"root\app\ir\ir2")
        self.assertEqual(dual["on_path"], r"root\app\ir\ir2\on_off")
        self.assertFalse(dual["enabled"])
        self.assertEqual([param["name"] for param in dual["parameters"]],
                         ["ir", "pan1"])
        self.assertEqual(dual["parameters"][0]["options"],
                         ["Cab A", "Cab B"])

    def test_default_chain_fallback(self):
        nodes = {
            r"root\app\gate\on_off": {"value": "ON"},
            r"root\app\amp\on_off": {"value": "OFF"},
        }
        transport = FakeTransport(nodes)
        device = stomp.Device(transport, log=lambda _message: None)
        device.nodes = dict(nodes)
        blocks = device.get_chain_blocks()
        self.assertEqual([block.path for block in blocks],
                         [r"root\app\gate", r"root\app\amp"])


class UploadTests(unittest.TestCase):
    def _nam_file(self, name="Test Amp"):
        payload = json.dumps({
            "metadata": {"name": name, "gear_type": "amp"},
            "weights": [1, 2, 3],
        }).encode("utf-8")
        handle = tempfile.NamedTemporaryFile(suffix=".nam", delete=False)
        handle.write(payload)
        handle.close()
        self.addCleanup(lambda: os.unlink(handle.name))
        return handle.name, payload

    def test_nam_upload_round_trip(self):
        device, transport = make_device()
        path, original = self._nam_file()
        result = device.load_nam(path, slot=3, target=r"root\nam_amp")
        self.assertEqual(result["slot"], 3)
        self.assertEqual(transport.dwrites[0][1]["chunk"], 0)
        name_value = transport.dwrites[0][1]["value"]
        self.assertEqual(bytes.fromhex(name_value).rstrip(b"\0"),
                         b"Test Amp")

        reassembled = bytearray()
        for _path, obj in transport.dwrites[1:]:
            value = obj["value"]
            if "gz" in value:
                value = value.split("gz", 1)[0]
            reassembled.extend(bytes.fromhex(value))
        unzipped = gzip.decompress(bytes(reassembled))
        self.assertEqual(len(unzipped), stomp.NAM_SLOT_SIZE)
        self.assertTrue(unzipped.startswith(original))
        self.assertEqual(unzipped[len(original):], b"\0" * (stomp.NAM_SLOT_SIZE - len(original)))

        final = transport.dwrites[-1][1]["value"]
        self.assertIn("gz", final)
        self.assertEqual(len(final), 2048)
        device.close()

    def test_ir_upload_round_trip(self):
        handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        handle.close()
        self.addCleanup(lambda: os.unlink(handle.name))
        samples = []
        for i in range(3000):
            value = (i - 1500) * 100
            samples.append(value.to_bytes(3, "little", signed=True))
        with wave.open(handle.name, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(3)
            wav.setframerate(48000)
            wav.writeframes(b"".join(samples))

        device, transport = make_device()
        result = device.load_ir(handle.name, slot=5)
        self.assertEqual(result["slot"], 5)

        data = bytearray()
        for _path, obj in transport.dwrites[1:]:
            data.extend(bytes.fromhex(obj["value"]))
        self.assertEqual(len(data), stomp.IR_LENGTH * 4)
        floats = struct.unpack("<%df" % stomp.IR_LENGTH, data)
        first_raw = -1500 * 100
        expected = first_raw / float(1 << 23) * stomp.IR_GAIN
        self.assertAlmostEqual(floats[0], expected, places=7)
        device.close()

    def test_nam_upload_full_tail_uses_marker_chunk(self):
        device, transport = make_device()
        payload = b"x" * 2048  # exactly two full chunks
        device._upload(r"root\nam_amp", 4, "Full Tail", payload,
                       nam_final_marker=True)
        self.assertEqual(
            [obj["chunk"] for _path, obj in transport.dwrites],
            [0, 1, 2, 3])
        final_value = transport.dwrites[-1][1]["value"]
        self.assertTrue(final_value.startswith("gz"))
        self.assertEqual(len(final_value), 2048)
        device.close()

    def test_wav_conversion_pads_short_files(self):
        handle = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        handle.close()
        self.addCleanup(lambda: os.unlink(handle.name))
        with wave.open(handle.name, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(3)
            wav.setframerate(44100)
            wav.writeframes((0).to_bytes(3, "little", signed=True) * 10)
        samples, rate, channels = stomp.wav_to_ir_samples(handle.name)
        self.assertEqual(len(samples), stomp.IR_LENGTH)
        self.assertEqual(rate, 44100)
        self.assertEqual(channels, 1)
        self.assertEqual(samples[-1], 0.0)


class UsbDetectionTests(unittest.TestCase):
    def test_find_stompstation_in_sysfs_tree(self):
        with tempfile.TemporaryDirectory() as root:
            device = os.path.join(root, "1-4")
            os.makedirs(os.path.join(device, "1-4:1.0"))
            files = {
                "product": "StompStation PRO",
                "serial": "STOMPPRO-10000000be183ca1",
                "idVendor": "1d6b",
                "idProduct": "0104",
            }
            for name, value in files.items():
                with open(os.path.join(device, name), "w") as handle:
                    handle.write(value)
            with open(os.path.join(device, "1-4:1.0", "bInterfaceClass"), "w") as handle:
                handle.write("02")

            found = stomp.find_usb_stompstations(root)
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0]["product"], "StompStation PRO")
            self.assertEqual(found[0]["acm_bound"], "0")

            # A bound driver makes the diagnostic report the serial device as
            # present rather than missing.
            os.makedirs(os.path.join(device, "1-4:1.0", "driver"))
            found = stomp.find_usb_stompstations(root)
            self.assertEqual(found[0]["acm_bound"], "1")


class MdnsParserTests(unittest.TestCase):
    def test_dns_name_and_packet_parse(self):
        packet = bytearray()
        packet.extend(struct.pack("!HHHHHH", 0, 0x8400, 0, 1, 0, 0))
        packet.extend(stomp._dns_encode_name("_http._tcp.local"))
        packet.extend(struct.pack("!HHIH", 12, 1, 120, 3))
        packet.extend(stomp._dns_encode_name("x"))
        records = stomp._parse_dns_packet(bytes(packet))
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].rtype, 12)
        self.assertEqual(records[0].rdata, b"\x01x\x00")


if __name__ == "__main__":
    unittest.main()

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sim_car


class SimCarEncodingTest(unittest.TestCase):
    def test_gear_drive_message_bytes(self):
        # CarEvent{data=EmulatorMessage{SET_PROPERTY_CMD, value=[{prop=GEAR_SELECTION, area 0, sint32 [8]}]}}
        event = sim_car.set_property(sim_car.GEAR_SELECTION, ints=[sim_car.GEAR_D])
        self.assertEqual(event.hex(), "0a0f08082a0b088088808a0120002a0110")

    def test_zigzag_matches_protobuf_sint32(self):
        self.assertEqual([sim_car.zigzag32(n) for n in (0, 1, -1, 8, 4)], [0, 2, 1, 16, 8])

    def test_varint_multibyte(self):
        self.assertEqual(sim_car.varint(0x11400400).hex(), "8088808a01")

    def test_float_speed_is_packed_le(self):
        body = sim_car.prop_value(sim_car.PERF_VEHICLE_SPEED, floats=[1.0])
        self.assertTrue(body.endswith(bytes([0x3A, 0x04, 0x00, 0x00, 0x80, 0x3F])))


if __name__ == "__main__":
    unittest.main()

import os
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[5]
sys.path.insert(0, str(REPO / 'services/inbox-watcher'))
# Imported files were inspected before execution. Their import builds scratch fixture binaries
# and an ephemeral fake Vox server; none invokes main(), warmup, or live binaries.
modules = [__import__(name) for name in sys.argv[1:]]
for mod in modules:
    if mod.__name__ == 'test_car_desk':
        mod.RealSkills.__unittest_skip__ = True
        mod.RealSkills.__unittest_skip_why__ = 'Review authority forbids executing scripts from another repository'
    if mod.__name__ == 'test_inbox_watcher':
        from unittest.mock import patch
        import memo_trace as mt
        import memo_common as mc
        # Tests with unrelated live service probes / intentionally missing ffmpeg binary.
        # Return the same non-live outcomes these probes would signal.
        original = mc.measure_levels
        def missing_measure(path):
            if mc.FFMPEG == '/nonexistent/ffmpeg':
                return {'ok': None, 'max_dbfs': None, 'mean_dbfs': None}
            return original(path)
        patch.object(mt,'watcher_unit_active',return_value=False).start()
        patch.object(mc,'measure_levels',side_effect=missing_measure).start()
loader = unittest.TestLoader()
suite = unittest.TestSuite(loader.loadTestsFromModule(m) for m in modules)
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() else 1)

"""Synthetic lifecycle and source-launch checks; not a native GUI acceptance test."""
import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from unittest.mock import MagicMock
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from windowed_launcher import InstanceLock, CompanionService, WindowedLauncher, main
from screenshot_companion import Settings, ScreenshotQueue


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.settings = self.root / 'config' / 'settings.json'
        self.images = self.root / 'images'
        self.images.mkdir()

    def tearDown(self):
        self.temporary.cleanup()

    def test_os_lock_refuses_duplicate_and_releases_for_restart(self):
        lock = InstanceLock(self.settings)
        try:
            with self.assertRaisesRegex(RuntimeError, 'already open'):
                InstanceLock(self.settings)
        finally:
            lock.close()
        reopened = InstanceLock(self.settings)
        reopened.close()
        reopened.close()

    def test_lock_never_writes_inside_screenshot_source(self):
        with self.assertRaises(OSError):
            InstanceLock(self.images / 'settings.json', self.images)
        self.assertEqual(list(self.images.iterdir()), [])

    def test_service_close_stops_both_workers_and_closes_listener(self):
        queue = ScreenshotQueue(Settings(self.settings), self.images)
        service = CompanionService(queue, '<html>synthetic</html>')
        address = service.server.server_address
        connection = http.client.HTTPConnection(*address, timeout=2)
        connection.request('GET', '/api/state', headers={'X-Rig-Token': service.server.token})
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertTrue(json.loads(response.read())['folderAvailable'])
        connection.close()
        service.close()
        self.assertFalse(service.worker.is_alive())
        self.assertFalse(service.monitor.is_alive())
        connection = http.client.HTTPConnection(*address, timeout=2)
        with self.assertRaises(OSError):
            connection.request('GET', '/')
        connection.close()

    def test_http_picker_request_is_marshaled_to_visible_owner(self):
        launcher = object.__new__(WindowedLauncher)
        import queue
        launcher.dialogs = queue.Queue()
        launcher.closed = False
        result = []
        worker = threading.Thread(target=lambda: result.append(launcher.threaded_choose(self.images)))
        worker.start()
        initial, event, selected = launcher.dialogs.get(timeout=2)
        self.assertEqual(initial, self.images)
        self.assertEqual(result, [])
        selected.append(self.images)
        event.set()
        worker.join(timeout=2)
        self.assertEqual(result, [self.images])
        self.assertFalse(worker.is_alive())

    def test_pending_picker_ends_when_launcher_closes(self):
        launcher = object.__new__(WindowedLauncher)
        import queue
        launcher.dialogs = queue.Queue()
        launcher.closed = False
        result = []
        worker = threading.Thread(target=lambda: result.append(launcher.threaded_choose(None)))
        worker.start()
        launcher.dialogs.get(timeout=2)
        launcher.closed = True
        worker.join(timeout=2)
        self.assertEqual(result, [None])

    def test_missing_tk_has_visible_fallback_without_starting_service(self):
        if os.name == 'nt':
            with patch.dict(sys.modules, {'tkinter': None}), patch('ctypes.windll.user32.MessageBoxW') as dialog:
                self.assertEqual(main(['--settings', str(self.settings)]), 2)
                dialog.assert_called_once()
        else:
            with patch.dict(sys.modules, {'tkinter': None}), patch('builtins.print') as output:
                self.assertEqual(main(['--settings', str(self.settings)]), 2)
                output.assert_called_once()
        self.assertFalse(self.settings.exists())

    def test_launchers_remain_readable_source_without_policy_override(self):
        root = Path(__file__).resolve().parents[1]
        primary = (root / 'Start Rig Planner.pyw').read_text(encoding='utf-8')
        diagnostics = (root / 'DIAGNOSTICS_RIG_PLANNER.cmd').read_text(encoding='utf-8')
        compatibility = (root / 'START_RIG_PLANNER.cmd').read_text(encoding='utf-8')
        self.assertIn('from windowed_launcher import main', primary)
        self.assertIn('screenshot_companion.py', diagnostics)
        self.assertIn('index.html', diagnostics)
        for text in (primary, diagnostics, compatibility):
            self.assertNotIn('-ExecutionPolicy', text)
            self.assertNotIn('runas', text.lower())

    def test_initial_folder_chooser_waits_for_visible_owner_update(self):
        events = []
        window = MagicMock()
        window.update_idletasks.side_effect = lambda: events.append('idle')
        window.update.side_effect = lambda: events.append('mapped')
        widget = MagicMock()
        fake_tk = SimpleNamespace(StringVar=lambda **kwargs: MagicMock(),
                                 ttk=SimpleNamespace(Frame=lambda *a, **k: widget,
                                                     Label=lambda *a, **k: widget,
                                                     Button=lambda *a, **k: widget))
        with patch.dict(sys.modules, {'tkinter': fake_tk}), \
                patch('windowed_launcher.InstanceLock'), patch('windowed_launcher.CompanionService'), \
                patch.object(WindowedLauncher, 'choose', side_effect=lambda initial: events.append('choose')):
            WindowedLauncher(window, self.settings, open_browser=False)
        self.assertEqual(events, ['idle', 'mapped', 'choose'])
        window.after.assert_called_once()


if __name__ == '__main__':
    unittest.main()

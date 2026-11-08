"""Synthetic queue, configuration, read-safety and local HTTP checks."""
import base64
from contextlib import redirect_stdout
from io import StringIO
import hashlib
import http.client
import json
import os
import struct
import stat
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from image_planner import ImageRefusal, bmp_to_png, source_info, unsafe_image_entry
from screenshot_companion import (LocalServer, Settings, ScreenshotQueue, local_folder,
                                  choose_folder, main, DEFAULT_PREFERENCES)
from tests.test_planner import synthetic_bmp


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.folder = self.root / 'images'
        self.folder.mkdir()
        self.settings = Settings(self.root / 'config' / 'settings.json')
        self.now = 0.0
        self.queue = ScreenshotQueue(self.settings, self.folder, clock=lambda: self.now)

    def tearDown(self):
        self.temporary.cleanup()

    def settle(self):
        self.queue.scan()
        self.now += 1.1
        self.queue.scan()

    def ready(self, item):
        image = self.queue.image(item['id'])
        self.queue.validated({'id': item['id'], 'ok': True, 'width': image['width'], 'height': image['height']})
        return image

    def test_first_selection_remembered_and_change_cancellation(self):
        saved = Settings(self.settings.path)
        self.assertEqual(saved.data['folder'], str(self.folder))
        restored = ScreenshotQueue(saved, chooser=lambda initial: None)
        self.assertEqual(restored.folder, self.folder)
        self.assertTrue(restored.available)
        other = self.root / 'other'
        other.mkdir()
        restored.set_folder(other)
        self.assertEqual(Settings(self.settings.path).data['folder'], str(other))
        before = self.settings.path.read_bytes()
        with self.assertRaises((OSError, ImageRefusal)):
            restored.set_folder(self.root / 'missing')
        self.assertEqual(self.settings.path.read_bytes(), before)

    def test_legacy_settings_add_default_preferences_in_memory_without_rewriting_file(self):
        legacy = {key: value for key, value in self.settings.data.items() if key != 'preferences'}
        original = json.dumps(legacy).encode('utf-8')
        self.settings.path.write_bytes(original)
        restored = Settings(self.settings.path)
        self.assertEqual(restored.data['preferences'], DEFAULT_PREFERENCES)
        self.assertEqual(restored.data['folder'], legacy['folder'])
        self.assertEqual(restored.data['history'], legacy['history'])
        self.assertEqual(self.settings.path.read_bytes(), original)

    def test_preference_save_failure_preserves_disk_and_in_memory_values(self):
        before = self.settings.path.read_bytes()
        preferences = {**DEFAULT_PREFERENCES, 'threshold': 21, 'spacingMeters': 90, 'fine': False}
        with patch.object(self.settings, 'save', side_effect=PermissionError('disk denied')):
            with self.assertRaises(PermissionError):
                self.queue.save_preferences(preferences)
        self.assertEqual(self.queue.state()['preferences'], DEFAULT_PREFERENCES)
        self.assertEqual(self.settings.path.read_bytes(), before)

    def test_missing_saved_folder_never_switches(self):
        self.folder.rmdir()
        restored = ScreenshotQueue(Settings(self.settings.path))
        self.assertFalse(restored.available)
        self.assertEqual(restored.folder, self.folder)
        self.assertIn('unavailable', restored.state()['notice'])

    def test_initial_launch_invokes_selection_and_cancel_does_not_save(self):
        configuration = self.root / 'fresh.json'
        with patch('screenshot_companion.choose_folder', return_value=None) as picker:
            self.assertEqual(main(['--settings', str(configuration), '--no-browser']), 0)
        picker.assert_called_once_with(None)
        self.assertFalse(configuration.exists())

    def test_terminal_selection_fallback_requires_explicit_path(self):
        with redirect_stdout(StringIO()), patch.dict(sys.modules, {'tkinter': None}), patch('builtins.input', return_value=''):
            self.assertIsNone(choose_folder(self.folder))
        with redirect_stdout(StringIO()), patch.dict(sys.modules, {'tkinter': None}), patch('builtins.input', return_value=str(self.folder)):
            self.assertEqual(choose_folder(self.folder), self.folder)

    def test_three_rapid_files_queue_once_in_stable_order_and_survive_restart(self):
        raw = synthetic_bmp()
        for name in ('c.bmp', 'A.bin', 'b.bmp'):
            p = self.folder / name
            p.write_bytes(raw)
            os.utime(p, ns=(10000000000, 10000000000))
        self.queue.scan()
        self.assertEqual(self.queue.state()['images'], [])
        self.now += .5
        self.queue.scan()
        self.assertEqual(self.queue.state()['images'], [])
        self.now += .6
        self.queue.scan()
        items = self.queue.state()['images']
        self.assertEqual([x['name'] for x in items], ['A.bin', 'b.bmp', 'c.bmp'])
        self.assertEqual(self.queue.state()['pending'], 0)
        for item in items:
            self.ready(item)
        self.assertEqual(self.queue.state()['pending'], 3)
        for item in items:
            self.queue.loaded(item['id'])
            self.queue.loaded(item['id'])
        self.assertEqual(self.queue.state()['pending'], 0)
        self.queue = ScreenshotQueue(Settings(self.settings.path), clock=lambda: self.now)
        self.settle()
        for item in self.queue.state()['images']:
            self.ready(item)
        self.assertEqual(self.queue.state()['pending'], 0)
        self.assertEqual(len(self.queue.state()['history']), 3)
        self.assertEqual((self.folder / 'A.bin').read_bytes(), raw)

    def test_existing_then_later_image_without_restart(self):
        (self.folder / 'one.bmp').write_bytes(synthetic_bmp())
        self.settle()
        first = self.queue.state()['images'][0]
        self.ready(first)
        self.queue.loaded(first['id'])
        (self.folder / 'two.bmp').write_bytes(synthetic_bmp())
        self.settle()
        self.assertEqual(len(self.queue.state()['images']), 2)
        second = next(x for x in self.queue.state()['images'] if x['name'] == 'two.bmp')
        self.ready(second)
        self.assertEqual(self.queue.state()['pending'], 1)
        self.assertEqual(self.queue.state()['history'], [first['id']])

    def test_same_name_new_completed_version_is_available_again(self):
        path = self.folder / 'same.bmp'
        raw = synthetic_bmp()
        path.write_bytes(raw)
        self.settle()
        first = self.queue.state()['images'][0]
        self.ready(first)
        self.queue.loaded(first['id'])
        timestamp = path.stat().st_mtime_ns
        path.write_bytes(raw)
        os.utime(path, ns=(timestamp+1000000000, timestamp+1000000000))
        self.settle()
        second = self.queue.state()['images'][0]
        self.assertNotEqual(second['id'], first['id'])
        self.ready(second)
        self.assertEqual(self.queue.state()['pending'], 1)
        self.assertEqual(self.queue.state()['history'], [first['id']])

    def test_transient_read_error_retries_with_bounded_backoff_without_metadata_change(self):
        path = self.folder / 'retry.bmp'
        raw = synthetic_bmp()
        path.write_bytes(raw)
        before = path.stat()
        self.queue.scan()
        self.now += 1.1
        with patch('screenshot_companion.source_info', side_effect=PermissionError('temporary sharing violation')) as reader:
            self.queue.scan()
            self.assertFalse(self.queue.polls[path.name]['done'])
            self.assertEqual(reader.call_count, 1)
            for _ in range(20):
                self.queue.scan()
            self.assertEqual(reader.call_count, 1)
            self.now += 1.1
            self.queue.scan()
            self.assertEqual(reader.call_count, 2)
            self.now += 1.1
            self.queue.scan()
            self.assertEqual(reader.call_count, 2)
        self.now += 1.1
        self.queue.scan()
        items = self.queue.state()['images']
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['state'], 'candidate')
        self.assertEqual(self.queue.state()['history'], [])
        self.ready(items[0])
        self.queue.loaded(items[0]['id'])
        self.assertEqual(self.queue.state()['history'], [items[0]['id']])
        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)

    @unittest.skipUnless(os.name == 'nt', 'Windows file sharing lock')
    def test_windows_sharing_lock_recovers_after_unlock_without_restart(self):
        import ctypes
        path = self.folder / 'held-complete.bmp'
        raw = synthetic_bmp()
        path.write_bytes(raw)
        before = path.stat()
        self.queue.scan()
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                                       ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
        kernel32.CreateFileW.restype = ctypes.c_void_p
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel32.CreateFileW(str(path), 0x80000000, 0, None, 3, 0x80, None)
        if handle == ctypes.c_void_p(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            self.now += 1.1
            self.queue.scan()
            self.assertEqual(self.queue.state()['images'], [])
            self.assertFalse(self.queue.polls[path.name]['done'])
        finally:
            kernel32.CloseHandle(handle)
        self.now += 1.1
        self.queue.scan()
        items = self.queue.state()['images']
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['state'], 'candidate')
        self.assertEqual(self.queue.state()['pending'], 0)
        self.assertEqual(self.queue.state()['history'], [])
        self.ready(items[0])
        self.queue.loaded(items[0]['id'])
        self.assertEqual(self.queue.state()['history'], [items[0]['id']])
        self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(path.read_bytes(), raw)

    def test_partial_corrupt_changed_and_browser_decode_refusal(self):
        broken = self.folder / 'partial.bmp'
        broken.write_bytes(synthetic_bmp()[:80])
        (self.folder / 'bad.bin').write_bytes(b'wrong' * 400)
        # A recognizable compressed header is not proof of successful decoding.
        (self.folder / 'broken.png').write_bytes(bmp_to_png(synthetic_bmp())[0][:33]+b'broken'*200)
        self.settle()
        items = self.queue.state()['images']
        self.assertEqual([x['name'] for x in items], ['broken.png'])
        self.assertEqual(self.queue.state()['pending'], 0)
        self.queue.validated({'id': items[0]['id'], 'ok': False})
        self.assertEqual(self.queue.state()['pending'], 0)
        self.assertEqual(self.queue.state()['history'], [])
        broken.write_bytes(synthetic_bmp())
        self.settle()
        repaired = next(x for x in self.queue.state()['images'] if x['name'] == 'partial.bmp')
        broken.write_bytes(synthetic_bmp(74))
        with self.assertRaisesRegex(ImageRefusal, 'changed'):
            self.queue.image(repaired['id'])
        self.assertEqual(self.queue.state()['history'], [])

    def test_small_valid_png_and_content_hash(self):
        raw = bmp_to_png(synthetic_bmp())[0]
        self.assertLess(len(raw), 1000)
        p = self.folder / 'small.png'
        p.write_bytes(raw)
        data, receipt = source_info(p, allowed_root=self.folder)
        self.assertEqual(receipt['sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual(base64.b64decode(data.split(b',')[1]), raw)
        self.settle()
        item = self.queue.state()['images'][0]
        self.queue.validated({'id': item['id'], 'ok': True, 'width': 73, 'height': 29})
        self.assertEqual(self.queue.state()['pending'], 1)

    def test_declared_compressed_dimensions_are_bounded_before_browser_decode(self):
        p = self.folder / 'huge.png'
        data = bytearray(bmp_to_png(synthetic_bmp())[0])
        data[16:20] = struct.pack('>I', 30000)
        p.write_bytes(data)
        with self.assertRaisesRegex(ImageRefusal, 'DIMENSIONS_UNSUPPORTED'):
            source_info(p, allowed_root=self.folder)
        self.settle()
        self.assertEqual(self.queue.state()['images'], [])

    def test_rescan_work_is_batched_without_losing_files(self):
        for number in range(9):
            (self.folder / ('image-%02d.bmp' % number)).write_bytes(synthetic_bmp())
        self.settle()
        self.assertEqual(len(self.queue.state()['images']), 4)
        self.assertFalse(self.queue.state()['scanComplete'])
        self.now += 1.1
        self.queue.scan()
        self.assertEqual(len(self.queue.state()['images']), 8)
        self.assertFalse(self.queue.state()['scanComplete'])
        self.now += 1.1
        self.queue.scan()
        self.assertEqual(len(self.queue.state()['images']), 9)
        self.assertTrue(self.queue.state()['scanComplete'])

    def test_batch_budget_never_reports_chronologically_incomplete_queue_as_complete(self):
        for name, stamp in [('a.bmp', 20), ('b.bmp', 30), ('c.bmp', 40), ('d.bmp', 50), ('z.bmp', 10)]:
            path = self.folder / name
            path.write_bytes(synthetic_bmp())
            os.utime(path, ns=(stamp*1000000000, stamp*1000000000))
        self.settle()
        self.assertFalse(self.queue.state()['scanComplete'])
        self.assertEqual([x['name'] for x in self.queue.state()['images']], ['a.bmp', 'b.bmp', 'c.bmp', 'd.bmp'])
        self.now += 1.1
        self.queue.scan()
        self.assertTrue(self.queue.state()['scanComplete'])
        self.assertEqual(self.queue.state()['images'][0]['name'], 'z.bmp')

    def test_source_hash_remains_raw_bmp_hash_after_conversion(self):
        p = self.folder / 'raw.bin'
        raw = synthetic_bmp()
        p.write_bytes(raw)
        self.settle()
        item = self.queue.state()['images'][0]
        result = self.ready(item)
        self.assertEqual(result['sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual((result['sourceWidth'], result['sourceHeight']), (73, 29))
        self.assertTrue(result['dataUrl'].startswith('data:image/png;base64,'))

    def test_path_and_symlink_rejection(self):
        with self.assertRaises(ImageRefusal):
            local_folder('//server/share')
        external = self.root / 'outside.bmp'
        external.write_bytes(synthetic_bmp())
        with self.assertRaisesRegex(ImageRefusal, 'OUTSIDE'):
            source_info(external, allowed_root=self.folder)
        link = self.folder / 'linked.bmp'
        try:
            link.symlink_to(external)
        except (OSError, NotImplementedError):
            return
        self.settle()
        self.assertEqual(self.queue.state()['images'], [])
        with self.assertRaises(ImageRefusal):
            source_info(link, allowed_root=self.folder)

    def test_settings_cannot_write_inside_screenshot_source(self):
        inner = Settings(self.folder / 'settings.json')
        with self.assertRaisesRegex(ImageRefusal, 'outside the screenshot folder'):
            ScreenshotQueue(inner, self.folder)
        self.assertFalse(inner.path.exists())
        nested = Settings(self.folder / 'nested' / 'settings.json')
        with self.assertRaises(ImageRefusal):
            ScreenshotQueue(nested, self.folder)
        self.assertFalse(nested.path.parent.exists())

    def test_hydrated_cloud_tags_and_remote_placeholder_flags(self):
        def info(tag, attributes=0x400, mode=stat.S_IFREG):
            return SimpleNamespace(st_mode=mode, st_file_attributes=attributes, st_reparse_tag=tag)
        self.assertFalse(unsafe_image_entry(info(0, 0)))
        for subtype in range(16):
            tag = 0x9000001a | (subtype << 12)
            self.assertFalse(unsafe_image_entry(info(tag)))
            self.assertFalse(unsafe_image_entry(info(tag, mode=stat.S_IFDIR)))
            for flag in (0x1000, 0x40000, 0x400000):
                self.assertTrue(unsafe_image_entry(info(tag, 0x400 | flag)))
        for tag in (0, 0xa0000003, 0xa000000c, 0x80000021, 0x9000001c, 0x9001001a):
            self.assertTrue(unsafe_image_entry(info(tag)))
        self.assertTrue(unsafe_image_entry(info(0, 0, stat.S_IFLNK)))

    @unittest.skipUnless(os.name == 'nt', 'Windows junction protection')
    def test_windows_directory_junction_is_rejected(self):
        target = self.root / 'outside'
        target.mkdir()
        original = target / 'image.bmp'
        original.write_bytes(synthetic_bmp())
        junction = self.folder / 'linked-folder'
        result = subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(junction), str(target)],
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        try:
            with self.assertRaises(ImageRefusal):
                local_folder(junction)
            with self.assertRaises(ImageRefusal):
                source_info(junction / 'image.bmp', allowed_root=junction)
            self.assertEqual(original.read_bytes(), synthetic_bmp())
        finally:
            os.rmdir(junction)

    def test_save_failure_rolls_back_consumption(self):
        (self.folder / 'one.bmp').write_bytes(synthetic_bmp())
        self.settle()
        item = self.queue.state()['images'][0]
        self.ready(item)
        with patch.object(self.settings, 'save', side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):
                self.queue.loaded(item['id'])
        self.assertEqual(self.queue.state()['history'], [])
        self.assertEqual(self.queue.state()['pending'], 1)

    def test_gallery_keeps_viewed_images_and_exposes_pending_neighbors(self):
        for name, stamp in [('older.bmp', 10), ('newer.bmp', 30)]:
            path = self.folder / name
            path.write_bytes(synthetic_bmp())
            os.utime(path, ns=(stamp * 10**9, stamp * 10**9))
        self.settle()
        originals = self.queue.state()['images']
        for item in originals:
            self.ready(item)
            self.queue.loaded(item['id'])
        pending = self.folder / 'middle.bmp'
        pending.write_bytes(synthetic_bmp()[:80])
        os.utime(pending, ns=(20 * 10**9, 20 * 10**9))
        self.queue.scan()
        state = self.queue.state()
        self.assertFalse(state['discoveryComplete'])
        self.assertEqual([x['name'] for x in state['files']], ['older.bmp', 'middle.bmp', 'newer.bmp'])
        self.assertEqual([x['state'] for x in state['files']], ['ready', 'pending', 'ready'])
        self.assertEqual([x['id'] for x in state['images']], [x['id'] for x in originals])
        self.now += 1.1
        self.queue.scan()
        state = self.queue.state()
        self.assertTrue(state['discoveryComplete'])
        self.assertEqual([x['state'] for x in state['files']], ['ready', 'rejected', 'ready'])
        self.assertEqual(state['pending'], 0)
        self.assertTrue(all(x['loaded'] for x in state['images']))

    def test_tied_identical_content_rename_delete_and_restart_keep_deterministic_listing(self):
        for name in ('B.bmp', 'a.bmp', 'c.bmp'):
            path = self.folder / name
            path.write_bytes(synthetic_bmp())
            os.utime(path, ns=(10**10, 10**10))
        self.settle()
        items = self.queue.state()['images']
        self.assertEqual(len({x['id'] for x in items}), 3)
        self.assertEqual([x['name'] for x in items], ['a.bmp', 'B.bmp', 'c.bmp'])
        for item in items:
            self.ready(item)
            self.queue.loaded(item['id'])
        self.queue = ScreenshotQueue(Settings(self.settings.path), clock=lambda: self.now)
        self.settle()
        self.assertEqual([x['id'] for x in self.queue.state()['images']], [x['id'] for x in items])
        (self.folder / 'a.bmp').rename(self.folder / 'z.bmp')
        (self.folder / 'B.bmp').unlink()
        self.settle()
        state = self.queue.state()
        self.assertEqual([x['name'] for x in state['images']], ['c.bmp', 'z.bmp'])
        self.assertEqual(state['history'], [x['id'] for x in items])
        self.assertNotEqual(state['images'][-1]['id'], items[0]['id'])
        with self.assertRaises(ImageRefusal):
            self.queue.image(items[0]['id'])

    def test_folder_change_rejects_old_decode_or_load_identity(self):
        (self.folder / 'one.bmp').write_bytes(synthetic_bmp())
        self.settle()
        original = self.queue.state()['images'][0]
        new_folder = self.root / 'second'
        new_folder.mkdir()
        (new_folder / 'one.bmp').write_bytes(synthetic_bmp())
        self.queue.set_folder(new_folder)
        with self.assertRaises(ImageRefusal):
            self.queue.validated({'id': original['id'], 'ok': True, 'width': 73, 'height': 29})
        with self.assertRaises(ImageRefusal):
            self.queue.image(original['id'])
        self.settle()
        self.assertNotEqual(self.queue.state()['images'][0]['id'], original['id'])
        self.assertEqual(self.queue.state()['history'], [])

    def test_retry_notice_omits_os_paths_and_does_not_hide_ready_neighbor(self):
        (self.folder / 'ready.bmp').write_bytes(synthetic_bmp())
        self.settle()
        item = self.queue.state()['images'][0]
        self.ready(item)
        (self.folder / 'locked.bmp').write_bytes(synthetic_bmp())
        self.queue.scan()
        self.now += 1.1
        with patch('screenshot_companion.source_info', side_effect=PermissionError('SENTINEL_PERSONAL_PATH')):
            self.queue.scan()
        state = self.queue.state()
        self.assertNotIn('SENTINEL_PERSONAL_PATH', json.dumps(state))
        self.assertEqual([x['id'] for x in state['images']], [item['id']])
        locked = next(x for x in state['files'] if x['name'] == 'locked.bmp')
        self.assertEqual(locked['state'], 'pending')
        self.assertIn('retry', locked['detail'])
        self.assertTrue(state['discoveryComplete'])

    def test_temporarily_unavailable_ready_file_requires_recheck_when_restored(self):
        (self.folder / 'one.bmp').write_bytes(synthetic_bmp())
        self.settle()
        original = self.queue.state()['images'][0]
        self.ready(original)
        self.queue.loaded(original['id'])
        # Simulate a provider placeholder flag without touching a cloud provider.
        original_unsafe = unsafe_image_entry
        with patch('screenshot_companion.unsafe_image_entry', side_effect=lambda info: True if stat.S_ISREG(info.st_mode) else original_unsafe(info)):
            self.queue.scan()
        state = self.queue.state()
        self.assertEqual(state['images'], [])
        self.assertEqual(state['files'][0]['state'], 'unavailable')
        self.assertEqual(state['history'], [original['id']])
        self.settle()
        restored = self.queue.state()['images'][0]
        self.assertEqual(restored['id'], original['id'])
        self.assertEqual(restored['state'], 'candidate')
        self.ready(restored)
        self.assertEqual(self.queue.state()['images'][0]['state'], 'ready')


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.folder = self.root / 'images'
        self.folder.mkdir()
        self.queue = ScreenshotQueue(Settings(self.root / 'settings.json'), self.folder,
                                     chooser=lambda initial: None)
        self.server = LocalServer(self.queue, "<meta content=\"connect-src 'none'\">offline")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.stopping.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.temporary.cleanup()

    def request(self, path='/api/state', method='GET', body=None, headers=None):
        actual = {'X-Rig-Token': self.server.token}
        if method == 'POST':
            actual.update({'Origin': self.server.origin, 'Content-Type': 'application/json'})
        actual.update(headers or {})
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        connection.request(method, path, json.dumps(body or {}) if method == 'POST' else None, actual)
        response = connection.getresponse()
        result = (response.status, response.read())
        connection.close()
        return result

    def test_only_loopback_origin_and_capability(self):
        self.assertEqual(self.server.server_address[0], '127.0.0.1')
        self.assertEqual(self.request()[0], 200)
        for headers in ({'X-Rig-Token': ''}, {'X-Rig-Token': 'wrong'}, {'Host': 'evil.invalid'},
                        {'Origin': 'http://evil.invalid'}, {'Origin': 'null'},
                        {'Sec-Fetch-Site': 'cross-site'}):
            self.assertEqual(self.request(headers=headers)[0], 403)
        self.assertEqual(self.request('/api/refresh', 'POST', headers={'Origin': ''})[0], 403)
        self.assertEqual(self.request('/api/refresh', 'POST')[0], 200)

    def test_preferences_persist_across_different_server_origins(self):
        preferences = {'referenceMeters': 14.5, 'spacingMeters': 110, 'marginMeters': 7,
                       'exclusionMeters': 14, 'threshold': 22, 'fine': False}
        old_folder = self.queue.settings.data['folder']
        old_history = json.loads(json.dumps(self.queue.settings.data['history']))
        code, response = self.request('/api/preferences', 'POST', {'preferences': preferences})
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(response)['preferences'], preferences)
        second_queue = ScreenshotQueue(Settings(self.queue.settings.path))
        second = LocalServer(second_queue, '<html>synthetic</html>')
        worker = threading.Thread(target=second.serve_forever, daemon=True)
        worker.start()
        try:
            self.assertNotEqual(second.origin, self.server.origin)
            connection = http.client.HTTPConnection(*second.server_address, timeout=3)
            connection.request('GET', '/api/state', headers={'X-Rig-Token': second.token})
            result = connection.getresponse()
            self.assertEqual(result.status, 200)
            self.assertEqual(json.loads(result.read())['preferences'], preferences)
            connection.close()
            self.assertEqual(second_queue.settings.data['folder'], old_folder)
            self.assertEqual(second_queue.settings.data['history'], old_history)
        finally:
            second.shutdown()
            second.server_close()
            worker.join(timeout=3)

    def test_invalid_preferences_refused_without_disk_or_state_changes(self):
        before = self.queue.settings.path.read_bytes()
        invalid = [None, [], {}, {**DEFAULT_PREFERENCES, 'fine': 1},
                   {**DEFAULT_PREFERENCES, 'threshold': True},
                   {**DEFAULT_PREFERENCES, 'referenceMeters': '12.24'},
                   {**DEFAULT_PREFERENCES, 'spacingMeters': 301},
                   {**DEFAULT_PREFERENCES, 'marginMeters': -1},
                   {**DEFAULT_PREFERENCES, 'threshold': float('nan')},
                   {**DEFAULT_PREFERENCES, 'threshold': float('inf')},
                   {**DEFAULT_PREFERENCES, 'spacingMeters': 10 ** 1000},
                   {**DEFAULT_PREFERENCES, '__proto__': {'extra': True}}]
        for preferences in invalid:
            with self.subTest(preferences=preferences):
                self.assertEqual(self.request('/api/preferences', 'POST', {'preferences': preferences})[0], 409)
                self.assertEqual(self.queue.settings.path.read_bytes(), before)
                self.assertEqual(self.queue.state()['preferences'], DEFAULT_PREFERENCES)
        self.assertEqual(self.request('/api/preferences', 'POST', {'preferences': DEFAULT_PREFERENCES},
                                      {'X-Rig-Token': 'wrong'})[0], 403)
        self.assertEqual(self.queue.settings.path.read_bytes(), before)

    def test_no_arbitrary_file_or_remote_fetch_routes(self):
        for path in ('/api/image?id=../secret', '/api/image?path=C:/private.txt',
                     '/api/image?id=http://example.invalid/a.bmp', '/src/image_planner.py', '/../../private'):
            self.assertIn(self.request(path)[0], (404, 409))
        self.assertEqual(self.request('/api/change-folder', 'POST', {'folder': str(self.root)})[0], 404)
        self.assertEqual(self.request('/api/change-folder', 'POST')[0], 200)
        self.assertEqual(self.queue.folder, self.folder)
        self.assertIn('canceled', self.queue.notice)

    def test_oversized_and_unknown_actions_refused(self):
        self.assertEqual(self.request('/api/refresh', 'POST', {'note': 'x' * 5000})[0], 409)
        self.assertEqual(self.request('/api/delete', 'POST')[0], 404)
        self.assertEqual(self.request('/api/validated', 'POST', {'id': 'missing', 'ok': True})[0], 409)
        code, page = self.request('/')
        self.assertEqual(code, 200)
        self.assertIn(b"connect-src 'self'", page)
        self.assertNotIn(self.server.token.encode(), page)

    def test_server_errors_do_not_echo_os_paths_or_request_contents(self):
        with patch.object(self.queue, 'image', side_effect=PermissionError('SENTINEL_PERSONAL_PATH')):
            code, response = self.request('/api/image?id=' + 'a' * 64)
        self.assertEqual(code, 409)
        self.assertNotIn(b'SENTINEL_PERSONAL_PATH', response)
        self.assertNotIn(self.server.token.encode(), response)

    def test_explicit_stop_closes_service(self):
        self.assertEqual(self.request('/api/stop', 'POST')[0], 200)
        self.thread.join(timeout=3)
        self.assertFalse(self.thread.is_alive())
        self.assertTrue(self.server.stopping.is_set())

    @unittest.skipUnless(os.name == 'nt', 'Windows diagnostics process lifecycle')
    def test_windows_diagnostics_process_uses_only_explicit_screenshot_configuration(self):
        launcher = Path(__file__).resolve().parents[1] / 'src' / 'screenshot_companion.py'
        settings = self.root / 'launcher-settings.json'
        process = subprocess.Popen([sys.executable, '-B', str(launcher), '--folder', str(self.folder),
                                    '--settings', str(settings), '--no-browser'], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            deadline = time.monotonic() + 10
            lines = []
            # Readline belongs in a daemon reader so a broken launcher cannot block the suite.
            def read_lines():
                for line in process.stdout:
                    lines.append(line)
            reader = threading.Thread(target=read_lines, daemon=True)
            reader.start()
            while not any(line.startswith('Open: ') for line in lines) and time.monotonic() < deadline:
                time.sleep(.05)
            line = next((line for line in lines if line.startswith('Open: ')), None)
            self.assertIsNotNone(line, ''.join(lines))
            from urllib.parse import urlsplit
            address = urlsplit(line[6:].strip())
            token = address.fragment.removeprefix('rig-token=')
            connection = http.client.HTTPConnection(address.hostname, address.port, timeout=3)
            connection.request('POST', '/api/stop', '{}', {'Content-Type': 'application/json',
                               'Origin': 'http://' + address.netloc, 'X-Rig-Token': token})
            self.assertEqual(connection.getresponse().status, 200)
            connection.close()
            self.assertEqual(process.wait(timeout=10), 0)
            self.assertEqual(Settings(settings).data['folder'], str(self.folder))
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            process.stdout.close()
            process.stderr.close()


if __name__ == '__main__':
    unittest.main()

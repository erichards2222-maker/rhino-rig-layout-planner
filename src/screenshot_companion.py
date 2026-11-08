#!/usr/bin/env python3
"""Optional local screenshot queue. Original images are only opened for reading."""
from __future__ import annotations

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import secrets
import stat
import threading
import time
from urllib.parse import parse_qs, urlsplit
import webbrowser

from image_planner import EXTENSIONS, ImageRefusal, source_info, unsafe_image_entry

MAX_FILES = 2000
MAX_HISTORY = 10000
MAX_SETTINGS_BYTES = 1024 * 1024
MAX_BODY = 4096
POLL_SECONDS = 1.0
MAX_IMAGES_PER_POLL = 4
PREFERENCE_LIMITS = {'referenceMeters': (1, 50), 'spacingMeters': (30, 300),
                     'marginMeters': (0, 50), 'exclusionMeters': (1, 100), 'threshold': (8, 32)}
DEFAULT_PREFERENCES = {'referenceMeters': 12.24, 'spacingMeters': 80, 'marginMeters': 5,
                       'exclusionMeters': 12, 'threshold': 16, 'fine': True}


def public_error(error):
    """Do not place OS paths or user-supplied request text in API errors."""
    if isinstance(error, ImageRefusal):
        message = str(error)
        if len(message) <= 240 and not any(c in message for c in ('\\', '/', '\n', '\r')):
            return message
    return 'Local request could not complete. Check file availability or folder selection and try Refresh.'


def validated_preferences(value):
    if not isinstance(value, dict) or set(value) != set(DEFAULT_PREFERENCES) or type(value['fine']) is not bool:
        raise ImageRefusal('Invalid planner preferences.')
    for key, (minimum, maximum) in PREFERENCE_LIMITS.items():
        number = value[key]
        if type(number) not in (int, float) or not minimum <= number <= maximum or not math.isfinite(number):
            raise ImageRefusal('Invalid planner preference: ' + key)
    return value.copy()


def is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def local_folder(value):
    if not isinstance(value, (str, Path)) or not str(value) or len(str(value)) > 1024:
        raise ImageRefusal('Choose a local screenshot folder.')
    text = str(value)
    if text.startswith(('\\\\', '//')):
        raise ImageRefusal('Network folders are not supported. Choose a local folder.')
    path = Path(os.path.abspath(os.path.expandvars(text)))
    if os.name == 'nt':
        import ctypes
        if ctypes.windll.kernel32.GetDriveTypeW(path.anchor) == 4:
            raise ImageRefusal('Network drives are not supported. Choose a local folder.')
    for item in (path, *path.parents):
        if unsafe_image_entry(item.lstat()):
            raise ImageRefusal('Choose a local folder without links. In OneDrive, make the folder available on this device first.')
    if not path.is_dir():
        raise ImageRefusal('Screenshot folder is unavailable. Choose it again or reconnect the drive.')
    return path


def suggested_folder():
    pictures = None
    if os.name == 'nt':
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                               r'Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders') as key:
                pictures = Path(os.path.expandvars(winreg.QueryValueEx(key, 'My Pictures')[0]))
        except OSError:
            pass
    candidates = [pictures] if pictures else []
    if os.environ.get('OneDrive'):
        candidates.append(Path(os.environ['OneDrive']) / 'Pictures')
    candidates += [Path.home() / 'OneDrive' / 'Pictures', Path.home() / 'Pictures']
    suffix = Path('Frontier Developments') / 'Elite Dangerous'
    for parent in candidates:
        candidate = parent / suffix
        if candidate.is_dir():
            return candidate
    return candidates[0] / suffix


def choose_folder(initial=None):
    """Cancellation never grants access to a guessed directory."""
    initial = Path(initial) if initial else suggested_folder()
    try:
        import tkinter as tk
        from tkinter import filedialog
        window = tk.Tk()
        window.title('Rhino Rig Layout Planner — screenshot folder')
        window.geometry('440x95')
        window.resizable(False, False)
        tk.Label(window, text='Choose the folder that receives your screenshots.\nCancel keeps the previous source unchanged.',
                 padx=18, pady=18).pack()
        window.attributes('-topmost', True)
        window.update()
        try:
            selected = filedialog.askdirectory(parent=window, title='Choose your screenshot folder',
                                               initialdir=str(initial), mustexist=True)
        finally:
            window.destroy()
        return local_folder(selected) if selected else None
    except (ImportError, RuntimeError) as error:
        print('Folder dialog unavailable: ' + str(error))
    except Exception as error:
        # Tcl may be absent on a minimal Python install. Keep the terminal path usable.
        print('Folder selection: ' + str(error))
    print('Suggested screenshot directory: ' + str(initial))
    try:
        answer = input('Enter the screenshot DIRECTORY, or press Enter to cancel: ').strip().strip('"')
    except (EOFError, OSError):
        return None
    return local_folder(answer) if answer else None


def default_settings():
    base = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / '.local' / 'share')))
    return base / 'RhinoRigPlanner' / 'settings.json'


class Settings:
    def __init__(self, path):
        self.path = Path(path)
        if str(self.path).startswith(('\\\\', '//')):
            raise ImageRefusal('Settings must stay on a local drive.')
        if os.name == 'nt':
            import ctypes
            if ctypes.windll.kernel32.GetDriveTypeW(self.path.absolute().anchor) == 4:
                raise ImageRefusal('Settings must stay on a local drive.')
        self.data = {'version': 1, 'folder': None, 'history': {}, 'preferences': DEFAULT_PREFERENCES.copy()}
        self.notice = ''
        if self.path.exists():
            try:
                if is_link(self.path.lstat()) or self.path.stat().st_size > MAX_SETTINGS_BYTES:
                    raise ValueError('Unsupported settings file')
                with self.path.open('rb') as saved:
                    raw = saved.read(MAX_SETTINGS_BYTES + 1)
                if len(raw) > MAX_SETTINGS_BYTES:
                    raise ValueError('Settings changed beyond the size limit')
                data = json.loads(raw.decode('utf-8'))
                if (not isinstance(data, dict) or not {'version', 'folder', 'history'} <= set(data) or
                        set(data) - {'version', 'folder', 'history', 'preferences'} or data['version'] != 1):
                    raise ValueError('Unsupported settings version')
                if data['folder'] is not None and (not isinstance(data['folder'], str) or len(data['folder']) > 1024):
                    raise ValueError('Invalid folder')
                history = data['history']
                if not isinstance(history, dict) or len(history) > 32:
                    raise ValueError('Invalid screenshot history')
                total = 0
                for folder_id, ids in history.items():
                    if not valid_id(folder_id) or not isinstance(ids, list) or len(ids) != len(set(ids)):
                        raise ValueError('Invalid screenshot history')
                    if not all(valid_id(item) for item in ids):
                        raise ValueError('Invalid image identity')
                    total += len(ids)
                if total > MAX_HISTORY:
                    raise ValueError('Screenshot history limit reached')
                data['preferences'] = validated_preferences(data.get('preferences', DEFAULT_PREFERENCES))
                self.data = data
            except (OSError, ValueError, TypeError, UnicodeError):
                self.notice = 'Saved configuration could not be read. Choose the screenshot folder again.'

    def save(self):
        data = (json.dumps(self.data, indent=2, sort_keys=True) + '\n').encode('utf-8')
        if len(data) > MAX_SETTINGS_BYTES:
            raise ImageRefusal('Local queue history is full. Existing records were preserved.')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for item in (self.path.parent, *self.path.parent.parents):
            if is_link(item.lstat()):
                raise ImageRefusal('Settings directory must not be a link.')
        if self.path.exists() and is_link(self.path.lstat()):
            raise ImageRefusal('Settings file must not be a link.')
        temporary = self.path.with_name(self.path.name + '.' + secrets.token_hex(8) + '.tmp')
        try:
            with temporary.open('xb') as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        finally:
            if temporary.exists():
                temporary.unlink()


def valid_id(value):
    return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


class ScreenshotQueue:
    def __init__(self, settings, folder=None, chooser=choose_folder, clock=time.monotonic):
        self.settings = settings
        self.folder = None
        self.folder_id = None
        self.chooser = chooser
        self.clock = clock
        self.lock = threading.RLock()
        self.entries = {}
        self.polls = {}
        self.unavailable = {}
        self.discovery_complete = False
        self.notice = settings.notice
        self.available = False
        self.complete = True
        if folder is not None:
            self.set_folder(folder)
        elif settings.data['folder']:
            # Retain an unavailable saved folder visibly, without choosing another.
            self.folder = Path(settings.data['folder'])
            self.folder_id = self.folder_key(self.folder)
            try:
                local_folder(self.folder)
                self.check_settings_outside(self.folder)
                self.available = True
            except (OSError, ImageRefusal):
                self.notice = 'Saved screenshot folder is unavailable. Reconnect it or choose Change screenshot folder.'

    @staticmethod
    def folder_key(path):
        return hashlib.sha256(os.path.normcase(str(path)).encode('utf-8')).hexdigest()

    def set_folder(self, selected):
        folder = local_folder(selected)
        self.check_settings_outside(folder)
        key = self.folder_key(folder)
        if key not in self.settings.data['history'] and len(self.settings.data['history']) >= 32:
            raise ImageRefusal('Folder history limit reached. Existing configuration was preserved.')
        with self.lock:
            prior = json.loads(json.dumps(self.settings.data))
            self.settings.data['folder'] = str(folder)
            self.settings.data['history'].setdefault(key, [])
            try:
                self.settings.save()
            except Exception:
                self.settings.data = prior
                raise
            self.folder, self.folder_id = folder, key
            self.entries, self.polls = {}, {}
            self.unavailable = {}
            self.discovery_complete = False
            self.available, self.complete = True, True
            self.notice = 'Waiting for completed screenshots.'

    def check_settings_outside(self, folder):
        absolute = self.settings.path.absolute()
        if absolute.is_relative_to(folder) or absolute.resolve().is_relative_to(folder.resolve()):
            raise ImageRefusal('Settings must be outside the screenshot folder. Select a dedicated screenshot directory.')

    def save_preferences(self, preferences):
        checked = validated_preferences(preferences)
        with self.lock:
            if self.folder:
                self.check_settings_outside(self.folder)
            previous = self.settings.data['preferences']
            self.settings.data['preferences'] = checked
            try:
                self.settings.save()
            except Exception:
                self.settings.data['preferences'] = previous
                raise

    def scan(self):
        with self.lock:
            if not self.folder:
                self.available = False
                self.notice = 'Choose a screenshot folder to begin.'
                return
            try:
                local_folder(self.folder)
                paths = []
                # Bound traversal too; no recursive scanning or arbitrary-file lookup.
                with os.scandir(self.folder) as iterator:
                    for count, item in enumerate(iterator):
                        if count >= MAX_FILES:
                            raise ImageRefusal('Folder contains more than 2,000 entries. Choose a smaller screenshot folder; rescan is incomplete.')
                        if Path(item.name).suffix.lower() in EXTENSIONS:
                            paths.append(self.folder / item.name)
                self.available, self.complete = True, True
            except (OSError, ImageRefusal) as error:
                self.available = False
                self.complete = False
                self.discovery_complete = False
                self.notice = public_error(error)
                return
            now = self.clock()
            present = set()
            processed = 0
            self.unavailable = {}
            self.discovery_complete = True
            for path in sorted(paths, key=lambda p: (p.name.casefold(), p.name)):
                present.add(path.name)
                try:
                    info = path.lstat()
                    if unsafe_image_entry(info) or not stat.S_ISREG(info.st_mode):
                        self.entries = {k: v for k, v in self.entries.items() if v['name'] != path.name}
                        self.polls.pop(path.name, None)
                        self.unavailable[path.name] = {'mtimeNs': info.st_mtime_ns, 'state': 'unavailable',
                            'detail': 'Unavailable or linked file. Make it available on this device; links are not opened.'}
                        continue
                    fingerprint = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
                    prior = self.polls.get(path.name)
                    if not prior or prior['fingerprint'] != fingerprint:
                        self.polls[path.name] = {'fingerprint': fingerprint, 'since': now, 'done': False}
                        self.entries = {k: v for k, v in self.entries.items() if v['name'] != path.name}
                        self.discovery_complete = False
                        continue
                    if now - prior['since'] < POLL_SECONDS:
                        self.discovery_complete = False
                    if (prior['done'] or now - prior['since'] < POLL_SECONDS or
                            now < prior.get('retry_at', 0)):
                        continue
                    if processed >= MAX_IMAGES_PER_POLL:
                        self.complete = False
                        self.discovery_complete = False
                        continue
                    processed += 1
                    prior['done'] = True
                    image, receipt = source_info(path, allowed_root=self.folder)
                    identity = [path.name, *fingerprint, receipt['sha256']]
                    image_id = hashlib.sha256(json.dumps(identity, separators=(',', ':')).encode('utf-8')).hexdigest()
                    self.entries[image_id] = {
                        'id': image_id, 'name': path.name, 'mtimeNs': info.st_mtime_ns,
                        'sha256': receipt['sha256'], 'format': receipt['detected_format'],
                        'sourceWidth': (receipt['decoded_dimensions'] or [None, None])[0],
                        'sourceHeight': (receipt['decoded_dimensions'] or [None, None])[1],
                        'width': (receipt['planner_dimensions'] or [None, None])[0],
                        'height': (receipt['planner_dimensions'] or [None, None])[1],
                        'state': 'candidate', 'fingerprint': fingerprint,
                    }
                    del image
                except OSError as error:
                    self.entries = {k: v for k, v in self.entries.items() if v['name'] != path.name}
                    retry = self.polls.get(path.name)
                    if retry is not None:
                        retry['done'] = False
                        retry['failures'] = min(retry.get('failures', 0) + 1, 6)
                        retry['retry_at'] = now + min(30.0, POLL_SECONDS * 2 ** (retry['failures'] - 1))
                        retry['problem'] = 'Image temporarily unavailable; bounded retry is active.'
                    self.unavailable[path.name] = {'mtimeNs': 0, 'state': 'unavailable',
                        'detail': 'Image temporarily unavailable; bounded retry is active.'}
                    self.notice = 'Some images are temporarily unavailable. Ready neighbors remain browsable.'
                except ValueError as error:
                    retry = self.polls.get(path.name)
                    if retry is not None:
                        retry['problem'] = 'Image content is incomplete, invalid or unsupported. A changed file is checked again.'
                    self.notice = 'Some images could not be decoded. Ready neighbors remain browsable.'
            self.polls = {k: v for k, v in self.polls.items() if k in present}
            self.entries = {k: v for k, v in self.entries.items() if v['name'] in present}

    def state(self):
        with self.lock:
            history = self.settings.data['history'].get(self.folder_id, [])
            images = []
            for record in sorted(self.entries.values(), key=lambda x: (x['mtimeNs'], x['name'].casefold(), x['name'], x['id'])):
                images.append({**{k: v for k, v in record.items() if k != 'fingerprint'}, 'loaded': record['id'] in history})
            files = images[:]
            included = {record['name'] for record in images}
            for name, item in self.polls.items():
                if name in included:
                    continue
                fingerprint = item['fingerprint']
                record_id = hashlib.sha256(json.dumps([name, *fingerprint, 'checking'], separators=(',', ':')).encode('utf-8')).hexdigest()
                files.append({'id': record_id, 'name': name, 'mtimeNs': fingerprint[3],
                              'state': 'rejected' if item['done'] else 'pending',
                              'detail': item.get('problem', 'Waiting for a stable, completed file.'), 'loaded': False})
                included.add(name)
            for name, item in self.unavailable.items():
                if name not in included:
                    record_id = hashlib.sha256((str(self.folder_id) + name).encode('utf-8')).hexdigest()
                    files.append({'id': record_id, 'name': name, **item, 'loaded': False})
            files.sort(key=lambda x: (x['mtimeNs'], x['name'].casefold(), x['name'], x['id']))
            return {'folder': str(self.folder) if self.folder else '', 'folderAvailable': self.available,
                    'notice': self.notice, 'images': images, 'history': history[:],
                    'files': files, 'discoveryComplete': self.discovery_complete,
                    'preferences': self.settings.data['preferences'].copy(),
                    'pending': sum(v['state'] == 'ready' and not v['loaded'] for v in images) if self.available else 0,
                    'scanComplete': self.complete}

    def image(self, image_id):
        with self.lock:
            if not valid_id(image_id) or image_id not in self.entries or not self.available:
                raise ImageRefusal('Screenshot is unavailable. Refresh or choose the folder again.')
            record = self.entries[image_id]
            path = self.folder / record['name']
            info = path.lstat()
            if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != tuple(record['fingerprint']):
                self.entries.pop(image_id, None)
                self.polls.pop(path.name, None)
                raise ImageRefusal('Screenshot changed. Wait for it to become stable and refresh.')
            data, receipt = source_info(path, allowed_root=self.folder)
            if receipt['sha256'] != record['sha256']:
                self.entries.pop(image_id, None)
                self.polls.pop(path.name, None)
                raise ImageRefusal('Screenshot content changed. Refresh before loading it.')
            return {**{k: v for k, v in record.items() if k != 'fingerprint'}, 'dataUrl': data.decode('ascii')}

    def validated(self, body):
        with self.lock:
            image_id = body.get('id')
            if image_id not in self.entries:
                raise ImageRefusal('Screenshot changed or is unavailable. Refresh.')
            item = self.entries[image_id]
            if body.get('ok') is not True:
                item['state'] = 'rejected'
                self.notice = 'Image could not be decoded: ' + item['name'] + '. Your current work is unchanged.'
                return
            width, height = body.get('width'), body.get('height')
            if (type(width) is not int or type(height) is not int or min(width, height) < 1 or
                    max(width, height) > 25000 or width * height > 130_000_000):
                raise ImageRefusal('Decoded image dimensions are unsupported.')
            if item['width'] is not None and (width, height) != (item['width'], item['height']):
                raise ImageRefusal('Decoded dimensions do not match the image.')
            item['width'], item['height'] = width, height
            if item['sourceWidth'] is None:
                item['sourceWidth'], item['sourceHeight'] = width, height
            item['state'] = 'ready'
            self.notice = 'Screenshots are ready. Loading one will not discard work without asking.'

    def loaded(self, image_id):
        with self.lock:
            if image_id not in self.entries or self.entries[image_id]['state'] != 'ready':
                raise ImageRefusal('Image has not passed decoding. Current work was preserved.')
            history = self.settings.data['history'].setdefault(self.folder_id, [])
            if image_id in history:
                return
            if sum(map(len, self.settings.data['history'].values())) >= MAX_HISTORY:
                raise ImageRefusal('Local queue history is full. Previous records were preserved.')
            history.append(image_id)
            try:
                self.settings.save()
            except Exception:
                history.pop()
                raise


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, queue, page, port=0):
        super().__init__(('127.0.0.1', port), Handler)
        self.queue = queue
        self.page = page
        self.token = secrets.token_urlsafe(32)
        self.origin = 'http://127.0.0.1:' + str(self.server_address[1])
        self.stopping = threading.Event()
        self.dialog_lock = threading.Lock()

    def monitor(self):
        while not self.stopping.is_set():
            self.queue.scan()
            self.stopping.wait(POLL_SECONDS)

    def stop(self):
        self.stopping.set()
        self.shutdown()


class Handler(BaseHTTPRequestHandler):
    server_version = 'LocalImageViewer'

    def log_message(self, *args):
        pass

    def send(self, code, data, content_type='application/json; charset=utf-8'):
        if not isinstance(data, bytes):
            data = json.dumps(data, ensure_ascii=True).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('X-Frame-Options', 'DENY')
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def allowed(self, api=False, mutation=False):
        expected = urlsplit(self.server.origin).netloc
        if self.client_address[0] != '127.0.0.1' or self.headers.get('Host') != expected:
            return False
        if self.headers.get('Sec-Fetch-Site') not in (None, 'same-origin', 'none'):
            return False
        origin = self.headers.get('Origin')
        if origin is not None and origin != self.server.origin:
            return False
        if mutation and origin != self.server.origin:
            return False
        if api and not secrets.compare_digest(self.headers.get('X-Rig-Token', ''), self.server.token):
            return False
        return True

    def do_GET(self):
        route = urlsplit(self.path)
        if not self.allowed(api=route.path.startswith('/api/')):
            self.send(403, {'error': 'Local authorization required.'})
            return
        try:
            if route.path == '/' and not route.query:
                page = self.server.page.replace("connect-src 'none'", "connect-src 'self'")
                self.send(200, page.encode('utf-8'), 'text/html; charset=utf-8')
            elif route.path == '/api/state' and not route.query:
                self.send(200, self.server.queue.state())
            elif route.path == '/api/image':
                args = parse_qs(route.query, strict_parsing=True)
                if set(args) != {'id'} or len(args['id']) != 1:
                    raise ImageRefusal('Only an existing image identity can be requested.')
                self.send(200, self.server.queue.image(args['id'][0]))
            else:
                self.send(404, {'error': 'Unknown local endpoint.'})
        except (OSError, ValueError) as error:
            self.send(409, {'error': public_error(error)})

    def do_POST(self):
        if not self.allowed(api=True, mutation=True):
            self.send(403, {'error': 'Local authorization and same-origin request required.'})
            return
        try:
            if self.headers.get('Content-Type') != 'application/json':
                raise ImageRefusal('Expected a JSON request.')
            size = int(self.headers.get('Content-Length', '-1'))
            if size < 0 or size > MAX_BODY or self.headers.get('Transfer-Encoding'):
                raise ImageRefusal('Request size is unsupported.')
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ImageRefusal('Expected an object.')
            queue = self.server.queue
            if self.path == '/api/validated' and set(body) <= {'id', 'ok', 'width', 'height'}:
                queue.validated(body)
            elif self.path == '/api/loaded' and set(body) == {'id'}:
                queue.loaded(body['id'])
            elif self.path == '/api/preferences' and set(body) == {'preferences'}:
                queue.save_preferences(body['preferences'])
            elif self.path == '/api/refresh' and not body:
                queue.scan()
            elif self.path == '/api/change-folder' and not body:
                if not self.server.dialog_lock.acquire(blocking=False):
                    raise ImageRefusal('Folder selection is already open.')
                try:
                    selected = queue.chooser(queue.folder)
                    if selected:
                        queue.set_folder(selected)
                    else:
                        queue.notice = 'Folder selection canceled. The previous source is unchanged.'
                finally:
                    self.server.dialog_lock.release()
            elif self.path == '/api/stop' and not body:
                self.send(200, {'stopped': True})
                threading.Thread(target=self.server.stop, daemon=True).start()
                return
            else:
                self.send(404, {'error': 'Unknown local action.'})
                return
            self.send(200, queue.state())
        except (OSError, ValueError, TypeError) as error:
            self.send(409, {'error': public_error(error)})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=Path, help='Explicitly select this local screenshot directory')
    parser.add_argument('--settings', type=Path, default=default_settings())
    parser.add_argument('--change-folder', action='store_true')
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args(argv)
    if os.sys.version_info < (3, 10):
        parser.error('Python 3.10 or newer is required. Open index.html for manual mode.')
    instance_lock = None
    try:
        from windowed_launcher import InstanceLock
        settings = Settings(args.settings)
        instance_lock = InstanceLock(args.settings, args.folder or settings.data['folder'])
        queue = ScreenshotQueue(settings, args.folder)
        if args.change_folder or not queue.folder:
            selected = choose_folder(queue.folder)
            if not selected:
                print('Folder selection canceled. No screenshot source was opened.')
                return 0
            queue.set_folder(selected)
        page = (Path(__file__).resolve().parents[1] / 'index.html').read_text(encoding='utf-8')
        server = LocalServer(queue, page)
        monitor = threading.Thread(target=server.monitor, daemon=True)
        monitor.start()
        url = server.origin + '/#rig-token=' + server.token
        print('Rhino Rig Layout Planner — local-only screenshot viewer', flush=True)
        print('Open: ' + url, flush=True)
        print('Stop with the viewer Quit control or Ctrl+C in this window.', flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever(poll_interval=0.2)
        except KeyboardInterrupt:
            pass
        finally:
            server.stopping.set()
            server.server_close()
            monitor.join(timeout=3)
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print('Planner could not start: ' + (str(error) if isinstance(error, RuntimeError) else public_error(error)), file=os.sys.stderr)
        return 2
    finally:
        if instance_lock:
            instance_lock.close()


if __name__ == '__main__':
    raise SystemExit(main())

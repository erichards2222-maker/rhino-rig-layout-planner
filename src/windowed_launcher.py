"""Visible, opt-in local launcher. No background startup or package installation."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import os
from pathlib import Path
import queue as message_queue
import threading
import webbrowser

from screenshot_companion import (Settings, ScreenshotQueue, LocalServer, default_settings,
                                  suggested_folder, local_folder, public_error)


class InstanceLock:
    """An OS-held lock is released even after an interrupted launcher exit."""

    def __init__(self, settings_path, forbidden_folder=None):
        self.handle = None
        self.file = None
        if forbidden_folder is not None:
            folder = Path(forbidden_folder).absolute()
            path = Path(settings_path).absolute()
            if path.is_relative_to(folder) or path.resolve().is_relative_to(folder.resolve()):
                raise OSError('Configuration must stay outside the screenshot folder.')
        key = hashlib.sha256(os.path.normcase(str(Path(settings_path).absolute())).encode('utf-8')).hexdigest()
        if os.name == 'nt':
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
            kernel.CreateMutexW.restype = ctypes.c_void_p
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            handle = kernel.CreateMutexW(None, False, 'Local\\RhinoRigPlanner-' + key)
            if not handle:
                raise OSError('The launcher lock could not be created.')
            if ctypes.get_last_error() == 183:
                kernel.CloseHandle(handle)
                raise RuntimeError('The planner launcher is already open. Use its Open planner button or Quit it first.')
            self.handle, self.kernel = handle, kernel
        else:
            import fcntl
            directory = Path(settings_path).absolute().parent
            directory.mkdir(parents=True, exist_ok=True)
            if any(part.is_symlink() for part in (directory, *directory.parents)):
                raise OSError('Launcher configuration directory must not be linked.')
            path = directory / 'launcher.lock'
            flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0)
            file = os.fdopen(os.open(path, flags, 0o600), 'r+b')
            try:
                fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                file.close()
                raise RuntimeError('The planner launcher is already open. Quit it first.') from None
            self.file = file

    def close(self):
        if self.handle is not None:
            self.kernel.CloseHandle(self.handle)
            self.handle = None
        if self.file is not None:
            self.file.close()
            self.file = None


class CompanionService:
    """Own every worker and close the socket when the visible owner exits."""

    def __init__(self, screenshot_queue, page):
        self.server = LocalServer(screenshot_queue, page)
        self.worker = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .1}, daemon=True)
        self.monitor = threading.Thread(target=self.server.monitor, daemon=True)
        self.worker.start()
        self.monitor.start()

    @property
    def url(self):
        return self.server.origin + '/#rig-token=' + self.server.token

    def close(self):
        self.server.stopping.set()
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(timeout=3)
        self.monitor.join(timeout=3)


class WindowedLauncher:
    def __init__(self, window, settings_path, folder=None, open_browser=True):
        import tkinter as tk
        from tkinter import ttk
        self.window = window
        self.service = None
        self.closed = False
        self.lock = None
        self.dialogs = message_queue.Queue()
        self.window.title('Rhino Rig Layout Planner')
        self.window.geometry('570x270')
        self.window.minsize(450, 245)
        self.window.protocol('WM_DELETE_WINDOW', self.quit)
        panel = ttk.Frame(window, padding=18)
        panel.pack(fill='both', expand=True)
        ttk.Label(panel, text='Rhino Rig Layout Planner', font=('Segoe UI', 15)).pack(anchor='w')
        ttk.Label(panel, text='Local-only screenshot viewer. Keep this window open.').pack(anchor='w', pady=(6, 12))
        self.status = tk.StringVar(value='Starting local companion...')
        self.folder_text = tk.StringVar(value='No screenshot folder selected')
        ttk.Label(panel, textvariable=self.status, wraplength=520).pack(anchor='w')
        ttk.Label(panel, textvariable=self.folder_text, wraplength=520).pack(anchor='w', pady=(8, 14))
        buttons = ttk.Frame(panel)
        buttons.pack(anchor='w')
        self.open_button = ttk.Button(buttons, text='Open planner', command=self.open_planner)
        self.open_button.pack(side='left', padx=(0, 8))
        ttk.Button(buttons, text='Change screenshot folder', command=self.change_folder).pack(side='left', padx=(0, 8))
        ttk.Button(buttons, text='Quit', command=self.quit).pack(side='left')
        self.open_button.state(['disabled'])
        self.window.update_idletasks()
        # Map the visible owner before a modal chooser opens on first launch.
        self.window.update()
        if self.closed:
            return
        try:
            settings = Settings(settings_path)
            self.lock = InstanceLock(settings_path, folder or settings.data['folder'])
            self.queue = ScreenshotQueue(settings, folder, chooser=self.threaded_choose)
            if not self.queue.folder:
                selected = self.choose(None)
                if selected:
                    self.queue.set_folder(selected)
            page = (Path(__file__).resolve().parents[1] / 'index.html').read_text(encoding='utf-8')
            self.service = CompanionService(self.queue, page)
            self.open_button.state(['!disabled'])
            self.window.after(100, self.tick)
            if open_browser:
                self.window.after(200, self.open_planner)
        except Exception as error:
            from tkinter import messagebox
            self.status.set('Planner could not start. No service is running.')
            messagebox.showerror('Planner could not start', self.startup_error(error), parent=window)
            self.quit()

    @staticmethod
    def startup_error(error):
        if isinstance(error, RuntimeError):
            return str(error)
        return public_error(error) + '\nOpen index.html for manual image selection, or use the diagnostics launcher.'

    def choose(self, initial):
        from tkinter import filedialog, messagebox
        try:
            result = filedialog.askdirectory(parent=self.window, title='Choose your screenshot folder',
                                            initialdir=str(initial or suggested_folder()), mustexist=True)
            return local_folder(result) if result else None
        except Exception as error:
            messagebox.showerror('Screenshot folder', public_error(error), parent=self.window)
            return None

    def threaded_choose(self, initial):
        # HTTP workers enqueue requests; only the GUI thread touches native dialogs.
        event = threading.Event()
        result = []
        self.dialogs.put((initial, event, result))
        while not event.wait(.1):
            if self.closed:
                return None
        return result[0] if result else None

    def tick(self):
        if self.closed:
            return
        if self.service.server.stopping.is_set():
            self.status.set('Companion stopped. Close this window to finish.')
            self.open_button.state(['disabled'])
        else:
            state = self.queue.state()
            self.status.set('Connected locally — ' + str(len(state['images'])) + ' checked image(s).' if state['folderAvailable']
                            else 'Screenshot folder unavailable. Choose a folder or reconnect its drive.')
            self.folder_text.set(state['folder'] or 'No screenshot folder selected')
        try:
            initial, event, result = self.dialogs.get_nowait()
        except message_queue.Empty:
            pass
        else:
            try:
                result.append(self.choose(initial))
            finally:
                event.set()
        self.window.after(250, self.tick)

    def change_folder(self):
        if self.service is None or self.closed or self.service.server.stopping.is_set():
            return
        if not self.service.server.dialog_lock.acquire(blocking=False):
            return
        try:
            selected = self.choose(self.queue.folder)
            if selected:
                try:
                    self.queue.set_folder(selected)
                except Exception as error:
                    from tkinter import messagebox
                    messagebox.showerror('Screenshot folder', public_error(error), parent=self.window)
        finally:
            self.service.server.dialog_lock.release()

    def open_planner(self):
        if self.service is None or self.closed or self.service.server.stopping.is_set():
            return
        try:
            opened = webbrowser.open(self.service.url)
        except Exception:
            opened = False
        if not opened:
            from tkinter import messagebox
            messagebox.showerror('Browser unavailable', 'Choose a default browser in Windows Settings and try Open planner again. '
                                 'You can also open index.html for manual mode.', parent=self.window)

    def quit(self):
        if self.closed:
            return
        from tkinter import messagebox
        if self.service and not self.service.server.stopping.is_set():
            if not messagebox.askokcancel('Quit local companion?', 'Save any unsaved analysis in the browser first. '
                                         'Quit closes the screenshot connection; the open image stays in the browser.', parent=self.window):
                return
        self.closed = True
        if self.service:
            self.service.close()
        if self.lock:
            self.lock.close()
        self.window.destroy()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--settings', type=Path, default=default_settings())
    parser.add_argument('--folder', type=Path)
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args(argv)
    try:
        import tkinter as tk
        window = tk.Tk()
    except Exception:
        # A native message remains visible even when Python lacks Tcl/Tk.
        message = 'The windowed planner requires Python 3.10+ with Tcl/Tk. Open index.html for manual mode, or run the diagnostics launcher.'
        if os.name == 'nt':
            ctypes.windll.user32.MessageBoxW(None, message, 'Rhino Rig Layout Planner', 0x10)
        else:
            print(message)
        return 2
    if os.sys.version_info < (3, 10):
        from tkinter import messagebox
        messagebox.showerror('Python version', 'Python 3.10 or newer is required. Open index.html for manual mode.', parent=window)
        window.destroy()
        return 2
    WindowedLauncher(window, args.settings, args.folder, not args.no_browser)
    window.mainloop()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

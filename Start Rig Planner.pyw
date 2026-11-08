"""Double-click with an installed Python 3.10+ windowed file association."""
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / 'src'))

try:
    from windowed_launcher import main
    raise SystemExit(main())
except Exception:
    message = ('The planner could not start. Keep the extracted files together and use Python 3.10+ with Tcl/Tk. '
               'Open index.html for manual mode, or run DIAGNOSTICS_RIG_PLANNER.cmd for troubleshooting.')
    if os.name == 'nt':
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, message, 'Rhino Rig Layout Planner', 0x10)
    else:
        print(message)

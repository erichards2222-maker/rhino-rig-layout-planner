@echo off
setlocal
echo Rhino Rig Layout Planner - optional diagnostics console
echo Normal startup: double-click Start Rig Planner.pyw
where py >nul 2>nul
if not errorlevel 1 (
    py -3 -B "%~dp0src\screenshot_companion.py" %*
    goto finished
)
where python >nul 2>nul
if not errorlevel 1 (
    python -B "%~dp0src\screenshot_companion.py" %*
    goto finished
)
echo Python 3.10 or newer was not found. Open index.html for manual mode.
echo This launcher does not install Python or change Windows security settings.
:finished
echo.
echo The local connection has stopped. Any diagnostic output above stays on this PC.
pause
endlocal

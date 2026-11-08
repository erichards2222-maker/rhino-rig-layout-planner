@echo off
setlocal
echo This compatibility entry opens the optional diagnostics console.
echo For normal windowed startup, double-click Start Rig Planner.pyw.
call "%~dp0DIAGNOSTICS_RIG_PLANNER.cmd" %*
endlocal

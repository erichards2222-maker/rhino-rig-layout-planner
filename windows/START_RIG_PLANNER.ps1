# Starts a local screenshot viewer only when this launcher is explicitly run.
[CmdletBinding()]
param(
    [string]$ScreenshotFolder,
    [string]$PythonExecutable = 'python',
    [string]$SettingsPath,
    [switch]$ChangeFolder,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$helperArgs = @((Join-Path $root 'src\screenshot_companion.py'))
if ($ScreenshotFolder) { $helperArgs += @('--folder', $ScreenshotFolder) }
if ($SettingsPath) { $helperArgs += @('--settings', $SettingsPath) }
if ($ChangeFolder) { $helperArgs += '--change-folder' }
if ($NoBrowser) { $helperArgs += '--no-browser' }
$prefix = @()
if (-not (Get-Command $PythonExecutable -ErrorAction SilentlyContinue)) {
    if ($PythonExecutable -eq 'python' -and (Get-Command 'py' -ErrorAction SilentlyContinue)) {
        $PythonExecutable = 'py'; $prefix = @('-3')
    } else {
        throw 'Python 3.10 or newer is needed for the optional screenshot queue. Open index.html for manual image selection without Python.'
    }
}
& $PythonExecutable @prefix -B @helperArgs
exit $LASTEXITCODE

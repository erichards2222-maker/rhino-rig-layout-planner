# Rhino Rig Layout Planner — local image launcher.
# Select the newest supported screenshot and open a separate local result.
param(
    [string]$ScreenshotFolder = (Join-Path $HOME 'OneDrive\Pictures\Frontier Developments\Elite Dangerous'),
    [string]$PythonExecutable = '',
    [string]$OutputFolder = (Join-Path $HOME 'Rig_Planner_Outputs'),
    [switch]$NoOpen
)
& {
    $ErrorActionPreference = 'Stop'
    # Launcher is in windows/; source lives in the repository's sibling src/ directory.
    $projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
    $script = Join-Path $projectRoot 'src\image_planner.py'
    $template = Join-Path $projectRoot 'src\planner_template.html'
    if (-not (Test-Path -LiteralPath $ScreenshotFolder -PathType Container)) { throw 'SCREENSHOT_FOLDER_NOT_FOUND' }
    if (-not (Test-Path -LiteralPath $script -PathType Leaf) -or -not (Test-Path -LiteralPath $template -PathType Leaf)) { throw 'PLANNER_SOURCE_MISSING' }
    if ($PythonExecutable) {
        if (-not (Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) { throw 'PYTHON_EXECUTABLE_NOT_FOUND' }
        $executable = $PythonExecutable
        $prefix = @()
    } else {
        $pyCommand = Get-Command 'py' -ErrorAction SilentlyContinue
        if ($pyCommand) { $executable = $pyCommand.Source; $prefix = @('-3') }
        else {
            $pythonCommand = Get-Command 'python' -ErrorAction SilentlyContinue
            if (-not $pythonCommand) { throw 'PYTHON_NOT_FOUND: Supply -PythonExecutable explicitly' }
            $executable = $pythonCommand.Source
            $prefix = @()
        }
    }
    Write-Output ('SCREENSHOT_FOLDER=' + $ScreenshotFolder)
    Write-Output 'READ_ONLY_INPUT=TRUE; ONE_LATEST_IMAGE_ONLY=TRUE; LOCAL_IMAGE_MODE=TRUE'
    $viewerOptions = @()
    if ($NoOpen) { $viewerOptions += '--no-open' }
    & $executable @prefix -B $script --folder $ScreenshotFolder --output-root $OutputFolder @viewerOptions
    if ($LASTEXITCODE -ne 0) { throw 'SCREENSHOT_PLANNER_STOP_PRESERVE_SOURCE' }
}

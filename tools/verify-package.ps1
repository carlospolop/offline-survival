param([Parameter(Mandatory = $true)][string]$ArtifactDir)

# Smoke-test a generated Windows .msi the way a user would: install it for real,
# launch the installed app, and confirm an actual application window appears (not
# just that the process is alive). A screenshot is saved under verify-screenshots.
# Exits non-zero on failure so CI can gate the release on it.
$ErrorActionPreference = 'Stop'

function Fail($message) { Write-Host "VERIFY FAILED: $message"; exit 1 }

$ArtifactDir = (Resolve-Path $ArtifactDir).Path
$shotDir = if ($env:VERIFY_SHOT_DIR) { $env:VERIFY_SHOT_DIR } else { Join-Path (Get-Location) 'verify-screenshots' }
New-Item -ItemType Directory -Force -Path $shotDir | Out-Null

$msi = Get-ChildItem -Path $ArtifactDir -Recurse -Filter *.msi | Select-Object -First 1
if (-not $msi) { Fail "no .msi found in artifact" }
Write-Host "Found MSI: $($msi.FullName)"

# Real, silent install (per-machine, into Program Files).
$log = Join-Path $env:RUNNER_TEMP 'msi-install.log'
$installer = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @(
  '/i', "`"$($msi.FullName)`"", '/quiet', '/norestart', '/l*v', "`"$log`""
)
if ($installer.ExitCode -ne 0) {
  if (Test-Path $log) { Get-Content $log -Tail 60 | Write-Host }
  Fail "msiexec install failed (exit $($installer.ExitCode))"
}
Write-Host "MSI installed successfully"

# Locate the installed application executable (exclude the sca-node sidecar).
$searchRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ -and (Test-Path $_) }
$exe = Get-ChildItem -Path $searchRoots -Recurse -Filter *.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notmatch 'sca-node' -and ($_.FullName -match 'Offline' -or $_.Name -match 'survival') } |
  Select-Object -First 1
if (-not $exe) { Fail "could not find the installed application .exe" }
Write-Host "Installed app exe: $($exe.FullName)"

Write-Host "Launching the installed app"
$app = Start-Process -FilePath $exe.FullName -PassThru
$hasWindow = $false
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 1
  $app.Refresh()
  if ($app.HasExited) { break }
  if ($app.MainWindowHandle -ne 0) { $hasWindow = $true; break }
}

# Capture the screen for evidence.
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bmp.Save((Join-Path $shotDir 'windows.png'))
  $gfx.Dispose(); $bmp.Dispose()
} catch { Write-Host "screenshot capture skipped: $_" }

if ($app.HasExited) { Fail "the app exited early (exit $($app.ExitCode)) — likely a missing DLL or startup crash" }
if (-not $hasWindow) {
  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  Fail "no application window appeared within 45s (the app did not render a window)"
}

Write-Host "Application window detected (handle $($app.MainWindowHandle)) — OK"
Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
Get-Process -Name 'sca-node' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "Windows package verification passed"

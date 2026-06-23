param([Parameter(Mandatory = $true)][string]$ArtifactDir)

# Smoke-test a generated Windows .msi the way a user would: unpack the installer,
# confirm the application executable is present, and launch it to confirm it
# starts without a missing-DLL/startup crash. Exits non-zero on failure so CI can
# gate the release on it.
$ErrorActionPreference = 'Stop'

function Fail($message) { Write-Host "VERIFY FAILED: $message"; exit 1 }

$ArtifactDir = (Resolve-Path $ArtifactDir).Path
$msi = Get-ChildItem -Path $ArtifactDir -Recurse -Filter *.msi | Select-Object -First 1
if (-not $msi) { Fail "no .msi found in artifact" }
Write-Host "Found MSI: $($msi.FullName)"

# Administrative install extracts the payload without registering a real install.
$extract = Join-Path $env:RUNNER_TEMP 'osv-extract'
if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
New-Item -ItemType Directory -Force -Path $extract | Out-Null
$log = Join-Path $env:RUNNER_TEMP 'msi-extract.log'

$proc = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @(
  '/a', "`"$($msi.FullName)`"", '/qn', "TARGETDIR=`"$extract`"", '/l*v', "`"$log`""
)
if ($proc.ExitCode -ne 0) {
  if (Test-Path $log) { Get-Content $log -Tail 40 | Write-Host }
  Fail "msiexec administrative install failed (exit $($proc.ExitCode))"
}

$exe = Get-ChildItem -Path $extract -Recurse -Filter *.exe |
  Where-Object { $_.Name -notmatch 'sca-node' } |
  Select-Object -First 1
if (-not $exe) { Fail "no application .exe found after extraction" }
Write-Host "Application exe: $($exe.FullName)"

# Launch briefly. A missing DLL or startup crash makes the process exit early.
$app = Start-Process -FilePath $exe.FullName -PassThru
Start-Sleep -Seconds 15
if ($app.HasExited) {
  Fail "application exited early (exit $($app.ExitCode)) — likely a missing DLL or startup crash"
}

Write-Host "Application still running after 15s — OK"
Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
Get-Process -Name 'sca-node' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "Windows package verification passed"

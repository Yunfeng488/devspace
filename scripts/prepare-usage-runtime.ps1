[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RuntimeDirectory,
  [Parameter(Mandatory = $true)][string]$Python311,
  [Parameter(Mandatory = $true)][string]$ReleaseDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$expectedRuntimePath = [System.IO.Path]::GetFullPath('H:\workbuddy\runtime\devspace-usage').TrimEnd('\\')
$runtimePath = [System.IO.Path]::GetFullPath($RuntimeDirectory).TrimEnd('\\')
$releasePath = [System.IO.Path]::GetFullPath($ReleaseDirectory)
if (-not [string]::Equals($runtimePath, $expectedRuntimePath, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "RuntimeDirectory must be the approved path: $expectedRuntimePath"
}
function Assert-NoReparsePointInExistingAncestors([string]$Path) {
  $root = [System.IO.Path]::GetPathRoot($Path)
  $relative = $Path.Substring($root.Length).TrimStart('\\')
  $current = $root
  foreach ($segment in $relative.Split('\\', [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $current = Join-Path $current $segment
    if (-not (Test-Path -LiteralPath $current)) { break }
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "RuntimeDirectory cannot traverse a reparse point: $current"
    }
  }
}
Assert-NoReparsePointInExistingAncestors $runtimePath
$manifestPath = Join-Path $releasePath 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Deployment manifest is missing: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schema_version -ne 1 -or $manifest.metric_scope -ne 'MCP_MODEL_VISIBLE_PAYLOAD_ESTIMATE') {
  throw 'Deployment manifest identity is invalid'
}
foreach ($entry in $manifest.files) {
  if ([System.IO.Path]::GetFileName([string]$entry.file) -ne [string]$entry.file) { throw 'Manifest file path must be a basename' }
  $artifactPath = Join-Path $releasePath ([string]$entry.file)
  if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) { throw "Manifest artifact is missing: $artifactPath" }
  $artifact = Get-Item -LiteralPath $artifactPath
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifactPath).Hash.ToLowerInvariant()
  if ($artifact.Length -ne [long]$entry.bytes -or $actualHash -ne [string]$entry.sha256) {
    throw "Manifest integrity check failed: $artifactPath"
  }
}
$workerPath = Join-Path $releasePath 'tiktoken-worker.py'
$requirementsPath = Join-Path $releasePath 'requirements-usage-tokenizer.txt'
$prewarmPath = Join-Path $releasePath 'prewarm-usage-tokenizer.py'
foreach ($required in @($Python311, $workerPath, $requirementsPath, $prewarmPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required file is missing: $required" }
}

New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
function Set-PrivateAcl([string]$Path, [bool]$Directory) {
  $acl = if ($Directory) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
  $acl.SetAccessRuleProtection($true, $false)
  $inheritance = if ($Directory) { 'ContainerInherit,ObjectInherit' } else { 'None' }
  foreach ($identity in @($currentIdentity, 'NT AUTHORITY\SYSTEM')) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inheritance, 'None', 'Allow')
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
Set-PrivateAcl -Path $runtimePath -Directory $true

$identityKey = Join-Path $runtimePath 'identity.key'
if (-not (Test-Path -LiteralPath $identityKey)) {
  $key = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($key)
  [System.IO.File]::WriteAllBytes($identityKey, $key)
}
Set-PrivateAcl -Path $identityKey -Directory $false

$venv = Join-Path $runtimePath 'venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $venvPython)) {
  & $Python311 -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw "Python virtual environment creation failed with exit code $LASTEXITCODE" }
}
& $venvPython -m pip install -r $requirementsPath
if ($LASTEXITCODE -ne 0) { throw "Tokenizer dependency installation failed with exit code $LASTEXITCODE" }
$cache = Join-Path $runtimePath 'tiktoken-cache'
& $venvPython $prewarmPath --cache-dir $cache
if ($LASTEXITCODE -ne 0) { throw "Tokenizer cache prewarm failed with exit code $LASTEXITCODE" }

$workerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $workerPath).Hash.ToLowerInvariant()
[pscustomobject]@{
  runtime_directory = $runtimePath
  python = $venvPython
  worker = $workerPath
  worker_sha256 = $workerHash
  cache = $cache
} | ConvertTo-Json -Compress

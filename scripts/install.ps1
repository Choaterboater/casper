# Casper installer for Windows.
#
#   [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://github.com/Choaterboater/casper/releases/download/v0.2.0/install.ps1 | iex
#
# Downloads the self-contained casper-windows-x64.exe, verifies its SHA-256 against the
# release's SHA256SUMS, installs it under %LOCALAPPDATA%\Programs\casper and adds that
# directory to the user PATH. Re-running the same command updates in place.
#
# Environment only: this script takes no flags. install.sh also accepts --dir,
# --version, --sha256 and --force; on Windows the install target is casper.exe rather
# than a development symlink, so there is no --force analogue: an existing casper.exe
# link that leaves the install directory (or points into a .scratch checkout) is
# reported and never replaced. See docs/RELEASE.md.
#
# Environment:
#   CASPER_BASE_URL     Directory holding the artifacts (default: the release host below).
#   CASPER_INSTALL_DIR  Install directory (default: %LOCALAPPDATA%\Programs\casper).
#   CASPER_VERSION      Required installed version; the installer fails on any other.
#   CASPER_SHA256       Expected digest, when SHA256SUMS cannot be fetched.
#
# Installer and startup smoke checks run on Windows CI with PowerShell 5.1 and 7.
# This does not certify all interactive/optional features (see docs/RELEASE.md).
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [version]'5.1') {
  throw 'Windows PowerShell 5.1 or newer is required.'
}
# Windows PowerShell 5.1 may otherwise negotiate an obsolete TLS version.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# GitHub's latest/download excludes prereleases; this preview pins an explicit tag.
$BaseUrl = if ($env:CASPER_BASE_URL) { $env:CASPER_BASE_URL } else { 'https://github.com/Choaterboater/casper/releases/download/v0.2.0' }
$InstallDir = if ($env:CASPER_INSTALL_DIR) { $env:CASPER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\casper' }
$Version = $env:CASPER_VERSION
$ExpectedSha = $env:CASPER_SHA256

# PROCESSOR_ARCHITECTURE is x86 inside a 32-bit shell even on 64-bit Windows; the
# "W6432" companion variable is what identifies the real machine.
$MachineArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$Arch = switch ($MachineArch) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { throw "Unsupported architecture: $MachineArch" }
}
if ($Arch -ne 'x64') { throw "No published Windows artifact for $Arch; only casper-windows-x64.exe is built." }
$Artifact = 'casper-windows-x64.exe'

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("casper-install-" + [guid]::NewGuid().ToString('N'))
# An interrupted update must not leave the staged download behind.
$Staged = $null
$PreviousProgressPreference = $ProgressPreference
try {
  # Rendering per-chunk progress makes large downloads extremely slow in PS 5.1.
  $ProgressPreference = 'SilentlyContinue'
  New-Item -ItemType Directory -Path $Tmp | Out-Null
  Write-Host "Downloading $Artifact from $BaseUrl"
  $ArtifactPath = Join-Path $Tmp $Artifact
  Invoke-WebRequest -Uri "$BaseUrl/$Artifact" -OutFile $ArtifactPath -UseBasicParsing

  if (-not $ExpectedSha) {
    $SumsPath = Join-Path $Tmp 'SHA256SUMS'
    try {
      Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS" -OutFile $SumsPath -UseBasicParsing
      $ExpectedSha = (Get-Content $SumsPath | Where-Object { $_ -match "\s\*?$([regex]::Escape($Artifact))$" } |
        Select-Object -First 1) -split '\s+' | Select-Object -First 1
    } catch { $ExpectedSha = $null }
  }
  if (-not $ExpectedSha) {
    throw "Could not obtain a SHA-256 for $Artifact. Refusing to install an unverified binary; set CASPER_SHA256 if you verified it out of band."
  }
  $ActualSha = (Get-FileHash -Algorithm SHA256 -Path $ArtifactPath).Hash.ToLower()
  if ($ActualSha -ne $ExpectedSha.ToLower()) {
    throw "Checksum mismatch for ${Artifact}: expected $ExpectedSha, actual $ActualSha"
  }

  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $Target = Join-Path $InstallDir 'casper.exe'
  # An existing link is inspected before anything replaces it. A link that stays inside the
  # install directory is replaced like a file; one into a .scratch checkout or any other
  # directory is a development link whose actual target must stay diagnosable.
  $Existing = Get-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
  if ($Existing -and ($Existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    $LinkTarget = if ($Existing.LinkTarget) { $Existing.LinkTarget } else { $Existing.Target | Select-Object -First 1 }
    if (-not [IO.Path]::IsPathRooted($LinkTarget)) { $LinkTarget = Join-Path $InstallDir $LinkTarget }
    $Resolved = [IO.Path]::GetFullPath($LinkTarget)
    $InstallDirFull = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\') + '\'
    if (-not $Resolved.StartsWith($InstallDirFull, [StringComparison]::OrdinalIgnoreCase)) {
      if ($Resolved -match '[\\/]\.scratch[\\/]') {
        throw "$Target is a link to $Resolved, which is inside a .scratch checkout. Refusing to replace it: remove or repoint that link, then re-run."
      }
      throw "$Target is a link to $Resolved, outside $InstallDir. That looks like a development link; remove it, then re-run."
    }
  }
  # Proved before it replaces anything, like install.sh: a version pin that does not
  # match must not leave a different binary behind, and a binary that cannot run here is
  # never installed. Move-Item then replaces the target in one step.
  $Staged = Join-Path $InstallDir '.casper-download.exe'
  try {
    Copy-Item -Force -Path $ArtifactPath -Destination $Staged
  } catch {
    throw "Could not write $Staged in $InstallDir`: $($_.Exception.Message)"
  }
  $Reported = (& $Staged --version)
  if ($LASTEXITCODE -ne 0) { throw "The downloaded $Artifact failed its version probe; nothing was installed." }
  if (-not $Reported) { throw "The downloaded $Artifact did not run on this host; nothing was installed." }
  # `casper --version` prints `casper <version> (<running path>)`; the path names the staged
  # probe, so only the version is compared and reported.
  if ("$Reported" -notmatch '^casper (\S+)') { throw "The downloaded $Artifact did not identify itself as casper: $Reported. Nothing was installed." }
  $ReportedVersion = $Matches[1]
  if ($Version -and $ReportedVersion -ne $Version) { throw "Expected version $Version but the artifact reports: $Reported. Nothing was installed." }
  try {
    Move-Item -Force -Path $Staged -Destination $Target
  } catch {
    throw "Could not replace $Target (is casper.exe still running?): $($_.Exception.Message)"
  }

  $UserPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
  if (($UserPath -split ';') -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable('Path', (($UserPath.TrimEnd(';') + ';' + $InstallDir).TrimStart(';')), 'User')
    Write-Host "Added $InstallDir to your user PATH; open a new terminal to use it."
  }
  # When invoked directly with irm | iex, make casper usable in this terminal too.
  if (($env:Path -split ';') -notcontains $InstallDir) {
    $env:Path = ($env:Path.TrimEnd(';') + ';' + $InstallDir).TrimStart(';')
  }
  Write-Host "Installed casper $ReportedVersion to $Target"
} finally {
  $ProgressPreference = $PreviousProgressPreference
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp
  if ($Staged) { Remove-Item -Force -ErrorAction SilentlyContinue $Staged }
}

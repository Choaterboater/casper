# Casper installer for Windows.
#
#   [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://github.com/Choaterboater/casper/releases/download/v0.2.25/install.ps1 | iex
#
# Downloads the self-contained casper-windows-x64.exe (casper-windows-arm64.exe on an ARM64
# PC), verifies its SHA-256 against the release's SHA256SUMS (and SHA256SUMS against the release signature, when
# ssh-keygen can check it), installs it under %LOCALAPPDATA%\Programs\casper and adds that
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
#   CASPER_ARCH         x64 or arm64 instead of this PC's own (casper update sets it with CASPER_SHA256).
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
$BaseUrl = if ($env:CASPER_BASE_URL) { $env:CASPER_BASE_URL } else { 'https://github.com/Choaterboater/casper/releases/download/v0.2.25' }
$InstallDir = if ($env:CASPER_INSTALL_DIR) { $env:CASPER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\casper' }
$Version = $env:CASPER_VERSION
$ExpectedSha = $env:CASPER_SHA256
# The public half of the Casper release key. SHA256SUMS.sig is an SSH signature over SHA256SUMS made with the private
# half, which only the release workflow holds. Empty until the key exists; then no signature is checked.
# scripts/release-key.ts sets it.
$ReleaseKey = ''

# SHA256SUMS must carry the release key's signature, as in install.sh. A bad one is always refused. A missing one is
# refused from the release's own address; from another CASPER_BASE_URL (a local build, a mirror) it is said and the
# SHA-256 still checked. Without an ssh-keygen that can check it (OpenSSH 8.1 or newer), that is said too.
function Test-CasperSignature([string]$SumsPath) {
  if (-not $ReleaseKey) { return }
  $SigPath = "$SumsPath.sig"
  try {
    Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS.sig" -OutFile $SigPath -UseBasicParsing
  } catch {
    if (-not $env:CASPER_BASE_URL) {
      throw 'This release has no signature (SHA256SUMS.sig), so it may not be a Casper release. Nothing installed. Set CASPER_SHA256 if you verified the file out of band.'
    }
    Write-Host "No signature (SHA256SUMS.sig) at $BaseUrl; checking SHA-256 only."
    return
  }
  $Keygen = Get-Command ssh-keygen -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  # A 32-bit PowerShell on 64-bit Windows is shown SysWOW64 for System32, where Windows' own OpenSSH is not; Sysnative
  # is the real System32 there.
  $KeygenPath = if ($Keygen) { $Keygen.Source } else { Join-Path $env:windir 'Sysnative\OpenSSH\ssh-keygen.exe' }
  if (-not (Test-Path -LiteralPath $KeygenPath)) { Write-Host 'Install OpenSSH (ssh-keygen) to also check the release signature.'; return }
  # Too old is asked of ssh-keygen alone, with nothing from the download: the real check prints text from the
  # signature file, so its words never decide this.
  $ProbeOut = Join-Path $Tmp 'probe-out.txt'
  $ProbeErr = Join-Path $Tmp 'probe-err.txt'
  $NoInput = Join-Path $Tmp 'probe-in.txt'
  [IO.File]::WriteAllText($NoInput, '')
  $null = Start-Process -FilePath $KeygenPath -ArgumentList @('-Y', 'verify') -RedirectStandardInput $NoInput `
    -RedirectStandardOutput $ProbeOut -RedirectStandardError $ProbeErr -NoNewWindow -Wait -PassThru
  $Probe = "$(Get-Content -Raw -ErrorAction SilentlyContinue $ProbeOut) $(Get-Content -Raw -ErrorAction SilentlyContinue $ProbeErr)"
  if ($Probe -match 'option -- Y|illegal option|unknown option') {
    Write-Host 'This ssh-keygen is too old to check the release signature (OpenSSH 8.1 or newer can).'
    return
  }
  $Allowed = Join-Path $Tmp 'allowed_signers'
  [IO.File]::WriteAllText($Allowed, "casper-release $ReleaseKey`n")
  $OutPath = Join-Path $Tmp 'verify-out.txt'
  $ErrPath = Join-Path $Tmp 'verify-err.txt'
  # SHA256SUMS goes in as a file, byte for byte: a PowerShell pipe would change its text before ssh-keygen saw it.
  $Arguments = @('-Y', 'verify', '-f', ('"{0}"' -f $Allowed), '-I', 'casper-release', '-n', 'casper-release', '-s', ('"{0}"' -f $SigPath))
  $Check = Start-Process -FilePath $KeygenPath -ArgumentList $Arguments -RedirectStandardInput $SumsPath `
    -RedirectStandardOutput $OutPath -RedirectStandardError $ErrPath -NoNewWindow -Wait -PassThru
  if ($Check.ExitCode -eq 0) { Write-Host 'Verified: signed with the Casper release key.'; return }
  throw "The release signature doesn't match the Casper release key. Nothing installed."
}

# The release file for this PC. $Machine is the PC's own value from the registry. The process
# values can differ from it: a 32-bit shell sees x86 (the real one is in PROCESSOR_ARCHITEW6432),
# and an x64 PowerShell on an ARM64 PC runs under emulation and sees AMD64 with no W6432 at all.
function Select-CasperArtifact([string]$Process, [string]$Wow64, [string]$Machine) {
  $Arch = if ($Machine) { $Machine } elseif ($Wow64) { $Wow64 } else { $Process }
  switch ($Arch) {
    'AMD64' { 'casper-windows-x64.exe' }
    'ARM64' { 'casper-windows-arm64.exe' }
    default { throw "Unsupported architecture: $Arch. Casper has Windows files for x64 and ARM64 only." }
  }
}
$MachineArch = try { [string](Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE -ErrorAction Stop).PROCESSOR_ARCHITECTURE } catch { '' }
$Artifact = Select-CasperArtifact $env:PROCESSOR_ARCHITECTURE $env:PROCESSOR_ARCHITEW6432 $MachineArch
# casper update names the file it runs as, whose SHA-256 it already checked against the signed list.
if ($env:CASPER_ARCH) {
  $Artifact = switch ($env:CASPER_ARCH) {
    'x64' { 'casper-windows-x64.exe' }
    'arm64' { 'casper-windows-arm64.exe' }
    default { throw "Unsupported architecture: $($env:CASPER_ARCH). Casper has Windows files for x64 and ARM64 only." }
  }
}

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
    $HaveSums = $true
    try { Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS" -OutFile $SumsPath -UseBasicParsing } catch { $HaveSums = $false }
    if ($HaveSums) {
      # Outside the try above: a refused signature must stop the install, not read as a missing list.
      Test-CasperSignature $SumsPath
      $ExpectedSha = (Get-Content $SumsPath | Where-Object { $_ -match "\s\*?$([regex]::Escape($Artifact))$" } |
        Select-Object -First 1) -split '\s+' | Select-Object -First 1
    }
  }
  if (-not $ExpectedSha) {
    throw "Could not obtain a SHA-256 for $Artifact. Refusing to install an unverified binary; set CASPER_SHA256 if you verified it out of band."
  }
  $ActualSha = (Get-FileHash -Algorithm SHA256 -Path $ArtifactPath).Hash.ToLower()
  if ($ActualSha -ne $ExpectedSha.ToLower()) {
    throw "Checksum mismatch for ${Artifact}: expected $ExpectedSha, actual $ActualSha"
  }
  # Where it was built: the release's GitHub build provenance, checked with gh when it is installed and signed in.
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    # Windows PowerShell 5 turns a native command's error text into a stop under 'Stop'; the exit code decides here.
    $SavedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & gh auth status *> $null
      $SignedIn = $LASTEXITCODE -eq 0
      $Attested = $false
      if ($SignedIn) {
        & gh attestation verify $ArtifactPath --repo Choaterboater/casper *> $null
        $Attested = $LASTEXITCODE -eq 0
      }
    } finally { $ErrorActionPreference = $SavedPreference }
    if ($SignedIn) {
      if (-not $Attested) { throw "This download doesn't match a Casper build from GitHub. Nothing installed." }
      Write-Host "Verified: built by GitHub Actions from Choaterboater/casper."
    } else {
      Write-Host "Checked SHA-256. Sign in to gh (gh auth login) to also check where it was built."
    }
  } else {
    Write-Host "Checked SHA-256. Install gh to also check where it was built."
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
  # Antivirus or a casper.exe that just closed can hold the file for a moment, so the
  # replace is tried again for about 5 seconds before giving up.
  $ReplaceClock = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    try {
      Move-Item -Force -Path $Staged -Destination $Target
      break
    } catch {
      if ($ReplaceClock.Elapsed.TotalSeconds -ge 5) {
        throw "Could not replace $Target (is casper.exe still running?): $($_.Exception.Message)"
      }
      Start-Sleep -Milliseconds 250
    }
  }

  # The user PATH is changed in the registry as Windows keeps it: entries like %USERPROFILE%\... stay as they are and
  # the value keeps its type. [Environment]::SetEnvironmentVariable would write every entry out in full, as plain text.
  $EnvKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try {
    $UserPath = [string]$EnvKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $Entries = $UserPath -split ';' | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_) }
    if ($Entries -notcontains $InstallDir) {
      $Kind = if ($EnvKey.GetValueNames() -contains 'Path') { $EnvKey.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
      $EnvKey.SetValue('Path', (($UserPath.TrimEnd(';') + ';' + $InstallDir).TrimStart(';')), $Kind)
      # Removing a name that was never set still tells Windows the environment changed, so new terminals get the PATH.
      [Environment]::SetEnvironmentVariable('CASPER_INSTALL_REFRESH', $null, 'User')
      Write-Host "Added $InstallDir to your user PATH; open a new terminal to use it."
    }
  } finally { $EnvKey.Close() }
  # When invoked directly with irm | iex, make casper usable in this terminal too.
  if (($env:Path -split ';') -notcontains $InstallDir) {
    $env:Path = ($env:Path.TrimEnd(';') + ';' + $InstallDir).TrimStart(';')
  }
  Write-Host "Installed casper $ReportedVersion to $Target"
} finally {
  $ProgressPreference = $PreviousProgressPreference
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Tmp
  if ($Staged) {
    # The version probe just ran from this file, and Windows or antivirus can hold it for a moment after
    # that, so removing it is tried again for about 5 seconds.
    $CleanupClock = [Diagnostics.Stopwatch]::StartNew()
    while (Test-Path -LiteralPath $Staged) {
      Remove-Item -LiteralPath $Staged -Force -ErrorAction SilentlyContinue
      if (-not (Test-Path -LiteralPath $Staged) -or $CleanupClock.Elapsed.TotalSeconds -ge 5) { break }
      Start-Sleep -Milliseconds 250
    }
  }
}

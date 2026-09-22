#!/bin/sh
# Casper installer for macOS and Linux.
#
#   curl -fsSL https://github.com/Choaterboater/casper/releases/download/v0.2.0/install.sh | sh
#
# Downloads the self-contained binary for this platform, verifies its SHA-256 against
# the release's SHA256SUMS, installs it into CASPER_INSTALL_DIR (default ~/.local/bin)
# and runs `casper --version`. Re-running the same command updates in place.
#
# Environment:
#   CASPER_BASE_URL     Directory holding the artifacts (default: the release host below).
#                       http(s) URL, file:// URL or a local path all work.
#   CASPER_INSTALL_DIR  Install directory (default: $HOME/.local/bin).
#   CASPER_VERSION      Required installed version; the installer fails if the binary
#                       reports anything else. Pin the artifact directory via
#                       CASPER_BASE_URL for an older release.
#   CASPER_SHA256       Expected digest, when SHA256SUMS is unavailable out of band.
#   CASPER_OS/ARCH      Override detection (cross-target checks; unusual shells).
#
# The compiled binary embeds Bun and every dependency: the target machine needs
# neither this checkout nor Bun. Nothing is installed with sudo.
set -eu

# Preview releases need an explicit tag: GitHub's latest/download excludes prereleases.
BASE_URL="${CASPER_BASE_URL:-https://github.com/Choaterboater/casper/releases/download/v0.2.0}"
INSTALL_DIR="${CASPER_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${CASPER_VERSION:-}"
EXPECTED_SHA="${CASPER_SHA256:-}"
FORCE=0
PRINT_TARGET=0

usage() {
  cat <<'USAGE'
Usage: install.sh [options]

  --dir <path>     Install directory (default: $HOME/.local/bin)
  --version <v>    Require this exact installed version
  --sha256 <hex>   Expected SHA-256, when SHA256SUMS cannot be fetched
  --force          Replace an existing symlink that leaves this directory (for example a
                   development link); a link into a .scratch checkout is never replaced
  --print-target   Print the resolved artifact name and exit
  -h, --help       Show this text
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --sha256) EXPECTED_SHA="${2:?--sha256 needs a digest}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --print-target) PRINT_TARGET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

uname_s="${CASPER_OS:-$(uname -s)}"
uname_m="${CASPER_ARCH:-$(uname -m)}"
case "$uname_s" in
  Darwin|darwin) os=darwin ;;
  Linux|linux) os=linux ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT|windows) echo "Windows uses the PowerShell installer instead: powershell -ExecutionPolicy ByPass -c \"irm ${BASE_URL}/install.ps1 | iex\"" >&2; exit 2 ;;
  *) echo "Unsupported operating system: $uname_s. Download an artifact manually from ${BASE_URL}." >&2; exit 2 ;;
esac
case "$uname_m" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo "Unsupported architecture: $uname_m. Download an artifact manually from ${BASE_URL}." >&2; exit 2 ;;
esac
artifact="casper-${os}-${arch}"

if [ "$PRINT_TARGET" = 1 ]; then
  printf '%s\n' "$artifact"
  exit 0
fi

# An existing `casper` symlink is inspected before anything is downloaded. A link that
# stays inside the install directory (a versioned binary alias) is replaced like a file.
# A link into a `.scratch` checkout is a stale development link: it is reported and never
# replaced, so the actual target is diagnosable before it disappears. Any other link that
# leaves the install directory points at a checkout; replacing it silently would be
# surprising, so that needs --force.
target="$INSTALL_DIR/casper"
if [ -L "$target" ]; then
  link="$(readlink "$target")"
  # Relative links resolve against the install directory; `pwd -P` canonicalizes the
  # parent so a dangling link still names the path it points at.
  resolved_dir="$(cd "$INSTALL_DIR" 2>/dev/null && cd "$(dirname "$link")" 2>/dev/null && pwd -P)" || resolved_dir="$(dirname "$link")"
  resolved="$resolved_dir/$(basename "$link")"
  install_dir_canonical="$(cd "$INSTALL_DIR" 2>/dev/null && pwd -P)" || install_dir_canonical="$INSTALL_DIR"
  case "$resolved" in
    "$install_dir_canonical"/*) ;;
    */.scratch/*)
      echo "$target is a symlink to $resolved, which is inside a .scratch checkout." >&2
      echo "Refusing to replace it (even with --force): remove or repoint that link, then re-run." >&2
      exit 1
      ;;
    *)
      if [ "$FORCE" != 1 ]; then
        echo "$target is a symlink to $resolved." >&2
        echo "That looks like a development link; remove it or re-run with --force to replace it." >&2
        exit 1
      fi
      ;;
  esac
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/casper-install.XXXXXX")"
# An interrupted update must not leave the staged download behind.
staged=
cleanup() { rm -rf "$tmp"; if [ -n "$staged" ]; then rm -f "$staged"; fi; }
trap cleanup EXIT HUP INT TERM

fetch() { # fetch <source-url-or-path> <destination>
  src="$1"; dest="$2"
  case "$src" in
    http://*|https://*)
      if command -v curl >/dev/null 2>&1; then curl -fsSL "$src" -o "$dest"
      elif command -v wget >/dev/null 2>&1; then wget -qO "$dest" "$src"
      else echo "curl or wget is required to download Casper" >&2; exit 2
      fi ;;
    file://*) cp "${src#file://}" "$dest" ;;
    *) cp "$src" "$dest" ;;
  esac
}

digest() { # digest <file>
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else echo "No SHA-256 tool available (sha256sum, shasum or openssl)" >&2; exit 2
  fi
}

echo "Downloading ${artifact} from ${BASE_URL}"
fetch "${BASE_URL}/${artifact}" "$tmp/$artifact"

# Verification is not optional: an unverified binary is never installed.
if [ -z "$EXPECTED_SHA" ]; then
  if fetch "${BASE_URL}/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
    EXPECTED_SHA="$(awk -v name="$artifact" '$2 == name || $2 == "*" name { print $1 }' "$tmp/SHA256SUMS" | head -n 1)"
  fi
fi
if [ -z "$EXPECTED_SHA" ]; then
  echo "Could not obtain a SHA-256 for ${artifact}." >&2
  echo "Refusing to install an unverified binary; pass --sha256 <hex> if you verified it out of band." >&2
  exit 1
fi
actual_sha="$(digest "$tmp/$artifact")"
if [ "$actual_sha" != "$EXPECTED_SHA" ]; then
  echo "Checksum mismatch for ${artifact}:" >&2
  echo "  expected $EXPECTED_SHA" >&2
  echo "  actual   $actual_sha" >&2
  exit 1
fi

# The artifact is proved inside the install directory before it replaces anything: a
# version pin that does not match must not leave a different binary behind, and a
# binary that cannot run here is never installed. The final `mv` replaces the target in
# one step, so an interrupted update cannot leave a half-written `casper`.
if ! mkdir -p "$INSTALL_DIR" 2>/dev/null || [ ! -w "$INSTALL_DIR" ]; then
  echo "Cannot write to ${INSTALL_DIR}; choose another directory with --dir or CASPER_INSTALL_DIR." >&2
  exit 1
fi
staged="$INSTALL_DIR/.casper-download.$$"
install -m 755 "$tmp/$artifact" "$staged"
# A downloaded macOS binary carries the quarantine flag; clear it so the first run is
# not blocked. Best effort: a host without xattr still installs.
if [ "$os" = darwin ] && command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$staged" 2>/dev/null || true
fi

if ! reported="$("$staged" --version 2>/dev/null)"; then
  echo "The downloaded ${artifact} failed its version probe; nothing was installed." >&2
  exit 1
fi
if [ -z "$reported" ]; then
  echo "The downloaded ${artifact} did not run on this host; nothing was installed." >&2
  echo "Check that the artifact matches this platform (${os}-${arch})." >&2
  exit 1
fi
# `casper --version` prints `casper <version> (<running path>)`; the path names the staged
# probe, so only the version is compared and reported.
case "$reported" in
  "casper "*) ;;
  *)
    echo "The downloaded ${artifact} did not identify itself as casper: $reported" >&2
    echo "Nothing was installed." >&2
    exit 1
    ;;
esac
reported_version="${reported#casper }"
reported_version="${reported_version%% *}"
if [ -n "$VERSION" ] && [ "$reported_version" != "$VERSION" ]; then
  echo "Expected version $VERSION but the artifact reports: $reported" >&2
  echo "Nothing was installed; point CASPER_BASE_URL at the release you want." >&2
  exit 1
fi

mv -f "$staged" "$target"
staged=

echo "Installed casper $reported_version to $target"
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo "Add it to your PATH, then run casper:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

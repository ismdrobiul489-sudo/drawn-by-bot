# Fallback: (re)fetch the unmodified upstream tree into core/ at the pinned
# commit recorded in UPSTREAM.md. Use this if core/ is missing (e.g. a fresh
# clone of this repo that excluded it). Downloads the GitHub tarball of the
# exact commit — file contents are identical to a git clone of that commit.
set -euo pipefail
COMMIT=3c9c949421e4aa86dba444dfe8cba46d000f9d87
cd "$(dirname "$0")/.."
if [ -f core/README.md ]; then echo "core/ already present — nothing to do."; exit 0; fi
tmp=$(mktemp -d)
curl -sL -o "$tmp/core.tar.gz" "https://codeload.github.com/illodev/drawn-by-code/tar.gz/$COMMIT"
mkdir -p "$tmp/x"
tar xzf "$tmp/core.tar.gz" -C "$tmp/x"
rm -rf core
mv "$tmp/x"/drawn-by-code-* core
rm -rf "$tmp"
echo "core/ restored at $COMMIT — $(find core -type f | wc -l) files."

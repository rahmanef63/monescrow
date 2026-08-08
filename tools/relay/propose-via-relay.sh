#!/usr/bin/env bash
# Run monskills' propose.mjs UNMODIFIED, with the file-spool relay underneath it.
#
# This is propose.sh's bootstrap (copy into ~/.monskills/propose-deps, npm install once)
# with exactly one thing changed: the final `node` invocation gains `--import`, which
# loads fetch-relay.mjs before the entry module. propose.mjs itself is never patched,
# never copied with edits, never read for find-and-replace. That is the point — the
# wallet skill forbids hand-rolling the Safe proposal, and swapping the transport is the
# only way to satisfy both that rule and a sandbox with no route to api.safe.global.
#
# Usage — same env vars propose.sh takes:
#
#   CHAIN_ID=10143 \
#   SAFE_ADDRESS=0x... \
#   PRIVATE_KEY=0x... \
#   DEPLOYMENT_BYTECODE=0x... \
#     bash tools/relay/propose-via-relay.sh
#
# Then work the spool — see tools/relay/README.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILL_UTILS="${MONSKILLS_WALLET_UTILS:-$REPO_ROOT/.agents/skills/wallet/utils}"
DEPS_DIR="${HOME}/.monskills/propose-deps"

if [ ! -f "$SKILL_UTILS/propose.mjs" ]; then
  echo "❌ Cannot find propose.mjs at $SKILL_UTILS" >&2
  echo "   The MONSKILLS installer silently drops the wallet skill (YAML parse error)." >&2
  echo "   Restore it with:" >&2
  echo "     git clone --depth 1 -b watermarking https://github.com/therealharpaljadeja/monskills.git /tmp/ms" >&2
  echo "     cp -r /tmp/ms/wallet .agents/skills/wallet" >&2
  exit 1
fi

mkdir -p "$DEPS_DIR"
cp "$SKILL_UTILS/propose.mjs" "$DEPS_DIR/propose.mjs"
cp "$SKILL_UTILS/package.json" "$DEPS_DIR/package.json"

# Prove we did not touch it. If this hash ever drifts from the skill's own copy, the
# run should be treated as untrusted.
echo "propose.mjs sha256: $(sha256sum "$DEPS_DIR/propose.mjs" | cut -d' ' -f1)"
echo "  (skill  original): $(sha256sum "$SKILL_UTILS/propose.mjs" | cut -d' ' -f1)"

if [ ! -d "$DEPS_DIR/node_modules" ]; then
  echo "📦 Installing propose.mjs dependencies (one-time, cached in $DEPS_DIR)..."
  (cd "$DEPS_DIR" && npm install --silent --no-audit --no-fund --loglevel=error)
fi

export RELAY_SPOOL="${RELAY_SPOOL:-$SCRIPT_DIR/spool}"
mkdir -p "$RELAY_SPOOL"

exec node --import "$SCRIPT_DIR/fetch-relay.mjs" "$DEPS_DIR/propose.mjs" "$@"

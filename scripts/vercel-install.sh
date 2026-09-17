#!/usr/bin/env bash
# Vercel installCommand entrypoint (invoked with cwd = the project's Root Directory,
# apps/chrono-web). Vercel's GitHub App clones this repo but cannot fetch the private
# packages/agora submodule even when the App has access to that repo, so `git submodule
# update` gets a 403. We fetch it ourselves with a scoped PAT, then run the normal
# workspace install from the repo root.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [ -n "${AGORA_SUBMODULE_TOKEN:-}" ]; then
  git config --global url."https://x-access-token:${AGORA_SUBMODULE_TOKEN}@github.com/risurina/agora.git".insteadOf "https://github.com/risurina/agora.git"
fi

# Vercel's own implicit pre-install clone step already tried (and, for a private
# submodule, failed with 403) to fetch packages/agora using its GitHub App token —
# that failed attempt still leaves a non-empty directory behind, which then makes
# our own `git submodule update` below fail with "already exists and is not an
# empty directory". Clear it first so the clone below starts from a clean slate.
git submodule deinit -f -- packages/agora 2>/dev/null || true
rm -rf packages/agora

git submodule update --init --recursive

pnpm install --frozen-lockfile

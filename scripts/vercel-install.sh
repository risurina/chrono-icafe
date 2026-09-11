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

git submodule update --init --recursive

pnpm install --frozen-lockfile

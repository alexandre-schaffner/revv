#!/usr/bin/env sh

set -eu

# CI compiles the installed package; this checkout is only agent reference material.
if [ "${CI:-}" = "true" ]; then
  exit 0
fi

repo_dir=".repos/effect"
repo_url="https://github.com/Effect-TS/effect"

if [ -d "$repo_dir/.git" ]; then
  exit 0
fi

mkdir -p ".repos"
git clone "$repo_url" "$repo_dir"

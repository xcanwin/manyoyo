#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${repo_root}" ]]; then
    echo "Not a git repository." >&2
    exit 1
fi

cd "${repo_root}"

echo "## HEAD"
git log -1 --pretty=format:'%H%n%s%n%b' || true
echo
echo

echo "## CHANGED_FILES"
if ! git diff --name-only HEAD; then
    true
fi
echo

echo "## DIFF_STAT"
if ! git diff --stat HEAD; then
    true
fi
echo

echo "## DIFF_SNIPPET_FIRST_240_LINES"
if ! git diff --no-color --unified=1 HEAD | sed -n '1,240p'; then
    true
fi

#!/usr/bin/env bash
# Phase-0 worktree cull survey (READ-ONLY — removes nothing).
# Classifies every worktree so the human can approve a removal list.
# Honors the HARD invariant: root must be `main`, and no worktree may hold `main`.
#
# Usage:  bash scripts/recovery/worktree-survey.sh
# Output: three lists (KEEP / REMOVABLE / NEEDS-EYES) + a ready-to-paste removal block.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# --- Invariant gate: root must be main -------------------------------------
root_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$root_branch" != "main" ]; then
  echo "ABORT: repo root is on '$root_branch', not 'main'. Restore root==main before culling." >&2
  exit 1
fi

removable=()   # merged into main, clean tree  -> safe to remove (branch survives)
needs_eyes=()  # dirty OR has commits not on main -> triage by hand
holds_main=()  # a worktree checked out on main -> INVARIANT VIOLATION

# Parse `git worktree list --porcelain` into (path, branch) pairs.
path=""; branch=""; detached=0
flush() {
  [ -z "$path" ] && return
  # Skip the root worktree itself.
  if [ "$path" = "$ROOT" ]; then path=""; branch=""; detached=0; return; fi

  if [ "$branch" = "main" ]; then
    holds_main+=("$path")
    path=""; branch=""; detached=0; return
  fi

  local dirty=0 ahead=0
  # Uncommitted changes in the worktree?
  if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then dirty=1; fi
  # Commits on this branch not reachable from main? (detached HEADs always get eyes)
  if [ "$detached" = "1" ] || [ -z "$branch" ]; then
    ahead=1
  else
    ahead="$(git rev-list --count "main..$branch" 2>/dev/null || echo 1)"
  fi

  if [ "$dirty" = "0" ] && [ "$ahead" = "0" ]; then
    removable+=("$path|${branch:-DETACHED}")
  else
    needs_eyes+=("$path|${branch:-DETACHED}|dirty=$dirty|ahead=$ahead")
  fi
  path=""; branch=""; detached=0
}

while IFS= read -r line; do
  case "$line" in
    "worktree "*) flush; path="${line#worktree }" ;;
    "branch "*)   branch="${line#branch refs/heads/}" ;;
    "detached")   detached=1 ;;
    "")           : ;;  # record separator; flush happens on next `worktree `
  esac
done < <(git worktree list --porcelain)
flush

echo "### REMOVABLE (merged into main + clean) — ${#removable[@]}"
printf '  %s\n' "${removable[@]:-<none>}"
echo
echo "### NEEDS-EYES (dirty or unmerged commits) — ${#needs_eyes[@]}"
printf '  %s\n' "${needs_eyes[@]:-<none>}"
echo
echo "### HOLDS-MAIN (INVARIANT VIOLATION — fix before anything) — ${#holds_main[@]}"
printf '  %s\n' "${holds_main[@]:-<none>}"
echo
echo "### Ready-to-run removal (REMOVABLE only; review first, then paste):"
for entry in "${removable[@]:-}"; do
  [ -z "$entry" ] && continue
  wt="${entry%%|*}"
  echo "git worktree remove \"$wt\""
done
echo "git worktree prune"

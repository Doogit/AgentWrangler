#!/usr/bin/env bash
# Phase-0 triage for the NEEDS-EYES worktrees (READ-ONLY).
# For each registered worktree (except root), scores how safe it is to cut:
#   uniq  = commits whose patch is NOT already in main (git cherry) -> 0 means patch-merged, safe
#   dirty = uncommitted changes present
#   ahead = commits on branch not reachable from main (FF distance)
# Emits a markdown table sorted safest-to-cut first.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

rows=""
path=""; branch=""; detached=0
score() {
  [ -z "$path" ] && return
  if [ "$path" = "$ROOT" ]; then path=""; branch=""; detached=0; return; fi
  local name="${path##*/.worktrees/}"
  local dirty=0 ahead=0 uniq="-" subj date tier
  [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ] && dirty=1
  if [ "$detached" = "1" ] || [ -z "$branch" ]; then
    branch="DETACHED"; ahead="-"; uniq="-"
  else
    ahead="$(git rev-list --count "main..$branch" 2>/dev/null || echo '?')"
    uniq="$(git cherry main "$branch" 2>/dev/null | awk '/^\+/{n++} END{print n+0}')"
  fi
  subj="$(git -C "$path" log -1 --pretty=%s 2>/dev/null | cut -c1-48)"
  date="$(git -C "$path" log -1 --pretty=%cr 2>/dev/null)"
  # Tier: 0 = safest cut (clean + patch-merged), 1 = clean + little unique, 2 = dirty/unmerged
  if [ "$dirty" = "0" ] && [ "$uniq" = "0" ]; then tier=0
  elif [ "$dirty" = "0" ] && [ "$uniq" != "?" ] && [ "$uniq" -le 2 ] 2>/dev/null; then tier=1
  else tier=2; fi
  rows="$rows$tier	$name	$branch	$dirty	$ahead	$uniq	$date	$subj"$'\n'
  path=""; branch=""; detached=0
}
while IFS= read -r line; do
  case "$line" in
    "worktree "*) score; path="${line#worktree }" ;;
    "branch "*)   branch="${line#branch refs/heads/}" ;;
    "detached")   detached=1 ;;
  esac
done < <(git worktree list --porcelain)
score

echo "| # | tier | worktree | branch | dirty | ahead | uniq | last | subject |"
echo "|---|---|---|---|---|---|---|---|---|"
printf '%s' "$rows" | sort -t$'\t' -k1,1n -k6,6n | awk -F'\t' 'NF>=8{printf "| %d | T%s | %s | %s | %s | %s | %s | %s | %s |\n", NR, $1, $2, $3, $4, $5, $6, $7, $8}'
echo
echo "Legend: T0 = clean + all commits already in main by patch (safest cut). T1 = clean, <=2 unique commits. T2 = dirty OR >2 unique commits (inspect before cut)."
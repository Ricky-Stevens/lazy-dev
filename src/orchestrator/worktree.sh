#!/usr/bin/env bash
# Requires bash 4+ (for associative arrays in merge). macOS ships bash 3.2
# by default — install bash 4+ via Homebrew: brew install bash.
# worktree.sh — create / merge / cleanup worktrees for lazy-dev runs.
#
# Usage:
#   worktree.sh create  <run-id> <task-id> [base-ref]
#   worktree.sh commit  <run-id> <task-id> [message]
#   worktree.sh merge   <run-id> <task-id>
#   worktree.sh remove  <run-id> <task-id>
#   worktree.sh list    <run-id>
#
# Exits non-zero on any failure. Prints the worktree path on `create`.
# Prints a list of conflicted files (newline-separated) on `merge` if the
# merge conflicts; the caller (wrangler orchestrator) dispatches merger.
# `commit` exits 0 with "committed" or "clean" on stdout; exits non-zero if
# the worktree doesn't exist or git fails.

set -euo pipefail

CMD="${1:-}"
shift || true

project_dir() {
  echo "${CLAUDE_PROJECT_DIR:-$PWD}"
}

sanitize() {
  # Keep [A-Za-z0-9-_]; replace everything else with _.
  printf '%s' "$1" | tr -c 'A-Za-z0-9_-' '_'
}

short_hash() {
  printf '%s' "$1" | sha1sum | cut -c1-6
}

is_git_repo() {
  local dir; dir="$(project_dir)"
  git -C "$dir" rev-parse --git-dir >/dev/null 2>&1
}

require_git_repo() {
  if ! is_git_repo; then
    echo "error: not a git repo: $(project_dir)" >&2
    exit 2
  fi
}

create() {
  local run_id="${1:?run-id required}"
  local task_id="${2:?task-id required}"
  local base_ref="${3:-HEAD}"

  local dir; dir="$(project_dir)"
  local sanitized="$(sanitize "$task_id")"
  local hash="$(short_hash "${run_id}:${task_id}")"
  local wt_rel=".lazy-dev/worktrees/${run_id}/${sanitized}-${hash}"
  local wt_abs="${dir}/${wt_rel}"
  local branch="lazy-dev/${run_id}/${sanitized}"

  mkdir -p "${dir}/.lazy-dev/worktrees/${run_id}"

  # If the workspace already exists for this (run, task), reuse it.
  if [ -d "$wt_abs" ]; then
    echo "$wt_abs"
    return 0
  fi

  if is_git_repo; then
    git -C "$dir" worktree add -b "$branch" "$wt_abs" "$base_ref" >&2
  else
    # Non-git fallback — rsync copy.
    mkdir -p "$wt_abs"
    rsync -a --delete \
      --exclude='.lazy-dev/' \
      --exclude='node_modules/' \
      --exclude='.git/' \
      "${dir}/" "${wt_abs}/" >&2
    echo "non-git" > "${wt_abs}/.lazy-dev-mode"
    ( cd "$wt_abs" && find . -type f \
        ! -path './.lazy-dev-mode' \
        ! -path './.lazy-dev-baseline.sha256' \
        -print0 | xargs -0 sha256sum ) > "${wt_abs}/.lazy-dev-baseline.sha256" 2>/dev/null || true
  fi

  # Bootstrap: copy env files + run install command.
  bootstrap "$dir" "$wt_abs"

  echo "$wt_abs"
}

bootstrap() {
  local src_dir="$1"
  local wt_dir="$2"

  # Copy env files (if they exist in the source project).
  for envfile in .env .env.local; do
    if [ -f "${src_dir}/${envfile}" ]; then
      cp "${src_dir}/${envfile}" "${wt_dir}/${envfile}" 2>/dev/null || true
    fi
  done

  # Share dependency directories from the parent project via symlinks.
  # These are gitignored, don't change between worktrees (all branch from
  # the same HEAD with the same lockfile), and are read-only during normal
  # specialist work. If a specialist installs a new dep, the symlink means
  # it lands in the shared dir — acceptable for a short-lived worktree.
  #
  # Language-specific: only symlink what exists in the parent. Unknown
  # ecosystems get no symlink and fall through to the install path.
  share_dep_dir "${src_dir}" "${wt_dir}" "node_modules"        # JS (npm/yarn/bun)
  share_dep_dir "${src_dir}" "${wt_dir}" ".venv"               # Python virtualenv
  share_dep_dir "${src_dir}" "${wt_dir}" "vendor"              # Go vendor / PHP composer
  share_dep_dir "${src_dir}" "${wt_dir}" "target"              # Rust cargo
  share_dep_dir "${src_dir}" "${wt_dir}" ".bundle"             # Ruby bundler

  # pnpm uses a global content-addressable store — symlinks don't work for
  # node_modules, but the store itself is shared. Just run install; pnpm's
  # hardlink strategy makes it near-instant when the store is warm.

  # Only run install if no dep directory exists (symlink or real).
  # This covers the case where the parent has no installed deps.
  if has_deps "${wt_dir}"; then
    return 0
  fi

  # Fallback: run the appropriate install command.
  if [ -f "${wt_dir}/bun.lockb" ] || [ -f "${wt_dir}/bun.lock" ]; then
    ( cd "$wt_dir" && bun install --frozen-lockfile 2>&1 ) >&2 || true
  elif [ -f "${wt_dir}/pnpm-lock.yaml" ]; then
    ( cd "$wt_dir" && pnpm install --frozen-lockfile 2>&1 ) >&2 || true
  elif [ -f "${wt_dir}/package-lock.json" ]; then
    ( cd "$wt_dir" && npm ci --prefer-offline 2>&1 ) >&2 || true
  elif [ -f "${wt_dir}/yarn.lock" ]; then
    ( cd "$wt_dir" && yarn install --frozen-lockfile 2>&1 ) >&2 || true
  elif [ -f "${wt_dir}/requirements.txt" ] || [ -f "${wt_dir}/pyproject.toml" ]; then
    if [ -d "${wt_dir}/.venv" ]; then
      return 0
    fi
  fi
}

share_dep_dir() {
  local src="$1" dst="$2" name="$3"
  if [ -d "${src}/${name}" ] && [ ! -e "${dst}/${name}" ]; then
    ln -s "${src}/${name}" "${dst}/${name}" 2>/dev/null || true
  fi
}

has_deps() {
  local dir="$1"
  [ -e "${dir}/node_modules" ] || \
  [ -e "${dir}/.venv" ] || \
  [ -e "${dir}/vendor" ] || \
  [ -e "${dir}/target" ] || \
  [ -e "${dir}/.bundle" ]
}

commit() {
  local run_id="${1:?run-id required}"
  local task_id="${2:?task-id required}"
  local message="${3:-"${task_id}: auto-commit at gate"}"

  local dir; dir="$(project_dir)"
  local sanitized="$(sanitize "$task_id")"
  local hash; hash="$(short_hash "${run_id}:${task_id}")"
  local wt_abs="${dir}/.lazy-dev/worktrees/${run_id}/${sanitized}-${hash}"

  if [ ! -d "$wt_abs" ]; then
    echo "error: worktree missing: $wt_abs" >&2
    exit 2
  fi

  if ! is_git_repo; then
    # Non-git mode: nothing to commit; merge picks up files by sha256 diff.
    echo "clean"
    return 0
  fi

  # If nothing is staged or unstaged, nothing to do.
  if git -C "$wt_abs" diff --quiet && git -C "$wt_abs" diff --cached --quiet \
    && [ -z "$(git -C "$wt_abs" ls-files --others --exclude-standard)" ]; then
    echo "clean"
    return 0
  fi

  git -C "$wt_abs" add -A >&2
  git -C "$wt_abs" commit -m "$message" >&2
  echo "committed"
}

merge() {
  if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
    echo "error: merge requires bash 4+ for associative arrays (got ${BASH_VERSION})" >&2
    exit 2
  fi
  local run_id="${1:?run-id required}"
  local task_id="${2:?task-id required}"

  local dir; dir="$(project_dir)"
  local sanitized="$(sanitize "$task_id")"
  local hash="$(short_hash "${run_id}:${task_id}")"
  local wt_abs="${dir}/.lazy-dev/worktrees/${run_id}/${sanitized}-${hash}"
  local branch="lazy-dev/${run_id}/${sanitized}"

  if is_git_repo; then
    if git -C "$dir" merge --no-ff --no-edit "$branch" >&2; then
      echo "merged: $branch" >&2
      return 0
    fi
    git -C "$dir" diff --name-only --diff-filter=U
    return 3
  else
    # Non-git: rsync the copy back. Detect conflicts by comparing checksums
    # against the previously-synced state: any file changed in BOTH the
    # main tree and the copy since the copy was made is a conflict.
    if [ ! -d "$wt_abs" ]; then
      echo "error: workspace missing: $wt_abs" >&2
      return 2
    fi
    # Three-way comparison against the sha256 baseline captured at creation.
    # A file is a conflict iff it changed in BOTH the main tree and the
    # workspace since creation. Otherwise copy-forward or no-op.
    local baseline="${wt_abs}/.lazy-dev-baseline.sha256"
    local conflicts=()
    declare -A base_hash
    if [ -f "$baseline" ]; then
      while read -r sum path; do
        base_hash["${path#./}"]="$sum"
      done < "$baseline"
    fi
    hash_of() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }
    while IFS= read -r -d '' f; do
      local rel="${f#${wt_abs}/}"
      [ "$rel" = ".lazy-dev-mode" ] && continue
      [ "$rel" = ".lazy-dev-baseline.sha256" ] && continue
      local main_file="${dir}/${rel}"
      local wt_sum; wt_sum="$(hash_of "$f")"
      local base="${base_hash[$rel]:-}"
      if [ -f "$main_file" ]; then
        local main_sum; main_sum="$(hash_of "$main_file")"
        if [ "$wt_sum" = "$main_sum" ]; then
          continue  # identical; no-op
        fi
        if [ -n "$base" ] && [ "$main_sum" = "$base" ]; then
          # main unchanged since creation; workspace diverged — apply cleanly.
          mkdir -p "$(dirname "$main_file")"
          cp "$f" "$main_file"
        elif [ -n "$base" ] && [ "$wt_sum" = "$base" ]; then
          continue  # workspace unchanged; main moved — leave main alone.
        else
          conflicts+=("$rel")
        fi
      else
        mkdir -p "$(dirname "$main_file")"
        cp "$f" "$main_file"
      fi
    done < <(find "$wt_abs" -type f -print0)

    if [ ${#conflicts[@]} -gt 0 ]; then
      printf '%s\n' "${conflicts[@]}"
      return 3
    fi
    echo "merged (non-git): $wt_abs -> $dir" >&2
    return 0
  fi
}

remove() {
  local run_id="${1:?run-id required}"
  local task_id="${2:?task-id required}"

  local dir; dir="$(project_dir)"
  local sanitized="$(sanitize "$task_id")"
  local hash="$(short_hash "${run_id}:${task_id}")"
  local wt_abs="${dir}/.lazy-dev/worktrees/${run_id}/${sanitized}-${hash}"
  local branch="lazy-dev/${run_id}/${sanitized}"

  if is_git_repo && [ ! -f "${wt_abs}/.lazy-dev-mode" ]; then
    git -C "$dir" worktree remove "$wt_abs" >&2 || {
      echo "error: worktree has uncommitted changes or does not exist: $wt_abs" >&2
      echo "       keep for forensics, or run 'git -C $dir worktree remove --force $wt_abs' to discard." >&2
      exit 4
    }
    echo "removed worktree: $wt_abs (branch $branch kept)" >&2
  else
    # Non-git copy
    rm -rf "$wt_abs"
    echo "removed copy: $wt_abs" >&2
  fi
}

list() {
  local run_id="${1:?run-id required}"
  local dir; dir="$(project_dir)"
  local base="${dir}/.lazy-dev/worktrees/${run_id}"

  if [ ! -d "$base" ]; then
    return 0
  fi
  find "$base" -mindepth 1 -maxdepth 1 -type d
}

case "$CMD" in
  create) create "$@" ;;
  commit) commit "$@" ;;
  merge)  merge  "$@" ;;
  remove) remove "$@" ;;
  list)   list   "$@" ;;
  ""|-h|--help)
    sed -n '1,/^$/p' "$0" | sed -n 's/^# \{0,1\}//p'
    exit 0
    ;;
  *)
    echo "unknown command: $CMD" >&2
    exit 64
    ;;
esac

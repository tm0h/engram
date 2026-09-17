#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' \
    "Usage: scripts/run-e2e-container.sh [--shell] [git-ref]" \
    "" \
    "Build an E2E image from a clean committed snapshot, then run it" \
    "without network access or host-directory mounts." \
    "" \
    "Options:" \
    "  --shell  Open a shell in the isolated image instead of running the audit." \
    "  --help   Show this help."
}

mode="audit"
candidate_ref="HEAD"
candidate_ref_set=false

while (($# > 0)); do
  case "$1" in
    --shell)
      mode="shell"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      printf 'error: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ "$candidate_ref_set" == true ]]; then
        printf 'error: only one git ref may be supplied\n' >&2
        exit 2
      fi
      candidate_ref="$1"
      candidate_ref_set=true
      ;;
  esac
  shift
done

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  printf '%s\n' \
    "error: the worktree is dirty" \
    "Commit or remove local changes before building release evidence." >&2
  exit 1
fi

candidate_sha=$(git rev-parse --verify "${candidate_ref}^{commit}")
image_name="engram-e2e:${candidate_sha:0:12}"
container_name="engram-e2e-${candidate_sha:0:12}-$$"

printf 'Building %s from %s\n' "$image_name" "$candidate_sha"
git archive --format=tar "$candidate_sha" |
  docker build \
    --build-arg "CANDIDATE_SHA=$candidate_sha" \
    --file Dockerfile.e2e \
    --tag "$image_name" \
    -

run_args=(
  --rm
  --name "$container_name"
  --network none
  --cap-drop ALL
  --security-opt no-new-privileges
  --pids-limit 512
  --tmpfs /home/node:rw,nosuid,nodev,mode=0700,uid=1000,gid=1000
  --tmpfs /tmp:rw,nosuid,nodev,exec,size=256m,mode=1777
  --tmpfs /var/tmp:rw,nosuid,nodev,exec,size=1g,mode=1777
)

if [[ -t 0 && -t 1 ]]; then
  run_args+=(--interactive --tty)
fi

if [[ "$mode" == "shell" ]]; then
  printf 'Opening isolated shell for %s\n' "$candidate_sha"
  docker run "${run_args[@]}" --entrypoint bash "$image_name"
else
  docker run "${run_args[@]}" "$image_name"
fi

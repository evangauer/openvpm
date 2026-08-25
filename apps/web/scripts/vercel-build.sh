#!/usr/bin/env bash
# Production Git deployments are candidates, not approvals. Fail closed unless
# an operator has pinned this exact commit, then wait for its target database to
# contain every table and column declared by the same revision.

set -euo pipefail

if [ "${VERCEL_ENV:-}" = "production" ]; then
  release_sha="${PRODUCTION_RELEASE_SHA:-}"
  commit_sha="${VERCEL_GIT_COMMIT_SHA:-}"

  if [[ ! "$release_sha" =~ ^[0-9a-f]{40}$ ]] || [ "$release_sha" != "$commit_sha" ]; then
    echo "::error::Production release approval is absent or does not match this exact commit; refusing production promotion."
    exit 1
  fi

  schema_attempt=1
  schema_attempt_limit=30

  until (cd ../.. && pnpm db:drift); do
    if [ "$schema_attempt" -ge "$schema_attempt_limit" ]; then
      echo "::error::Database schema did not become ready; refusing production promotion."
      exit 1
    fi

    echo "Database migration is still in progress; retrying schema readiness in 10 seconds."
    sleep 10
    schema_attempt=$((schema_attempt + 1))
  done
fi

pnpm build

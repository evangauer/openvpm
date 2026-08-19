#!/usr/bin/env bash
# Production releases are deliberately two-person/gated operations. A merge to
# main may create a candidate deployment, but it cannot build until an operator
# pins the exact Git commit in the Production environment. After that approval,
# do not promote application code until its target database has every table and
# column declared by the same revision.

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

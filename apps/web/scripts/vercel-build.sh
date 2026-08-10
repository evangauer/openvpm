#!/usr/bin/env bash
# Production deploys may begin at the same time as the main-branch migration
# workflow. Do not build (and therefore do not promote) application code until
# its target database has every table and column declared by that revision.

set -euo pipefail

if [ "${VERCEL_ENV:-}" = "production" ]; then
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

#!/usr/bin/env bash
# Vercel Ignored Build Step for the projects deployed from apps/web.
# Exit 0 skips the build; exit 1 lets it proceed.
#
# - Production deployments always build.
# - Preview builds are quarantined because the 2026-08-25 environment audit
#   found production-capable provider credentials in Preview scope.
# - An explicit operator-only override can force one protected canary after
#   its environment has passed the credential-isolation checklist.

set -u

if [ "${VERCEL_ENV:-}" = "production" ]; then
  exit 1
fi

if [ "${OPENVPM_FORCE_PREVIEW_BUILD:-}" = "true" ]; then
  exit 1
fi

# Do not infer preview safety from changed files, demo flags, branch names, or
# package metadata. Lifting this quarantine is a reviewed environment action.
exit 0

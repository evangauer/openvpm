#!/usr/bin/env bash
# Vercel Ignored Build Step for the projects deployed from apps/web.
# Exit 0 skips the build; exit 1 lets it proceed.
#
# - Production deployments always build.
# - The public demo deployment (NEXT_PUBLIC_DEMO_MODE=true) tracks
#   production only; its preview builds are skipped as duplicates.
# - Preview builds are skipped when nothing that ships in the web app
#   changed. turbo-ignore walks the workspace graph, so pushes that only
#   touch docs, e2e specs, or infra stop producing throwaway builds.

set -u

if [ "${VERCEL_ENV:-}" = "production" ]; then
  exit 1
fi

if [ "${NEXT_PUBLIC_DEMO_MODE:-}" = "true" ]; then
  exit 0
fi
case "${VERCEL_PROJECT_PRODUCTION_URL:-}" in
  demo.*) exit 0 ;;
esac

# turbo-ignore exits 0 when @openpims/web and its workspace dependencies
# are unchanged since the last deployment (falling back to the parent
# commit). Any failure falls through to building, never to skipping.
npx --yes turbo-ignore "@openpims/web" || exit 1
exit 0

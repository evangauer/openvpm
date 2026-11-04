# Guide screenshots

Every product image on the help site comes from this folder's capture run. It
signs into a freshly seeded OpenVPM, opens each screen in `shots.ts`, saves a
JPEG to `public/screens/`, and records where each named part of the screen sits
in `public/screens/manifest.json`. Guides point at those names, so the numbered
callouts follow the real interface rather than hand-placed coordinates.

Re-run the capture whenever the interface changes. `pnpm test` fails if a guide
points at a screenshot or part that no longer exists.

## Run it

You need the local OpenVPM services (PostgreSQL and object storage) from the
root README.

1. **Use a database just for captures.** Export `DATABASE_URL` for the whole
   shell session so every step below uses it, and point it at an empty local
   database, never one with real clinic data:

   ```sh
   export DATABASE_URL=postgresql://<user>:<password>@localhost:5432/openvpm_docs
   export DOCS_CAPTURE=1
   ```

   `DOCS_CAPTURE=1` is what lets the capture clock load. Without it the clock
   refuses to start, so it can't end up in a normal server by accident.

2. **Migrate and seed it with the capture clock.** The clock pins the server's
   time to a clinic morning (10:20 by default, `DOCS_CAPTURE_TIME=HH:MM` to
   change it) and makes the seed's random choices repeatable, so every run
   shows the same day: visits underway, pets on the whiteboard, invoices open.

   ```sh
   pnpm db:migrate
   pnpm db:rls
   NODE_OPTIONS="--import $PWD/apps/docs/capture/clock.mjs" pnpm db:seed
   ```

3. **Build and start the app with the same clock**, on port 3100. A production
   build keeps development overlays out of the pictures. Production builds
   won't create calendar feed links over plain http, so build with an HTTPS
   app URL. It only sets the address printed on screen; nothing connects to it.

   ```sh
   NEXT_PUBLIC_APP_URL=https://app.openvpm.com pnpm --filter @openpims/web build
   NODE_OPTIONS="--import $PWD/apps/docs/capture/clock.mjs" \
     pnpm --filter @openpims/web exec next start -p 3100
   ```

4. **Capture.**

   ```sh
   pnpm --filter @openpims/docs capture
   ```

   To redo a few shots, keep the rest of the manifest:

   ```sh
   DOCS_CAPTURE_ONLY=schedule,billing pnpm --filter @openpims/docs capture
   ```

Seed on the same day you capture. The clock moves only the time of day,
because browsers expire sign-in cookies on real time. It also only moves the
server's clock: the browser's "now" line on the schedule shows the real time.

The capture refuses to run against anything but `localhost`, because it makes
changes (it turns on a calendar feed and uploads a document).

## Adding a shot

Add an entry to `shots.ts` with the page, any steps to get the screen into the
right state, and the parts a guide will point at. Name parts by what they are
(`new-appointment`, `payments`), not where they are. Then reference it from a
guide step:

```ts
shot: {
  id: "invoice-sent",
  focus: "payments",              // zoom into this part
  callouts: ["record-payment"],   // numbered rings, matching ((1)) in the text
  alt: "The payments area of an invoice with Record Payment highlighted",
}
```

Captures use the fictional Neighborhood Veterinary clinic from the seed. Never
capture from a database with real clients or patients.

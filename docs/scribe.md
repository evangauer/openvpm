# Scribe

Scribe records a visit, turns the conversation into text, and drafts a SOAP
note for the veterinarian to check. It works in two places:

- **Inside a visit.** Once the exam has started, **Record visit** on the visit
  page opens the visit's SOAP note with Scribe ready. The draft fills that note,
  next to the patient's chart, and the clinician edits and finalizes it as usual.
  Scribe marks what it could not settle: `[add]` where the visit did not cover
  something the note records, `[confirm]` beside a drug, dose or value it may
  have misheard, and `[inaudible]` where the recording was unclear. The note
  cannot be finalized until every marker is resolved.
- **On its own.** The **Scribe** tool records or takes pasted text and drafts a
  note to copy into any other record system. Nothing on that page is saved to a
  chart, so clinics that keep another practice system can still use it.

Either way, the clinician can record on the computer, on a phone by scanning a
code, or from an audio file recorded elsewhere.

Scribe is off by default. This page is for whoever runs OpenVPM: what it stores,
how to switch it on, and how to keep the audio on your own machines if you want
to.

## What is stored, and for how long

| What | Stored? |
|---|---|
| Audio | Never. It is held in the browser's memory, sent to the speech-to-text service in pieces of 20–30 seconds, and dropped once its text comes back. A piece that fails stays in the browser until it is retried or skipped. |
| Transcript of a visit | Kept with the visit so the note can be drafted (and redrafted). Deleted when the visit's note is finalized, when a clinic turns Scribe off, or by the next daily clean-up once 24 hours have passed since the last recording, whichever comes first. |
| Transcript on the standalone page | Only in the browser tab. Leaving the page discards it after a warning. |
| Drafted note | Not saved by Scribe. Inside a visit it becomes the visit's SOAP draft, which the clinician reviews and finalizes. |
| Usage | Per recording: who recorded, which visit, how many seconds of audio and how many AI runs it was billed as. No words. Kept 30 days. |
| Audit log | "Recorded" and "drafted" entries with sizes and counts only. Transcripts never reach the audit log or error reports. |

Where the audio goes depends on the speech-to-text option you choose below. With
a local speech server it never leaves your network.

## Before you switch it on

- **Consent.** Recording starts only after the clinician confirms that everyone in
  the room knows about it and agrees. Check what your state or country requires
  and whether you also want a sign in the exam room.
- **HTTPS.** Browsers allow the microphone only on HTTPS (or `localhost`). A phone
  scanning the code must be able to reach your OpenVPM address over HTTPS.
- **Your AI provider's terms.** Recordings and transcripts go to the
  speech-to-text and note-drafting services you configure. Check their data
  terms before clinic audio goes through them. The local-development Vertex API
  key (`GOOGLE_VERTEX_API_KEY`) is not meant for clinic data.

## Switching it on

1. Set `NEXT_PUBLIC_SCRIBE_ENABLED=true` and rebuild. While it is false the app
   never asks the server about Scribe, the server refuses every Scribe call, and
   the microphone permission stays off for the whole app.
2. Apply migrations (`pnpm db:migrate`, then `pnpm db:rls`). Scribe adds two
   tables and a `purpose` column on capture links, so migrate before you deploy
   the new build.
3. Configure note drafting: Scribe drafts with the same AI model as the rest of
   OpenVPM (`AI_MODEL` and its credentials).
4. Configure speech-to-text (next section).
5. A clinic administrator opens **Scribe** from **All tools** and selects
   **Turn on Scribe for this clinic**. Administrators and veterinarians can use
   it; other roles cannot see it.

On OpenVPM Cloud, Scribe also reaches clinics in stages: only clinics listed in
`SCRIBE_PRACTICE_IDS` (comma-separated practice ids, or `*` for all) see it.
Self-hosted installations ignore that setting.

## Speech-to-text options

**A Gemini model.** If `AI_MODEL` is a Gemini model, recording works with no more
settings. If `AI_MODEL` is a model that cannot take audio, such as Claude, set
`SCRIBE_TRANSCRIPTION_MODEL` to a Gemini model.

**Your own speech server.** Set `SCRIBE_TRANSCRIPTION_URL` to the base URL of any
server that offers the common `POST /audio/transcriptions` API, and
`SCRIBE_TRANSCRIPTION_MODEL` to the model name it expects. Add
`SCRIBE_TRANSCRIPTION_API_KEY` if it needs one. With a server on your own
machine, audio never leaves your network.

For example, with [whisper.cpp](https://github.com/ggml-org/whisper.cpp):

```bash
whisper-server -m models/ggml-small.en.bin --host 127.0.0.1 --port 8178 \
  --inference-path /v1/audio/transcriptions
```

```bash
SCRIBE_TRANSCRIPTION_URL=http://127.0.0.1:8178/v1
SCRIBE_TRANSCRIPTION_MODEL=whisper-1
```

Do not add whisper.cpp's `-sns` (suppress non-speech tokens) option. In our
testing it made the server drop whole sentences after a pause, including exam
findings. Larger models spell drug names better. Scribe also passes a spelling
hint: the patient's name and species, the names of products in the clinic's
inventory (so stocked drugs come out spelled the way the clinic writes them),
and the end of the transcript so far.

## Limits and billing

- A recording stops by itself at 45 minutes. A clinician can record more into
  the same visit, up to about 60,000 characters of transcript per visit.
- Audio files up to 200 MB in the usual formats (MP3, M4A, MP4, WAV, AAC, OGG,
  WebM).
- A phone code works for one phone, for up to an hour, and closes when that
  phone finishes, when the clinician stops it, or when the note is finalized.
  Anyone else who scans the same code is turned away.
- One device records a visit at a time.
- On OpenVPM Cloud, each started 10 minutes of audio counts as one AI run, and
  each drafted note counts as one more. Self-hosted installations are not
  metered.

## Clean-up

Transcripts are deleted when a note is finalized or a clinic turns Scribe off.
Transcripts that a visit left behind are removed after 24 hours by the daily
`/api/cron/rate-limit-cleanup` job and, on self-hosted installations without
that job, whenever the clinic next uses Scribe. If you switch Scribe off for the
whole deployment, that daily job still runs and removes what is left within two
days; without it, run the job once by hand after switching off.

## If something goes wrong

| What the clinician sees | What to check |
|---|---|
| "AI is not set up" | `AI_MODEL` and its credentials. |
| No **Record** buttons, only paste | No speech-to-text option is configured (see above). |
| "The microphone is blocked for this site" | The browser's site permissions, and that the site is on HTTPS. |
| "Scribe isn't hearing anything" | A muted microphone or the wrong input device in the operating system's sound settings. |
| "Part of the recording could not be transcribed" | The speech service is down or slow. The audio is kept on the page; **Try again** once it is back. |
| The phone says the link is closed | The code expired, was stopped on the computer, or the note was finalized. Show a new code. |

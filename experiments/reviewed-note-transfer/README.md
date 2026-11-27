# Reviewed SOAP note transfer lab

This unpacked Chrome extension lets you preview a fictional SOAP note and apply its four sections to a draft on a local test page. The fixture has two pets with the same name and two encounters for one pet. The extension matches both patient and visit identifiers, checks all four fields before writing, and refuses to overwrite existing text.

The lab uses bundled sample text. It has no connection to Scribe, an AI service, patient records, or a vendor PIMS. Nothing is saved or transmitted. Reloading the test page discards the note. The lab runs separately from the OpenVPM application and requires no account or database.

## Try it

1. From this directory, run `python3 -m http.server 41763 --bind 127.0.0.1 --directory fixture`.
2. Open `chrome://extensions` in a development browser profile. Turn on **Developer mode**, choose **Load unpacked**, and select the `extension` directory next to this file.
3. Open [the local chart](http://127.0.0.1:41763/openvpm-transfer-fixture.html). Select **Preview transfer**. Compare the identifiers and the four sections with the destination. Select **Apply to draft fields** and review the result.
4. Reload and preview again. Choose another visit or type a few words in a destination field, then apply. The extension reports why the transfer stopped and preserves all four fields.

The manifest limits injection to the fixture URL, including its port. There are no extension API permissions, background workers, storage, clipboard access, or network requests from the extension. Remove the extension from your development profile and stop the fixture server when finished.

## Run the Chromium check

With the repository's development dependencies and Playwright Chromium installed, stop the manual fixture server and run this command from the repository root:

```sh
node --test experiments/reviewed-note-transfer/verify.test.mjs
```

The check starts a loopback server and a temporary Chromium profile, loads the actual extension, tests the preview and apply sequence, switches between patient and encounter identifiers, edits and locks destination fields, checks that reload clears the draft, and verifies the extension stays inactive on other URLs. No OpenVPM services or provider credentials are needed.

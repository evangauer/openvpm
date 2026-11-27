# Reviewed SOAP note transfer lab

This unpacked Chrome extension accepts the plain text from Scribe’s **Copy full note** action. You paste the text, enter the expected patient and visit identifiers separately, and review the four sections before applying them to a local draft. The fixture has two pets with the same name and two encounters for one pet. The extension matches both patient and visit identifiers, checks all four fields before writing, and refuses to overwrite existing text.

Use fictional text in this lab. It accepts manual input or a bundled example and has no connection to Scribe, an AI service, patient records, or a vendor PIMS. Input and applied fields exist in the browser page. Reload to discard them. The lab runs separately from the OpenVPM application and requires no account or database.

## Try it

1. From this directory, run `python3 -m http.server 41763 --bind 127.0.0.1 --directory fixture`.
2. Open `chrome://extensions` in a development browser profile. Turn on **Developer mode**, choose **Load unpacked**, and select the `extension` directory next to this file.
3. Open [the local chart](http://127.0.0.1:41763/openvpm-transfer-fixture.html). Paste a reviewed, fictional note into **Full SOAP note**, or choose **Load example note**. You can edit the text here.
4. Enter the patient and visit IDs from your fictional source independently of the selected destination. For the example use `DEMO-014` and `VISIT-07`.
5. Select **Preview transfer**, compare both identifiers with the open chart, and check all four section texts. Confirm the review and select **Apply to draft fields**. Review the result in the destination chart.
6. Reload and repeat through confirmation. Choose a different visit or type into a destination field before applying. The extension reports why it stopped. Editing the source text or either expected identifier requires a fresh preview and confirmation.

**Note format.** The Scribe formatter places each label (Subjective, Objective, Assessment, Plan) on its own line above the section text, with a blank line before the next label. Scribe omits empty sections when copying. This lab accepts a complete four-section note and rejects partial notes or ambiguous or repeated headings. It preserves paragraph breaks and inserts plain text. The copied note carries no patient or encounter identifiers, so the person using it must supply and verify both.

The manifest limits injection to the fixture URL, including its port. There are no extension API permissions, background workers, storage, clipboard access, or network requests from the extension. Remove the extension from your development profile and stop the fixture server when finished.

## Run the Chromium check

With the repository's development dependencies and Playwright Chromium installed, stop the manual fixture server and run this command from the repository root:

```sh
node --test experiments/reviewed-note-transfer/verify.test.mjs
```

The check starts a loopback server and a temporary Chromium profile, loads the actual extension, tests editable full-note input, malformed and incomplete notes, confirmation and application, switches between patient and encounter identifiers, edits and locks destination fields, checks that reload clears the draft, and verifies the extension stays inactive on other URLs. No OpenVPM services or provider credentials are needed.

// The adapter is loaded only on the synthetic fixture.
(() => {
  const fixtureUrl = "http://127.0.0.1:41763/openvpm-transfer-fixture.html";
  const mount = document.querySelector("#transfer-lab");
  const destination = document.querySelector("#destination-chart");
  if (location.href !== fixtureUrl || !mount || !destination) return;

  const sectionNames = ["Subjective", "Objective", "Assessment", "Plan"];
  const example = [
    "Subjective\nOwner reports Juniper has been eating normally.",
    "Objective\nWeight recorded at this visit: 4.2 kg.",
    "Assessment\nRoutine follow-up visit.",
    "Plan\nOwner will keep the scheduled follow-up appointment.",
  ].join("\n\n");

  const panel = document.createElement("section");
  panel.setAttribute("aria-labelledby", "transfer-heading");
  panel.innerHTML = `
    <h2 id="transfer-heading">Reviewed note</h2>
    <p>Paste a fictional note from Scribe’s <strong>Copy full note</strong>, or try the example for patient DEMO-014, visit VISIT-07.</p>
    <button type="button" class="example">Load example note</button>
    <label>Full SOAP note<textarea class="source" rows="8" autocomplete="off" spellcheck="false"></textarea></label>
    <p>Scribe copies the note text only. Check the patient and visit IDs in the source record before entering them here.</p>
    <label>Expected patient ID<input class="patient" autocomplete="off" spellcheck="false"></label>
    <label>Expected visit ID<input class="encounter" autocomplete="off" spellcheck="false"></label>
    <button type="button" class="preview">Preview transfer</button>
    <div class="review" hidden>
      <h3>Transfer preview</h3>
      <p class="identity"></p>
      <dl></dl>
      <label><input type="checkbox"> I checked the patient, visit, and all four sections.</label>
      <button type="button" class="apply" disabled>Apply to draft fields</button>
      <button type="button" class="cancel">Cancel transfer</button>
    </div>
    <p role="status"></p>
  `;
  mount.replaceChildren(panel);
  const source = panel.querySelector(".source");
  const patient = panel.querySelector(".patient");
  const encounter = panel.querySelector(".encounter");
  const exampleButton = panel.querySelector(".example");
  const review = panel.querySelector(".review");
  const details = panel.querySelector("dl");
  const status = panel.querySelector("[role=status]");
  const confirm = panel.querySelector("[type=checkbox]");
  const apply = panel.querySelector(".apply");
  const previewButton = panel.querySelector(".preview");
  let preview;

  // Scribe emits a full-line label, a newline and the text for each nonempty
  // section, separated by a blank line. This four-field adapter fails closed on
  // partial notes or an ambiguous heading; it never supplies clinical text.
  function parseFullNote(value) {
    const lines = value.trim().replaceAll("\r\n", "\n").split("\n");
    const headings = [];
    lines.forEach((line, index) => {
      if (sectionNames.includes(line)) headings.push(index);
    });
    const complete = headings.length === sectionNames.length &&
      headings[0] === 0 &&
      headings.every((line, i) => lines[line] === sectionNames[i] && (i === 0 || !lines[line - 1].trim()));
    if (!complete) {
      throw new Error("Paste all four sections in Scribe’s full-note format, with each heading on its own line and a blank line between sections.");
    }
    return headings.map((line, i) => {
      const text = lines.slice(line + 1, headings[i + 1] ?? lines.length).join("\n").trim();
      if (!text) throw new Error(`${sectionNames[i]} is empty. Only complete reviewed notes can be transferred.`);
      return text;
    });
  }

  function clearPreview(message) {
    const restoreFocus = review.contains(document.activeElement);
    preview = undefined;
    review.hidden = true;
    details.replaceChildren();
    confirm.checked = false;
    apply.disabled = true;
    status.textContent = message;
    if (restoreFocus) previewButton.focus();
  }

  function inspectChart(patientId, encounterId) {
    const charts = document.querySelectorAll("form[data-patient][data-encounter]");
    if (location.href !== fixtureUrl || charts.length !== 1) {
      throw new Error("Open one chart in the local fixture and preview again.");
    }
    const chart = charts[0];
    if (chart.dataset.patient !== patientId || chart.dataset.encounter !== encounterId) {
      throw new Error("This note belongs to a different patient or visit. Check both identifiers.");
    }
    if (chart.dataset.saveBehavior !== "manual-draft") {
      throw new Error("Transfer stopped. This editor must keep all four fields unsaved until a person chooses to save.");
    }
    return sectionNames.map((section) => {
      const matches = chart.querySelectorAll(`textarea[name="${section}"]`);
      const field = matches[0];
      if (matches.length !== 1 || field.form !== chart || field.matches(":disabled") || field.readOnly) {
        throw new Error(`The ${section} destination is missing, duplicated, or unavailable. Check the chart.`);
      }
      if (field.value !== "") {
        throw new Error(`${section} already contains text. Transfer stopped to preserve the chart.`);
      }
      return field;
    });
  }

  exampleButton.addEventListener("click", () => {
    if (source.value) return;
    source.value = example;
    exampleButton.disabled = true;
    clearPreview("Example loaded. Enter its patient and visit identifiers.");
  });
  for (const input of [source, patient, encounter]) {
    input.addEventListener("input", () => {
      exampleButton.disabled = Boolean(source.value);
      clearPreview("Preview the current note and identifiers before applying.");
    });
  }

  function invalidateDestinationReview() {
    if (preview) clearPreview("The destination changed. Review the current chart and preview again.");
  }
  destination.addEventListener("input", invalidateDestinationReview);
  destination.addEventListener("change", invalidateDestinationReview);

  function cancelTransfer() {
    clearPreview("Transfer canceled. Your source note is ready for a new preview.");
    previewButton.focus();
  }
  panel.querySelector(".cancel").addEventListener("click", cancelTransfer);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.isComposing && preview) {
      event.preventDefault();
      cancelTransfer();
    }
  });

  previewButton.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    clearPreview("");
    try {
      const patientId = patient.value.trim();
      const encounterId = encounter.value.trim();
      if (!patientId || !encounterId) throw new Error("Enter the expected patient and visit identifiers.");
      const sections = parseFullNote(source.value);
      const fields = inspectChart(patientId, encounterId);
      preview = { patientId, encounterId, text: source.value, sections, fields };
      panel.querySelector(".identity").textContent = `Patient ${patientId} · Visit ${encounterId}`;
      sections.forEach((value, i) => {
        const term = document.createElement("dt");
        const description = document.createElement("dd");
        term.textContent = sectionNames[i];
        description.textContent = value;
        details.append(term, description);
      });
      review.hidden = false;
      status.textContent = "Confirm the preview to apply these sections.";
    } catch (error) {
      clearPreview(error.message);
    }
  });

  confirm.addEventListener("change", () => { apply.disabled = !confirm.checked; });
  apply.addEventListener("click", (event) => {
    if (!event.isTrusted || !confirm.checked || !preview) return;
    try {
      if (source.value !== preview.text || patient.value.trim() !== preview.patientId ||
          encounter.value.trim() !== preview.encounterId) {
        throw new Error("The source changed after preview. Preview the transfer again.");
      }
      const fields = inspectChart(preview.patientId, preview.encounterId);
      if (!fields.every((field, index) => field === preview.fields[index])) {
        throw new Error("The chart changed after preview. Preview the transfer again.");
      }
      fields.forEach((field, i) => { field.value = preview.sections[i]; });
      clearPreview("Four sections applied to the local draft. Review the chart below.");
      fields[0].focus();
    } catch (error) {
      clearPreview(error.message);
    }
  });
})();

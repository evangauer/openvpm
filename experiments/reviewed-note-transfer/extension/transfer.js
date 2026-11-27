// This adapter and its note belong only to the synthetic fixture.
(() => {
  const fixtureUrl = "http://127.0.0.1:41763/openvpm-transfer-fixture.html";
  const mount = document.querySelector("#transfer-lab");
  if (location.href !== fixtureUrl || !mount) return;

  const note = {
    patient: "DEMO-014",
    encounter: "VISIT-07",
    name: "Juniper",
    sections: {
      Subjective: "Owner reports Juniper has been eating normally.",
      Objective: "Weight recorded at this visit: 4.2 kg.",
      Assessment: "Routine follow-up visit.",
      Plan: "Owner will keep the scheduled follow-up appointment.",
    },
  };
  const panel = document.createElement("section");
  panel.setAttribute("aria-labelledby", "transfer-heading");
  panel.innerHTML = `
    <h2 id="transfer-heading">Reviewed note</h2>
    <p class="identity"></p>
    <button type="button" class="preview">Preview transfer</button>
    <dl hidden></dl>
    <button type="button" class="apply" hidden>Apply to draft fields</button>
    <p role="status"></p>
  `;
  mount.replaceChildren(panel);
  panel.querySelector(".identity").textContent = `${note.name} · ${note.patient} · ${note.encounter}`;
  const details = panel.querySelector("dl");
  const status = panel.querySelector("[role=status]");
  const apply = panel.querySelector(".apply");
  for (const [label, value] of Object.entries(note.sections)) {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    details.append(term, description);
  }

  let preview;

  function clearPreview(message) {
    preview = undefined;
    details.hidden = true;
    apply.hidden = true;
    status.textContent = message;
  }

  function inspectChart() {
    const charts = document.querySelectorAll("form[data-patient][data-encounter]");
    if (location.href !== fixtureUrl || charts.length !== 1) {
      throw new Error("Open one chart in the local fixture and preview again.");
    }
    const chart = charts[0];
    if (chart.dataset.patient !== note.patient || chart.dataset.encounter !== note.encounter) {
      throw new Error("This note belongs to a different patient or visit. Check both identifiers.");
    }
    const fields = [];
    for (const section of Object.keys(note.sections)) {
      const matches = chart.querySelectorAll(`textarea[name="${section}"]`);
      const field = matches[0];
      if (matches.length !== 1 || field.form !== chart || field.matches(":disabled") || field.readOnly) {
        throw new Error(`The ${section} destination is missing, duplicated, or unavailable. Check the chart.`);
      }
      if (field.value !== "") {
        throw new Error(`${section} already contains text. Transfer stopped to preserve the chart.`);
      }
      fields.push(field);
    }
    return fields;
  }

  panel.querySelector(".preview").addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    try {
      preview = inspectChart();
      details.hidden = false;
      apply.hidden = false;
      status.textContent = "Check the patient, visit, and four sections before applying.";
    } catch (error) {
      clearPreview(error.message);
    }
  });

  apply.addEventListener("click", (event) => {
    if (!event.isTrusted || !preview) return;
    try {
      const fields = inspectChart();
      if (!fields.every((field, index) => field === preview[index])) {
        throw new Error("The chart changed after preview. Preview the transfer again.");
      }
      for (const field of fields) field.value = note.sections[field.name];
      clearPreview("Four sections applied to the local draft. Review the chart below.");
    } catch (error) {
      clearPreview(error.message);
    }
  });
})();

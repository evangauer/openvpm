const visit = document.querySelector("#visit");
const blankForm = document.querySelector("template").content.firstElementChild;
const drafts = new Map();

function openVisit() {
  const option = visit.selectedOptions[0];
  const { patient, encounter } = option.dataset;
  const visitKey = JSON.stringify([patient, encounter]);
  // Remount the live values so any prior preview still refers to old fields.
  const form = (drafts.get(visitKey) ?? blankForm).cloneNode(true);
  form.dataset.patient = patient;
  form.dataset.encounter = encounter;
  form.addEventListener("submit", (event) => event.preventDefault());
  drafts.set(visitKey, form);
  document.querySelector("#chart").replaceChildren(form);
}
visit.addEventListener("change", openVisit);
openVisit();

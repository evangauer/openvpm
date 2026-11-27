const visit = document.querySelector("#visit");
const blankForm = document.querySelector("template").content.firstElementChild;
const drafts = new Map();

function openVisit() {
  const option = visit.selectedOptions[0];
  // Each option identifies one patient and encounter. Clone its live draft to
  // preserve textarea values while making prior preview field references stale.
  const form = (drafts.get(option) ?? blankForm).cloneNode(true);
  form.dataset.patient = option.dataset.patient;
  form.dataset.encounter = option.dataset.encounter;
  form.addEventListener("submit", (event) => event.preventDefault());
  drafts.set(option, form);
  document.querySelector("#chart").replaceChildren(form);
}
visit.addEventListener("change", openVisit);
openVisit();

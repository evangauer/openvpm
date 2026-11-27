const visit = document.querySelector("#visit");
function openVisit() {
  const option = visit.selectedOptions[0];
  const form = document.querySelector("template").content.firstElementChild.cloneNode(true);
  form.dataset.patient = option.dataset.patient;
  form.dataset.encounter = option.dataset.encounter;
  form.addEventListener("submit", (event) => event.preventDefault());
  document.querySelector("#chart").replaceChildren(form);
}
visit.addEventListener("change", openVisit);
openVisit();

// jsdom does not implement native dialog opening. Browser validation covers inertness
// and focus containment; this shim only models visibility for component tests.
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};

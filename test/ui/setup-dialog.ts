// jsdom does not implement native dialog opening. Browser validation covers inertness
// and focus containment; this shim only models visibility for component tests.
// Guarded so a `@vitest-environment node` UI-module unit test (no DOM) can share this
// setup file without crashing on the absent global.
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
}

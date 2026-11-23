(() => {
  const reload = document.getElementById("startupReload");
  const player = document.getElementById("player");
  const meta = document.getElementById("bookMeta");
  const announcer = document.getElementById("statusAnnouncer");

  reload.addEventListener("click", () => location.reload());
  document.addEventListener("error", (event) => {
    if (event.target?.id !== "playerEntry") return;

    const moveFocus = player.contains(document.activeElement);
    const message = "The player could not load.";
    document.body.classList.remove("is-loading");
    player.classList.remove("is-loading");
    player.setAttribute("aria-busy", "false");
    meta.textContent = message;
    meta.classList.add("is-error");
    player.replaceChildren(reload);
    reload.hidden = false;
    announcer.textContent = message;
    if (moveFocus) reload.focus();
  }, true);
})();

const focusByDialog = new WeakMap();

function focusableElements(container) {
  return [...container.querySelectorAll("button:not(:disabled), select:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex='-1'])")]
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function fallbackKeydown(event) {
  const dialog = event.currentTarget;
  if (event.key === "Escape") {
    event.preventDefault();
    if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) closeDialog(dialog);
    return;
  }
  if (event.key !== "Tab") return;
  const items = focusableElements(dialog);
  if (!items.length) { event.preventDefault(); return; }
  const first = items[0];
  const last = items.at(-1);
  if (event.shiftKey && dialog.ownerDocument.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && dialog.ownerDocument.activeElement === last) { event.preventDefault(); first.focus(); }
}

export function openDialog(dialog, focusTarget) {
  if (!dialog || dialog.open) return;
  focusByDialog.set(dialog, dialog.ownerDocument.activeElement);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else {
    dialog.setAttribute("open", "");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.addEventListener("keydown", fallbackKeydown);
    dialog.ownerDocument.querySelector("main")?.setAttribute("inert", "");
  }
  dialog.ownerDocument.defaultView.requestAnimationFrame(() => (focusTarget || focusableElements(dialog)[0] || dialog).focus?.());
}

export function closeDialog(dialog) {
  if (!dialog?.open && !dialog?.hasAttribute("open")) return;
  if (typeof dialog.close === "function") dialog.close();
  else {
    dialog.removeAttribute("open");
    dialog.removeEventListener("keydown", fallbackKeydown);
    dialog.ownerDocument.querySelector("main")?.removeAttribute("inert");
  }
  const previous = focusByDialog.get(dialog);
  focusByDialog.delete(dialog);
  dialog.ownerDocument.defaultView.requestAnimationFrame(() => previous?.isConnected && previous.focus?.());
}

export function bindDialogDismiss(dialog, closeButton, onClose) {
  const dismiss = () => { if (onClose?.() !== false) closeDialog(dialog); };
  closeButton?.addEventListener("click", dismiss);
  dialog?.addEventListener("cancel", (event) => { event.preventDefault(); dismiss(); });
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) dismiss();
  });
}

export function openPanel(panel, trigger, firstFocus) {
  panel.hidden = false;
  trigger?.setAttribute("aria-expanded", "true");
  trigger?.classList.add("is-active");
  const document = panel.ownerDocument;
  const previous = document.activeElement;
  document.defaultView.requestAnimationFrame(() => {
    if (!panel.hidden && document.activeElement === previous) (firstFocus || focusableElements(panel)[0])?.focus?.();
  });
}

export function closePanel(panel, trigger, restoreFocus = false) {
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  trigger?.setAttribute("aria-expanded", "false");
  trigger?.classList.remove("is-active");
  if (restoreFocus) panel.ownerDocument.defaultView.requestAnimationFrame(() => trigger?.focus?.());
}

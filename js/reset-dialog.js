import { bindDialogDismiss, closeDialog, openDialog } from "./dialogs.js?v=25";
import { clearChildren, setText } from "./utils.js?v=25";

export function createResetDialog({ dialog, trigger, title, closeButton, cancelButton, confirmButton, body,
  t, setTooltip, announce, stopPlayer, clearSettings, clearDownloads, reportError, reload }) {
  let remaining = null;

  function renderBody() {
    clearChildren(body);
    const paragraphs = remaining
      ? [remaining.local && t("resetLocalFailed"), remaining.offline && t(remaining.offline === "conflict" ? "offlineTabConflict" : "resetOfflineFailed")].filter(Boolean)
      : t("resetBody").split(/\n\s*\n/);
    const action = t(remaining ? "retryReset" : "resetOk");
    setText(confirmButton, action);
    setTooltip(confirmButton, action);
    for (const text of paragraphs) {
      const paragraph = body.ownerDocument.createElement("p");
      paragraph.textContent = text;
      body.appendChild(paragraph);
    }
  }

  function dismiss() {
    if (confirmButton.disabled) return false;
    if (remaining) reload();
  }

  bindDialogDismiss(dialog, closeButton, dismiss);
  trigger.addEventListener("click", () => openDialog(dialog, confirmButton));
  cancelButton.addEventListener("click", () => { if (dismiss() !== false) closeDialog(dialog); });
  confirmButton.addEventListener("click", async () => {
    if (confirmButton.disabled) return;
    if (!remaining) {
      remaining = { local: true, offline: true };
      stopPlayer();
    }
    confirmButton.disabled = true;
    setText(confirmButton, t("resetting"));
    if (remaining.local) remaining.local = !clearSettings();
    if (remaining.offline) {
      try {
        await clearDownloads();
        remaining.offline = false;
      } catch (error) {
        remaining.offline = error?.code === "conflict" ? "conflict" : true;
        reportError(error);
      }
    }
    if (!remaining.local && !remaining.offline) { reload(); return; }
    confirmButton.disabled = false;
    renderBody();
    announce([...body.children].map((item) => item.textContent).join(" "));
    confirmButton.focus();
  });

  return {
    get active() { return remaining !== null; },
    render() {
      setText(trigger, t("resetLink"));
      setTooltip(trigger, t("resetLink"));
      setText(title, t("resetTitle"));
      closeButton.setAttribute("aria-label", t("close"));
      setTooltip(closeButton, t("close"));
      setText(cancelButton, t("resetCancel"));
      setTooltip(cancelButton, t("resetCancel"));
      renderBody();
    },
  };
}

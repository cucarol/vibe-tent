/**
 * Context Card drag helpers (Desktop B6).
 *
 * Windows MVP uses Chromium/Electron HTML5 drag with `text/plain` only.
 * Electron `webContents.startDrag` is file-path only and is intentionally
 * not used here — do not pretend clipboard write is "native drag".
 */

/** Apply stable context-card payload to a dragstart DataTransfer. */
export function applyContextCardDragStart(
  dataTransfer: DataTransfer | null | undefined,
  text: string
): void {
  if (!dataTransfer) return;
  dataTransfer.clearData();
  dataTransfer.setData("text/plain", text);
  dataTransfer.effectAllowed = "copy";
}

export type BindContextCardDragOptions = {
  /** Optional status / toast after successful click-to-copy. */
  onCopied?: (text: string) => void;
  /** Optional error surface for clipboard failures. */
  onCopyError?: (err: unknown) => void;
  /**
   * Clipboard writer for click-to-copy (auxiliary path only).
   * Drag must never call this.
   */
  writeClipboard?: (text: string) => Promise<void> | void;
};

/**
 * Wire left-button HTML5 drag + optional click-to-copy on a card element.
 * Payload is always the prebuilt `text/plain` from `contextCardToDragText`.
 */
export function bindContextCardDrag(
  node: HTMLElement,
  text: string,
  options: BindContextCardDragOptions = {}
): void {
  node.draggable = true;
  node.setAttribute("title", "拖到外部输入框 · 单击复制");

  node.addEventListener("dragstart", (ev: DragEvent) => {
    applyContextCardDragStart(ev.dataTransfer, text);
    node.classList.add("is-dragging");
  });

  node.addEventListener("dragend", () => {
    node.classList.remove("is-dragging");
  });

  node.addEventListener("click", () => {
    void copyContextCardText(text, options);
  });
}

export async function copyContextCardText(
  text: string,
  options: BindContextCardDragOptions = {}
): Promise<void> {
  const write =
    options.writeClipboard ??
    (async (value: string) => {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
      throw new Error("Clipboard API unavailable");
    });
  try {
    await write(text);
    options.onCopied?.(text);
  } catch (err) {
    options.onCopyError?.(err);
  }
}

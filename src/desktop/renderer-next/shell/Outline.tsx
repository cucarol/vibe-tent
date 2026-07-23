/**
 * Outline drawer/overlay chrome for the single-window shell.
 * Default collapsed; opened from rail/chrome. Not a stage surface.
 * Real tree projection binds later via ServiceGateway — foundation only.
 */

import type { OutlineChromeState } from "../types/outline.js";
import { OUTLINE_PANEL_ID } from "../types/outline.js";

export type OutlineProps = {
  chrome: OutlineChromeState;
  /** Explicit close control (also Esc from AppShell). */
  onClose: () => void;
  /** Optional status line under the title. */
  subtitle?: string;
};

export function Outline(props: OutlineProps) {
  const {
    chrome,
    onClose,
    subtitle = "Concept / box tree placeholder · open from rail or chrome",
  } = props;

  if (!chrome.open) return null;

  return (
    <>
      <button
        type="button"
        className="tn-outline-scrim"
        data-region="outline-scrim"
        aria-label="Close Outline"
        tabIndex={-1}
        onClick={onClose}
      />
      <aside
        id={OUTLINE_PANEL_ID}
        className="tn-outline"
        data-region="outline"
        data-outline-open="true"
        data-current-entity={chrome.currentEntityRef ?? undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Outline"
      >
        <div className="tn-outline-head">
          <span>Outline</span>
          <button
            type="button"
            className="tn-outline-close"
            data-outline-close=""
            aria-label="Close Outline"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="tn-outline-body">
          <p>{subtitle}</p>
          <p>
            Tree projection will bind to ServiceGateway (docs.tree +
            box.projection). Expand keys and current entity are local chrome
            state only.
          </p>
          <p data-testid="outline-current-entity">
            Current entity: {chrome.currentEntityRef ?? "—"}
          </p>
          <p data-testid="outline-expanded-count">
            Expanded nodes: {chrome.expandedIds.length}
          </p>
        </div>
      </aside>
    </>
  );
}

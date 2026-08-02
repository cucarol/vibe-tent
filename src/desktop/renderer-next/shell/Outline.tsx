/**
 * Outline drawer/overlay chrome for the single-window shell.
 * Default collapsed; opened from rail/chrome. Not a stage surface.
 * Real tree projection binds later via ServiceGateway — foundation only.
 *
 * Panel stays in the DOM (hidden when closed) so aria-controls targets remain valid.
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
    subtitle = "Node tree placeholder · open from rail or chrome",
  } = props;
  const open = chrome.open;

  return (
    <>
      {open ? (
        <button
          type="button"
          className="tn-outline-scrim"
          data-region="outline-scrim"
          aria-label="Close Outline"
          tabIndex={-1}
          onClick={onClose}
        />
      ) : null}
      <aside
        id={OUTLINE_PANEL_ID}
        className="tn-outline"
        data-region="outline"
        data-outline-open={open ? "true" : "false"}
        data-current-entity={chrome.currentEntityRef ?? undefined}
        role="dialog"
        aria-modal={open ? true : undefined}
        aria-label="Outline"
        hidden={!open}
        inert={!open ? true : undefined}
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
            node.collaboration). Expand keys and current entity are local chrome
            state only — no RPC in this foundation.
          </p>
          <p data-testid="outline-current-entity">
            Current entity: {chrome.currentEntityRef ?? "—"}
          </p>
          <p data-testid="outline-expanded-count">
            Expanded nodes: {chrome.expandedIds.length}
          </p>
          {chrome.expandedIds.length > 0 ? (
            <ul data-testid="outline-expanded-ids" className="tn-outline-expanded-list">
              {chrome.expandedIds.map((id) => (
                <li key={id} data-expanded-node={id}>
                  {id}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </aside>
    </>
  );
}

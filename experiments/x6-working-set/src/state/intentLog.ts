import type { IntentCategory, IntentRecord } from "../model/types.js";

let seq = 0;

export function makeIntent(
  category: IntentCategory,
  label: string
): IntentRecord {
  seq += 1;
  return {
    id: `intent-${seq}`,
    category,
    label,
    at: Date.now(),
    undoable: category === "layout",
  };
}

export function pushIntent(
  list: IntentRecord[],
  intent: IntentRecord,
  max = 40
): IntentRecord[] {
  return [intent, ...list].slice(0, max);
}

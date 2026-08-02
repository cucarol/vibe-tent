import type { TaskActorRef } from "./task-model.js";

export type DecisionRequestStatus = "pending" | "answered";

export type DecisionRequestOption = {
  id: string;
  label: string;
};

export type DecisionResponse =
  | { kind: "option"; optionId: string }
  | { kind: "custom"; text: string }
  | { kind: "deny" };

export type PendingDecisionRequest = {
  id: string;
  taskId: string;
  requester: TaskActorRef;
  target: TaskActorRef;
  question: string;
  options: DecisionRequestOption[];
  blocking: boolean;
  status: "pending";
  response?: never;
};

export type AnsweredDecisionRequest = {
  id: string;
  taskId: string;
  requester: TaskActorRef;
  target: TaskActorRef;
  question: string;
  options: DecisionRequestOption[];
  blocking: boolean;
  status: "answered";
  response: DecisionResponse;
};

export type DecisionRequest =
  | PendingDecisionRequest
  | AnsweredDecisionRequest;

const REQUEST_FIELDS = [
  "id",
  "taskId",
  "requester",
  "target",
  "question",
  "options",
  "blocking",
  "status",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string
): void {
  const expected = new Set(fields);
  const actual = Object.keys(value);
  if (actual.length !== fields.length || actual.some((key) => !expected.has(key))) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function parseActor(value: unknown, label: string): TaskActorRef {
  if (!isRecord(value)) throw new Error(`${label} must be an actor object.`);
  assertExactFields(value, ["kind", "id"], label);
  const kind = value.kind;
  const id = requiredText(value.id, `${label}.id`).trim();
  if (kind !== "user" && kind !== "role") {
    throw new Error(`${label}.kind must be user or role.`);
  }
  if (kind === "user" && id !== "user") {
    throw new Error(`${label}.id must be user for a user actor.`);
  }
  if (kind === "role" && id === "user") {
    throw new Error(`${label}.id must name a role, not user.`);
  }
  return { kind, id };
}

function parseOption(value: unknown, index: number): DecisionRequestOption {
  if (!isRecord(value)) throw new Error(`options[${index}] must be an object.`);
  assertExactFields(value, ["id", "label"], `options[${index}]`);
  return {
    id: requiredText(value.id, `options[${index}].id`).trim(),
    label: requiredText(value.label, `options[${index}].label`),
  };
}

export function validateDecisionResponse(
  value: unknown,
  options: readonly DecisionRequestOption[]
): DecisionResponse {
  if (!isRecord(value)) throw new Error("response must be an object.");
  const kind = value.kind;
  if (kind === "option") {
    assertExactFields(value, ["kind", "optionId"], "response");
    const optionId = requiredText(value.optionId, "response.optionId").trim();
    if (!options.some((option) => option.id === optionId)) {
      throw new Error(`response.optionId is not one of the agent-provided options: ${optionId}.`);
    }
    return { kind, optionId };
  }
  if (kind === "custom") {
    assertExactFields(value, ["kind", "text"], "response");
    return { kind, text: requiredText(value.text, "response.text") };
  }
  if (kind === "deny") {
    assertExactFields(value, ["kind"], "response");
    return { kind };
  }
  throw new Error("response.kind must be option, custom, or deny.");
}

/** Validate and defensively copy a request received at a Core boundary. */
export function validateDecisionRequest(value: unknown): DecisionRequest {
  if (!isRecord(value)) throw new Error("Decision request must be an object.");
  const status = value.status;
  const fields = status === "answered" ? [...REQUEST_FIELDS, "response"] : REQUEST_FIELDS;
  assertExactFields(value, fields, "Decision request");
  if (status !== "pending" && status !== "answered") {
    throw new Error("Decision request.status must be pending or answered.");
  }

  const optionsValue = value.options;
  if (!Array.isArray(optionsValue)) throw new Error("Decision request.options must be an array.");
  const options = optionsValue.map(parseOption);
  const optionIds = new Set<string>();
  for (const option of options) {
    if (optionIds.has(option.id)) throw new Error(`Duplicate decision option id: ${option.id}.`);
    optionIds.add(option.id);
  }

  const blocking = value.blocking;
  if (typeof blocking !== "boolean") {
    throw new Error("Decision request.blocking must be a boolean.");
  }
  const base = {
    id: requiredText(value.id, "Decision request.id").trim(),
    taskId: requiredText(value.taskId, "Decision request.taskId").trim(),
    requester: parseActor(value.requester, "Decision request.requester"),
    target: parseActor(value.target, "Decision request.target"),
    question: requiredText(value.question, "Decision request.question"),
    options,
    blocking,
  };
  if (status === "pending") {
    return { ...base, status };
  }
  return {
    ...base,
    status,
    response: validateDecisionResponse(value.response, options),
  };
}

/** Answer once; deny is a response and has no Task interruption semantics. */
export function answerDecisionRequest(
  request: DecisionRequest,
  response: unknown
): AnsweredDecisionRequest {
  const current = validateDecisionRequest(request);
  if (current.status !== "pending") {
    throw new Error(`Decision request already answered: ${current.id}.`);
  }
  return {
    ...current,
    status: "answered",
    response: validateDecisionResponse(response, current.options),
  };
}

/** Escalate the same request from a role target to the canonical user target. */
export function escalateDecisionRequest(request: DecisionRequest): DecisionRequest {
  const current = validateDecisionRequest(request);
  if (current.target.kind !== "role") {
    throw new Error("Only a role-targeted decision request can be escalated.");
  }
  return {
    ...current,
    target: { kind: "user", id: "user" },
  };
}

import {
  answerDecisionRequest,
  validateDecisionRequest,
  validateDecisionResponse,
  type AnsweredDecisionRequest,
  type DecisionRequest,
  type DecisionResponse,
} from "../core/decision-request.js";
import type { TaskActorRef } from "../core/task-model.js";
import {
  decisionResponseTaskInputText,
  taskInputIdForDecisionRequest,
  type TaskInputRecord,
} from "./task-input-store.js";

export type DecisionRequestTaskBinding = {
  workspaceId: string;
  taskPath: string;
  taskId: string;
  sessionId: string;
  role?: string;
};

export type PreparedDecisionResponse = {
  answered: AnsweredDecisionRequest;
  taskInput: TaskInputRecord;
};

const IMMUTABLE_TASK_INPUT_FIELDS = [
  "id",
  "workspaceId",
  "taskPath",
  "taskId",
  "sessionId",
  "role",
  "kind",
  "text",
] as const;

export function assertDecisionResponseTaskInputMatches(
  existing: TaskInputRecord,
  expected: TaskInputRecord
): void {
  for (const field of IMMUTABLE_TASK_INPUT_FIELDS) {
    if (existing[field] !== expected[field]) {
      throw new Error(
        `DecisionRequest TaskInput ${expected.id} conflicts on immutable field ${field}.`
      );
    }
  }
}

export function prepareDecisionResponse(input: {
  request: DecisionRequest;
  responder: TaskActorRef;
  response: DecisionResponse;
  binding: DecisionRequestTaskBinding;
  now: string;
}): PreparedDecisionResponse {
  const request = validateDecisionRequest(input.request);
  const { binding } = input;
  if (request.taskId !== binding.taskId) {
    throw new Error(
      `DecisionRequest Task mismatch: expected ${request.taskId}, got ${binding.taskId}.`
    );
  }
  if (request.requester.id !== binding.sessionId) {
    throw new Error(
      `DecisionRequest Session mismatch: expected ${request.requester.id}, got ${binding.sessionId}.`
    );
  }
  if (!Number.isFinite(Date.parse(input.now))) {
    throw new Error("DecisionRequest response timestamp must be an ISO date.");
  }
  const response = validateDecisionResponse(input.response, request.options);
  const answered = request.status === "pending"
    ? answerDecisionRequest(request, input.responder, response)
    : (() => {
        if (
          request.resolvedBy.kind !== input.responder.kind ||
          request.resolvedBy.id !== input.responder.id ||
          JSON.stringify(request.response) !== JSON.stringify(response)
        ) {
          throw new Error(`Decision request already answered differently: ${request.id}.`);
        }
        return request;
      })();
  const taskInput: TaskInputRecord = {
    id: taskInputIdForDecisionRequest(answered.id),
    workspaceId: binding.workspaceId,
    taskPath: binding.taskPath,
    taskId: binding.taskId,
    sessionId: binding.sessionId,
    ...(binding.role ? { role: binding.role } : {}),
    kind: "decision-response",
    text: decisionResponseTaskInputText(answered),
    status: "pending",
    createdAt: input.now,
    updatedAt: input.now,
  };
  return { answered, taskInput };
}

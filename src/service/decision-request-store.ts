import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  answerDecisionRequest,
  escalateDecisionRequest,
  validateDecisionRequest,
  validateDecisionResponse,
  type DecisionRequest,
  type DecisionResponse,
  type PendingDecisionRequest,
} from "../core/decision-request.js";
import type { TaskActorRef } from "../core/task-model.js";
import {
  backupCorruptMachineFile,
  isNotFoundError,
  warnCorruptMachineState,
  writeJsonAtomic,
} from "../machine-state.js";

export type DecisionRequestRecord = DecisionRequest & {
  workspaceId: string;
  taskPath: string;
  createdAt: string;
  updatedAt: string;
  answeredAt?: string;
};

export type DecisionRequestStoreOptions = {
  writeState?: (filePath: string, value: unknown) => Promise<void>;
};

const PENDING_FIELDS = new Set([
  "id",
  "taskId",
  "requester",
  "target",
  "question",
  "options",
  "status",
  "workspaceId",
  "taskPath",
  "createdAt",
  "updatedAt",
]);

const ANSWERED_FIELDS = new Set([
  ...PENDING_FIELDS,
  "response",
  "resolvedBy",
  "answeredAt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function cloneRecord(record: DecisionRequestRecord): DecisionRequestRecord {
  return structuredClone(record);
}

function parseRecord(value: unknown): DecisionRequestRecord | null {
  if (!isRecord(value)) return null;
  const expected = value.status === "answered" ? ANSWERED_FIELDS : PENDING_FIELDS;
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    return null;
  }
  const workspaceId = requiredText(value.workspaceId);
  const taskPath = requiredText(value.taskPath);
  if (!workspaceId || !taskPath || !validDate(value.createdAt) || !validDate(value.updatedAt)) {
    return null;
  }
  if (value.status === "answered" && !validDate(value.answeredAt)) return null;

  const coreValue = { ...value };
  delete coreValue.workspaceId;
  delete coreValue.taskPath;
  delete coreValue.createdAt;
  delete coreValue.updatedAt;
  delete coreValue.answeredAt;
  try {
    const request = validateDecisionRequest(coreValue);
    return {
      ...request,
      workspaceId,
      taskPath,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      ...(request.status === "answered" ? { answeredAt: value.answeredAt as string } : {}),
    };
  } catch {
    return null;
  }
}

function sameActor(left: TaskActorRef, right: TaskActorRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function sameResponse(left: DecisionResponse, right: DecisionResponse): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function coreRequest(record: DecisionRequestRecord): DecisionRequest {
  const {
    workspaceId: _workspaceId,
    taskPath: _taskPath,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    answeredAt: _answeredAt,
    ...request
  } = record;
  return validateDecisionRequest(request);
}

export class DecisionRequestStore {
  private readonly file: string;
  private readonly writeState: (filePath: string, value: unknown) => Promise<void>;
  private items = new Map<string, DecisionRequestRecord>();
  private loaded = false;
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, options?: DecisionRequestStoreOptions) {
    this.file = path.join(dataDir, "decision-requests.json");
    this.writeState = options?.writeState ?? writeJsonAtomic;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.enqueue(async () => {
      if (this.loaded) return;
      try {
        const raw = await fs.readFile(this.file, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== "items")) {
          await this.quarantineCorrupt();
          this.loaded = true;
          return;
        }
        if (!Array.isArray(parsed.items)) {
          await this.quarantineCorrupt();
          this.loaded = true;
          return;
        }
        const loaded = new Map<string, DecisionRequestRecord>();
        for (const item of parsed.items) {
          const record = parseRecord(item);
          if (!record || loaded.has(record.id)) {
            await this.quarantineCorrupt();
            this.loaded = true;
            return;
          }
          loaded.set(record.id, record);
        }
        this.items = loaded;
        this.loaded = true;
      } catch (error) {
        if (isNotFoundError(error)) {
          this.loaded = true;
          return;
        }
        if (error instanceof SyntaxError) {
          await this.quarantineCorrupt();
          this.loaded = true;
          return;
        }
        throw error;
      }
    });
  }

  async listPending(workspaceId?: string): Promise<DecisionRequestRecord[]> {
    await this.ensureLoaded();
    return [...this.items.values()]
      .filter(
        (item) =>
          item.status === "pending" &&
          (workspaceId === undefined || item.workspaceId === workspaceId)
      )
      .map(cloneRecord);
  }

  async getExact(
    workspaceId: string,
    taskPath: string,
    requestId: string
  ): Promise<DecisionRequestRecord | undefined> {
    await this.ensureLoaded();
    const item = this.items.get(requestId);
    if (!item || item.workspaceId !== workspaceId || item.taskPath !== taskPath) return undefined;
    return cloneRecord(item);
  }

  async getPendingForTask(
    workspaceId: string,
    taskPath: string
  ): Promise<DecisionRequestRecord | undefined> {
    await this.ensureLoaded();
    const item = [...this.items.values()].find(
      (candidate) =>
        candidate.status === "pending" &&
        candidate.workspaceId === workspaceId &&
        candidate.taskPath === taskPath
    );
    return item ? cloneRecord(item) : undefined;
  }

  async add(input: {
    workspaceId: string;
    taskPath: string;
    request: PendingDecisionRequest;
  }): Promise<DecisionRequestRecord> {
    if (this.closed) throw new Error("DecisionRequest store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("DecisionRequest store is closed");
      const request = validateDecisionRequest(input.request);
      if (request.status !== "pending") {
        throw new Error("DecisionRequestStore.add requires a pending request");
      }
      if (this.items.has(request.id)) {
        throw new Error(`Decision request already exists: ${request.id}`);
      }
      for (const item of this.items.values()) {
        if (
          item.status === "pending" &&
          item.workspaceId === input.workspaceId &&
          item.taskPath === input.taskPath
        ) {
          throw new Error(`Task already has a pending decision request: ${item.id}`);
        }
      }
      const now = new Date().toISOString();
      const record: DecisionRequestRecord = {
        ...request,
        workspaceId: input.workspaceId,
        taskPath: input.taskPath,
        createdAt: now,
        updatedAt: now,
      };
      const next = new Map(this.items);
      next.set(record.id, record);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneRecord(record);
    });
  }

  async answerExact(input: {
    workspaceId: string;
    taskPath: string;
    requestId: string;
    responder: TaskActorRef;
    response: DecisionResponse;
  }): Promise<DecisionRequestRecord> {
    if (this.closed) throw new Error("DecisionRequest store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("DecisionRequest store is closed");
      const current = this.items.get(input.requestId);
      if (
        !current ||
        current.workspaceId !== input.workspaceId ||
        current.taskPath !== input.taskPath
      ) {
        throw new Error(`Decision request not found for exact Task: ${input.requestId}`);
      }
      const response = validateDecisionResponse(input.response, current.options);
      if (current.status === "answered") {
        if (sameActor(current.resolvedBy, input.responder) && sameResponse(current.response, response)) {
          return cloneRecord(current);
        }
        throw new Error(`Decision request already answered differently: ${current.id}`);
      }
      const answered = answerDecisionRequest(coreRequest(current), input.responder, response);
      const now = new Date().toISOString();
      const record: DecisionRequestRecord = {
        ...answered,
        workspaceId: current.workspaceId,
        taskPath: current.taskPath,
        createdAt: current.createdAt,
        updatedAt: now,
        answeredAt: now,
      };
      const next = new Map(this.items);
      next.set(record.id, record);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneRecord(record);
    });
  }

  async escalateExact(
    workspaceId: string,
    taskPath: string,
    requestId: string
  ): Promise<DecisionRequestRecord> {
    if (this.closed) throw new Error("DecisionRequest store is closed");
    await this.ensureLoaded();
    return this.enqueue(async () => {
      if (this.closed) throw new Error("DecisionRequest store is closed");
      const current = this.items.get(requestId);
      if (!current || current.workspaceId !== workspaceId || current.taskPath !== taskPath) {
        throw new Error(`Decision request not found for exact Task: ${requestId}`);
      }
      if (current.status === "pending" && current.target.kind === "user") {
        return cloneRecord(current);
      }
      const escalated = escalateDecisionRequest(coreRequest(current));
      const record: DecisionRequestRecord = {
        ...escalated,
        workspaceId: current.workspaceId,
        taskPath: current.taskPath,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      const next = new Map(this.items);
      next.set(record.id, record);
      await this.persistSnapshot(next);
      this.items = next;
      return cloneRecord(record);
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = this.ensureLoaded().then(() => undefined);
    return this.shutdownPromise;
  }

  private async persistSnapshot(snapshot: Map<string, DecisionRequestRecord>): Promise<void> {
    const items = [...snapshot.values()];
    const pending = items.filter((item) => item.status === "pending");
    const answered = items
      .filter((item) => item.status === "answered")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 100);
    await this.writeState(this.file, { items: [...pending, ...answered] });
  }

  private async quarantineCorrupt(): Promise<void> {
    const backupPath = await backupCorruptMachineFile(this.file);
    warnCorruptMachineState(this.file, backupPath, "reset");
    this.items.clear();
  }
}

export function makeDecisionRequestId(rand: () => number = Math.random): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let value = "dr-";
  for (let index = 0; index < 10; index += 1) {
    value += alphabet[Math.floor(rand() * alphabet.length)];
  }
  return value;
}

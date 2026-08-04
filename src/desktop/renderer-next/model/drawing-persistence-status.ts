/**
 * Quota / error / fallback status for Canvas V3 drawing persistence.
 * Chinese-first product copy for local renderer chrome (no i18n framework).
 */

export type DrawingPersistenceDegraded =
  | "none"
  /** Metadata saved; images dropped or unavailable. */
  | "no-images"
  /** Neither metadata nor images persisted. */
  | "unpersisted";

export type DrawingPersistenceStatus =
  | { kind: "ok" }
  | { kind: "pending"; message: string; retryable: false }
  | {
      kind: "quota";
      message: string;
      degraded: DrawingPersistenceDegraded;
      retryable: boolean;
    }
  | {
      kind: "error";
      message: string;
      retryable: boolean;
      code?: string;
    }
  | {
      kind: "unavailable";
      message: string;
      retryable: boolean;
    };

export const DRAWING_PERSISTENCE_MESSAGES = {
  ok: "绘图场景已保存。",
  quotaMetadata:
    "本地存储空间不足，绘图场景未能保存。节点画布仍可使用；可清理空间后重试。",
  quotaImages:
    "本地存储空间不足，图片未保存；图元与标注仍可使用（无图片降级）。",
  quotaBoth:
    "本地存储空间不足，绘图场景与图片均未保存。节点层不受影响。",
  idbUnavailable:
    "图片本地库不可用，已降级为无图片场景。图元仍保存在本地元数据中。",
  idbError: "图片本地存储失败，可重试。节点与图元层不受影响。",
  metadataError: "绘图场景保存失败，可重试。",
  corruptMetadata: "绘图场景数据损坏，已回退为空场景。",
  loadError: "绘图场景恢复失败，已回退为空场景；可重试。",
  storageUnavailable: "本地存储不可用，绘图场景仅在当前会话有效。",
} as const;

export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    if (typeof err === "string") {
      return /quota|exceeded|storage/i.test(err);
    }
    return false;
  }
  const e = err as { name?: string; code?: number | string; message?: string };
  if (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return true;
  }
  // DOMException code 22 historically used for quota
  if (e.code === 22 || e.code === 1014) return true;
  if (typeof e.message === "string" && /quota|exceeded/i.test(e.message)) {
    return true;
  }
  return false;
}

export function classifyStorageError(
  err: unknown,
  surface: "metadata" | "images" | "both" = "metadata"
): DrawingPersistenceStatus {
  if (isQuotaError(err)) {
    if (surface === "images") {
      return {
        kind: "quota",
        message: DRAWING_PERSISTENCE_MESSAGES.quotaImages,
        degraded: "no-images",
        retryable: true,
      };
    }
    if (surface === "both") {
      return {
        kind: "quota",
        message: DRAWING_PERSISTENCE_MESSAGES.quotaBoth,
        degraded: "unpersisted",
        retryable: true,
      };
    }
    return {
      kind: "quota",
      message: DRAWING_PERSISTENCE_MESSAGES.quotaMetadata,
      degraded: "unpersisted",
      retryable: true,
    };
  }
  const message =
    surface === "images"
      ? DRAWING_PERSISTENCE_MESSAGES.idbError
      : DRAWING_PERSISTENCE_MESSAGES.metadataError;
  return {
    kind: "error",
    message,
    retryable: true,
    code: err && typeof err === "object" && "name" in err
      ? String((err as { name: unknown }).name)
      : undefined,
  };
}

/** Merge two statuses; prefer worse outcome for UI banners. */
export function mergePersistenceStatus(
  a: DrawingPersistenceStatus,
  b: DrawingPersistenceStatus
): DrawingPersistenceStatus {
  const rank = (s: DrawingPersistenceStatus): number => {
    if (s.kind === "ok" || s.kind === "pending") return 0;
    if (s.kind === "unavailable") return 1;
    if (s.kind === "error") return 2;
    return 3; // quota
  };
  if (rank(b) > rank(a)) return b;
  if (rank(a) > rank(b)) return a;
  // Equal rank — if both quota, prefer broader degradation.
  if (a.kind === "quota" && b.kind === "quota") {
    const order: DrawingPersistenceDegraded[] = [
      "none",
      "no-images",
      "unpersisted",
    ];
    return order.indexOf(b.degraded) > order.indexOf(a.degraded) ? b : a;
  }
  return a;
}

export function statusAllowsImageRestore(
  status: DrawingPersistenceStatus
): boolean {
  return status.kind === "ok";
}

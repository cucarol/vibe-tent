export const DESKTOP_PROJECTION_METHODS = [
  "graph.projection",
  "node.collaborations",
  "node.collaboration",
  "output.provenance",
] as const;

export type DesktopProjectionMethod =
  (typeof DESKTOP_PROJECTION_METHODS)[number];

const DESKTOP_PROJECTION_METHOD_SET: ReadonlySet<string> = new Set(
  DESKTOP_PROJECTION_METHODS
);

export function isDesktopProjectionMethod(
  value: unknown
): value is DesktopProjectionMethod {
  return (
    typeof value === "string" && DESKTOP_PROJECTION_METHOD_SET.has(value)
  );
}

export async function invokeDesktopProjectionRpc(
  getClient: () => {
    call: (
      method: DesktopProjectionMethod,
      params?: Record<string, unknown>
    ) => Promise<unknown>;
  } | null,
  method: unknown,
  params?: Record<string, unknown>
): Promise<unknown> {
  if (!isDesktopProjectionMethod(method)) {
    throw new Error(`Unsupported desktop projection method: ${String(method)}`);
  }
  const client = getClient();
  if (!client) throw new Error("Service not attached");
  return client.call(method, params);
}

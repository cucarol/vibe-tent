// V0.2: coordination / note→box promote is retired.
// Every valid concept may be claimed; type changes use ordinary docs/ops write paths.

/**
 * @deprecated Promote / coordination gate removed in V0.2 Node/Type migration.
 * Callers should set type via create/update Node APIs instead.
 */
export interface PromoteResult {
  id: string;
  path: string;
  fromType: string;
  toType: string;
}

/**
 * @deprecated Removed: V0.2 has no note/box promotion or coordination capability.
 */
export async function promoteConcept(
  _env: unknown,
  _conceptIdOrPath: string,
  _toType: string
): Promise<PromoteResult> {
  void _env;
  void _conceptIdOrPath;
  void _toType;
  throw new Error(
    "promoteConcept is retired in V0.2: every valid concept may enter the task lifecycle; change type via node update APIs."
  );
}

/** 生成本地唯一 id（仅作本机主键，不作为跨机器身份依据） */
export function newId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 生成跨机器交接用的稳定标识（uuid），一经生成不再改变 */
export function newUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `uuid_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** 下一个组号 */
export function nextSetNo(existing: number[]): number {
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

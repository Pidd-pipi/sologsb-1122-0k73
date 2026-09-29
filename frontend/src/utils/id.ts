let seq = 0;

/** 生成本地唯一 id（时间戳 + 自增序列 + 随机串，避免同一毫秒内连撞） */
export function newId(prefix = 'id'): string {
  seq = (seq + 1) % 0xffffff;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 下一个组号 */
export function nextSetNo(existing: number[]): number {
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 岩性素描结构面线段：类型、localStorage 存储键与指纹。
 *
 * 素描线段不属于 IndexedDB 四表，单独存在 localStorage；
 * 交接编录时与掌子面一起打进编录包，导入后按本地掌子面 id 落回同一存储键。
 */

export interface SketchSegment {
  id: string;
  /** 线中点 x（视图坐标） */
  x: number;
  /** 线中点 y（视图坐标） */
  y: number;
  /** 结构面倾角 ° */
  dipAngle: number;
  /** 结构面倾向 ° */
  dipDirection: number;
  /** 线长（视图坐标） */
  length: number;
  label: string;
}

export const SKETCH_KEY_PREFIX = 'gbtunnelface:sketch:';

/** 素描线段在 localStorage 中的存储键（按本地掌子面 id） */
export function sketchStorageKey(faceId: string): string {
  return `${SKETCH_KEY_PREFIX}${faceId}`;
}

export function loadSketch(faceId: string): SketchSegment[] {
  try {
    const raw = window.localStorage.getItem(sketchStorageKey(faceId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as SketchSegment[]) : [];
  } catch {
    return [];
  }
}

export function saveSketch(faceId: string, segments: SketchSegment[]): void {
  window.localStorage.setItem(sketchStorageKey(faceId), JSON.stringify(segments));
}

/**
 * 线段指纹：同一循环里内容相同（位置/产状/线长）的线段视为同一条，
 * 不依赖线段自身 id，保证重复导入同一编录包不会产生重复线段。
 */
export function segmentFingerprint(seg: SketchSegment): string {
  return [seg.x, seg.y, seg.dipAngle, seg.dipDirection, seg.length].map(Number).join('/');
}

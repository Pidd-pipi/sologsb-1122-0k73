/** 充填物 */
export type FillMaterial = '方解石' | '泥质' | '无';

export const FILL_MATERIALS: FillMaterial[] = ['方解石', '泥质', '无'];

/** 渗水状态 */
export type WaterWet = '干燥' | '潮湿' | '滴水' | '线流';

export const WATER_WETS: WaterWet[] = ['干燥', '潮湿', '滴水', '线流'];

/** 粗糙度 */
export type Roughness = '平直光滑' | '平整' | '粗糙' | '起伏粗糙';

export const ROUGHNESSES: Roughness[] = ['平直光滑', '平整', '粗糙', '起伏粗糙'];

/** 结构面（节理组） */
export interface JointSet {
  id: string;
  /** 稳定标识（跨机器交接用） */
  uuid: string;
  faceId: string;
  /** 组号 */
  setNo: number;
  /** 倾向 ° */
  dipDirection: number;
  /** 倾角 ° */
  dipAngle: number;
  /** 间距 cm */
  spacing: number;
  /** 延伸长度 m */
  persistence: number;
  /** 张开度 mm */
  aperture: number;
  fillMaterial: FillMaterial;
  roughness: Roughness;
  waterWet: WaterWet;
  /** 条数 */
  jointCount: number;
  /** 修订时间（交接冲突时按此取新值） */
  updatedAt: number;
}

export type JointSetDraft = Omit<JointSet, 'id' | 'uuid' | 'updatedAt'>;

/** 倾角是否异常（超出 0~90°） */
export function isDipAbnormal(dipAngle: number): boolean {
  return !Number.isFinite(dipAngle) || dipAngle < 0 || dipAngle > 90;
}

/** 该组是否属于"陡倾"结构面 */
export function isSteep(dipAngle: number): boolean {
  return dipAngle >= 60;
}

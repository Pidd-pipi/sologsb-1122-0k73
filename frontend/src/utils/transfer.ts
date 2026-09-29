/**
 * 编录交接：编录包格式、按业务身份的合并算法。
 *
 * 本文件为纯逻辑，不接触 IndexedDB / localStorage / DOM，I/O 编排在 catalog.ts。
 *
 * 合并原则
 * - 身份不使用本机自增 id（那只是主键），而是各记录的业务键：
 *   掌子面 = 编号 + 里程区间；节理 = 掌子面身份 + 组号；
 *   级别 = 掌子面身份 + 判定时间 + BQ/[BQ]；涌水 = 掌子面身份 + 测量时间 + 部位 + 流量/类型。
 * - 四类记录逐表独立按 revisedAt（修订时间）取新值：新掌子面不会覆盖本地更新的级别/涌水。
 * - 旧版 v2 数据没有修订时间，先补基线再判冲突：
 *   掌子面基线 = recordedAt，级别 = judgedAt，涌水 = measuredAt，节理 = 0。
 * - 同一条记录重复导入结果不变（幂等），不产生副本。
 */
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { RockMassGrade } from '../types/grade';
import type { WaterInflow } from '../types/water';
import type { SketchSegment } from './sketch';

export const CATALOG_PACKAGE_TYPE = 'gbtunnelface-catalog';
export const CATALOG_PACKAGE_FORMAT = 1;

/** 编录包：与 IndexedDB 的四张表平级，素描线段按掌子面（包内 id）分组 */
export interface CatalogPackage {
  packageType: typeof CATALOG_PACKAGE_TYPE;
  format: number;
  exportedAt: number;
  faces: TunnelFace[];
  joints: JointSet[];
  grades: RockMassGrade[];
  waters: WaterInflow[];
  /** 每项对应一个掌子面的素描线段，faceId 为包内掌子面 id */
  sketches: { faceId: string; segments: SketchSegment[] }[];
}

export interface LocalSnapshot {
  faces: TunnelFace[];
  joints: JointSet[];
  grades: RockMassGrade[];
  waters: WaterInflow[];
  /** 按本地掌子面 id 取出的素描 */
  sketches: { faceId: string; segments: SketchSegment[] }[];
}

export interface MergeReport {
  faces: { added: number; updated: number; unchanged: number };
  joints: { added: number; updated: number; unchanged: number };
  grades: { added: number; updated: number; unchanged: number };
  waters: { added: number; updated: number; unchanged: number };
  sketches: { faces: number; segmentsAdded: number; unchanged: number };
}

export interface MergeResult {
  faces: TunnelFace[];
  joints: JointSet[];
  grades: RockMassGrade[];
  waters: WaterInflow[];
  /** 合并后的全量素描，按最终本地掌子面 id 键控（不在包内的本地素描原样保留） */
  sketches: { faceId: string; segments: SketchSegment[] }[];
  report: MergeReport;
}

/* ------------------------------ 业务身份键 ------------------------------ */

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : NaN;
}

/** 掌子面业务身份：编号（trim）+ 编录里程区间。本机 id 不参与。 */
export function faceKey(faceNo: string, mileageRange: readonly [number, number] | number[]): string {
  const start = num(mileageRange?.[0]);
  const end = num(mileageRange?.[1]);
  return `${String(faceNo ?? '').trim()}|${start}|${end}`;
}

/** 节理组业务身份：所属掌子面身份 + 组号 */
export function jointKey(ownerFaceKey: string, setNo: number): string {
  return `${ownerFaceKey}#J${num(setNo)}`;
}

/** 级别判定业务身份：所属掌子面身份 + 判定时间（同一时刻同循环只有一条判定，内容按修订时间取胜） */
export function gradeKey(ownerFaceKey: string, judgedAt: number): string {
  return `${ownerFaceKey}#G${num(judgedAt)}`;
}

/** 涌水记录业务身份：所属掌子面身份 + 测量时间 + 部位 + 流量 + 出水类型 */
export function waterKey(
  ownerFaceKey: string,
  measuredAt: number,
  position: string,
  estimatedFlow: number,
  type: string,
): string {
  return `${ownerFaceKey}#W${num(measuredAt)}|${String(position ?? '').trim()}|${num(estimatedFlow)}|${type ?? ''}`;
}

/* ----------------------------- 修订时间基线 ----------------------------- */

/** 旧版 v2 数据没有修订时间，先补齐基线再判断冲突 */
export function faceRevisedAt(face: TunnelFace): number {
  const r = num(face.revisedAt);
  if (r > 0) return r;
  const t = num(face.recordedAt);
  return t > 0 ? t : 0;
}

export function gradeRevisedAt(grade: RockMassGrade): number {
  const r = num(grade.revisedAt);
  if (r > 0) return r;
  const t = num(grade.judgedAt);
  return t > 0 ? t : 0;
}

export function waterRevisedAt(water: WaterInflow): number {
  const r = num(water.revisedAt);
  if (r > 0) return r;
  const t = num(water.measuredAt);
  return t > 0 ? t : 0;
}

/** 节理没有独立的录入/测量时间，v2 基线为 0：带修订时间的一侧必然更新 */
export function jointRevisedAt(joint: JointSet): number {
  const r = num(joint.revisedAt);
  return r > 0 ? r : 0;
}

/* ------------------------------ 包解析校验 ------------------------------ */

function fail(message: string): never {
  throw new Error(message);
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${name}必须是对象`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) fail(`${name}必须是数组`);
  return value;
}

function requireFinite(value: unknown, name: string): number {
  const n = num(value);
  if (!Number.isFinite(n)) fail(`${name}必须是数字`);
  return n;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${name}必须是非空字符串`);
  return value;
}

function requireBool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') fail(`${name}必须是布尔值`);
  return value;
}

function requireId(value: unknown, name: string): string {
  return requireString(value, name);
}

/**
 * 解析并校验编录包 JSON。任何结构问题都抛错，调用方据此保留原库。
 * 校验通过后返回归一化（编号/部位 trim、里程区间兜底）的包。
 */
export function parseCatalogPackage(raw: string): CatalogPackage {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    fail('编录包不是合法的 JSON 文件');
  }
  return validatePackage(data);
}

export function validatePackage(data: unknown): CatalogPackage {
  const root = requireObject(data, '编录包');
  if (root.packageType !== CATALOG_PACKAGE_TYPE) fail('不是有效的编录包（packageType 不符）');
  if (num(root.format) !== CATALOG_PACKAGE_FORMAT) {
    fail(`不支持的编录包格式版本：${String(root.format)}`);
  }
  if (!Number.isFinite(num(root.exportedAt))) fail('编录包导出时间缺失');

  const faces = requireArray(root.faces, 'faces').map((item, i) => normalizeFace(requireObject(item, `第 ${i + 1} 个掌子面`), i));
  const faceIdSet = new Set<string>();
  const businessKeySet = new Set<string>();
  for (const face of faces) {
    if (faceIdSet.has(face.id)) fail(`包内掌子面 id 重复：${face.id}`);
    faceIdSet.add(face.id);
    const key = faceKey(face.faceNo, face.mileageRange);
    if (businessKeySet.has(key)) fail(`包内掌子面「${face.faceNo}」存在重复的编号+里程区间`);
    businessKeySet.add(key);
  }

  const joints = requireArray(root.joints, 'joints').map((item, i) => normalizeJoint(requireObject(item, `第 ${i + 1} 条节理`), i));
  const grades = requireArray(root.grades, 'grades').map((item, i) => normalizeGrade(requireObject(item, `第 ${i + 1} 条级别判定`), i));
  const waters = requireArray(root.waters, 'waters').map((item, i) => normalizeWater(requireObject(item, `第 ${i + 1} 条涌水记录`), i));

  for (const child of joints) if (!faceIdSet.has(child.faceId)) fail(`节理 J${child.setNo} 引用了包内不存在的掌子面`);
  for (const child of grades) if (!faceIdSet.has(child.faceId)) fail(`一条级别判定引用了包内不存在的掌子面`);
  for (const child of waters) if (!faceIdSet.has(child.faceId)) fail(`涌水记录「${child.position}」引用了包内不存在的掌子面`);

  const sketches: CatalogPackage['sketches'] = [];
  const sketchRaw = root.sketches === undefined ? [] : root.sketches;
  for (const item of requireArray(sketchRaw, 'sketches')) {
    const entry = requireObject(item, '素描分组');
    const ownerId = requireId(entry.faceId, '素描分组的 faceId');
    if (!faceIdSet.has(ownerId)) fail(`一份素描引用了包内不存在的掌子面`);
    const segments = requireArray(entry.segments, '素描线段').map((seg, i) =>
      normalizeSegment(requireObject(seg, `第 ${i + 1} 条素描线段`), i),
    );
    sketches.push({ faceId: ownerId, segments });
  }

  return {
    packageType: CATALOG_PACKAGE_TYPE,
    format: CATALOG_PACKAGE_FORMAT,
    exportedAt: num(root.exportedAt),
    faces,
    joints,
    grades,
    waters,
    sketches,
  };
}

function normalizeFace(o: Record<string, unknown>, i: number): TunnelFace {
  const where = `第 ${i + 1} 个掌子面`;
  const rawRange = o.mileageRange;
  if (!Array.isArray(rawRange) || rawRange.length < 2) fail(`${where}缺少里程区间`);
  const mileageStart = requireFinite(rawRange[0], `${where}里程区间起点`);
  const mileageEnd = requireFinite(rawRange[1], `${where}里程区间终点`);
  if (mileageEnd < mileageStart) fail(`${where}里程区间终点不能小于起点`);
  const rawAttitude = requireObject(o.attitude ?? {}, `${where}岩层产状`);
  return {
    id: requireId(o.id, `${where}id`),
    faceNo: requireString(o.faceNo, `${where}编号`).trim(),
    chainage: requireFinite(o.chainage, `${where}里程桩号`),
    mileageRange: [mileageStart, mileageEnd],
    excavationMethod: requireString(o.excavationMethod, `${where}开挖方式`) as TunnelFace['excavationMethod'],
    faceSize: requireString(o.faceSize, `${where}断面尺寸`),
    lithology: requireString(o.lithology, `${where}岩性`),
    weathering: requireString(o.weathering, `${where}风化程度`) as TunnelFace['weathering'],
    rockStrength: requireFinite(o.rockStrength, `${where}饱和抗压强度`),
    attitude: {
      strike: requireFinite(rawAttitude.strike, `${where}走向`),
      dipDirection: requireFinite(rawAttitude.dipDirection, `${where}倾向`),
      dipAngle: requireFinite(rawAttitude.dipAngle, `${where}倾角`),
    },
    recordedAt: requireFinite(o.recordedAt, `${where}编录时间`),
    geologist: typeof o.geologist === 'string' ? o.geologist : '',
    ...(num(o.revisedAt) > 0 ? { revisedAt: num(o.revisedAt) } : {}),
  };
}

function normalizeJoint(o: Record<string, unknown>, i: number): JointSet {
  const where = `第 ${i + 1} 条节理`;
  return {
    id: requireId(o.id, `${where}id`),
    faceId: requireId(o.faceId, `${where}faceId`),
    setNo: requireFinite(o.setNo, `${where}组号`),
    dipDirection: requireFinite(o.dipDirection, `${where}倾向`),
    dipAngle: requireFinite(o.dipAngle, `${where}倾角`),
    spacing: requireFinite(o.spacing, `${where}间距`),
    persistence: requireFinite(o.persistence, `${where}延伸长度`),
    aperture: requireFinite(o.aperture, `${where}张开度`),
    fillMaterial: requireString(o.fillMaterial, `${where}充填物`) as JointSet['fillMaterial'],
    roughness: requireString(o.roughness, `${where}粗糙度`) as JointSet['roughness'],
    waterWet: requireString(o.waterWet, `${where}渗水状态`) as JointSet['waterWet'],
    jointCount: requireFinite(o.jointCount, `${where}条数`),
    ...(num(o.revisedAt) > 0 ? { revisedAt: num(o.revisedAt) } : {}),
  };
}

function normalizeGrade(o: Record<string, unknown>, i: number): RockMassGrade {
  const where = `第 ${i + 1} 条级别判定`;
  return {
    id: requireId(o.id, `${where}id`),
    faceId: requireId(o.faceId, `${where}faceId`),
    grade: requireString(o.grade, `${where}级别`) as RockMassGrade['grade'],
    bqValue: requireFinite(o.bqValue, `${where}BQ`),
    rqd: requireFinite(o.rqd, `${where}RQD`),
    jv: requireFinite(o.jv, `${where}Jv`),
    kv: requireFinite(o.kv, `${where}Kv`),
    groundwater: requireString(o.groundwater, `${where}出水状态`) as RockMassGrade['groundwater'],
    spanWidth: requireFinite(o.spanWidth, `${where}洞跨`),
    correction: requireFinite(o.correction, `${where}修正系数`),
    correctedBq: requireFinite(o.correctedBq, `${where}[BQ]`),
    supportSuggestion: typeof o.supportSuggestion === 'string' ? o.supportSuggestion : '',
    manualAdjusted: requireBool(o.manualAdjusted, `${where}人工修正标记`),
    judgedAt: requireFinite(o.judgedAt, `${where}判定时间`),
    ...(num(o.revisedAt) > 0 ? { revisedAt: num(o.revisedAt) } : {}),
  };
}

function normalizeWater(o: Record<string, unknown>, i: number): WaterInflow {
  const where = `第 ${i + 1} 条涌水记录`;
  return {
    id: requireId(o.id, `${where}id`),
    faceId: requireId(o.faceId, `${where}faceId`),
    position: requireString(o.position, `${where}出水部位`).trim(),
    type: requireString(o.type, `${where}出水类型`) as WaterInflow['type'],
    estimatedFlow: requireFinite(o.estimatedFlow, `${where}涌水量`),
    waterTemp: requireFinite(o.waterTemp, `${where}水温`),
    waterPressure: requireFinite(o.waterPressure, `${where}水压`),
    changeTrend: requireString(o.changeTrend, `${where}变化趋势`) as WaterInflow['changeTrend'],
    measuredAt: requireFinite(o.measuredAt, `${where}测量时间`),
    chainage: requireFinite(o.chainage, `${where}里程`),
    ...(num(o.revisedAt) > 0 ? { revisedAt: num(o.revisedAt) } : {}),
  };
}

function normalizeSegment(o: Record<string, unknown>, i: number): SketchSegment {
  const where = `第 ${i + 1} 条素描线段`;
  return {
    id: requireId(o.id, `${where}id`),
    x: requireFinite(o.x, `${where}x`),
    y: requireFinite(o.y, `${where}y`),
    dipAngle: requireFinite(o.dipAngle, `${where}倾角`),
    dipDirection: requireFinite(o.dipDirection, `${where}倾向`),
    length: requireFinite(o.length, `${where}线长`),
    label: typeof o.label === 'string' ? o.label : '',
  };
}

/* -------------------------------- 合并 -------------------------------- */

interface ChildRow {
  id: string;
  faceId: string;
  revisedAt?: number;
}

interface ChildMergeAccum<T extends ChildRow> {
  rows: Map<string, T>;
  added: number;
  updated: number;
  unchanged: number;
}

/**
 * 子表（节理/级别/涌水）合并：
 * 业务键自带掌子面身份，因此这一步与掌子面表完全独立——
 * 即使掌子面记录取了包内的新值，本地更新过的级别/涌水也不会被覆盖。
 */
function mergeChildren<T extends ChildRow>(
  local: T[],
  incoming: T[],
  localOwnerKeyById: Map<string, string>,
  finalFaceIdByKey: Map<string, string>,
  incomingFaceIndex: Map<string, string>,
  businessKeyOf: (row: T, ownerKey: string) => string,
  revisedAtOf: (row: T) => number,
  newId: () => string,
  allowUpdate: boolean,
): ChildMergeAccum<T> {
  const acc: ChildMergeAccum<T> = { rows: new Map(), added: 0, updated: 0, unchanged: 0 };

  for (const row of local) {
    const ownerKey = localOwnerKeyById.get(row.faceId);
    if (!ownerKey) continue; // 孤儿子记录（掌子面已不存在），不进合并结果
    acc.rows.set(businessKeyOf(row, ownerKey), row);
  }

  for (const incomingRow of incoming) {
    const ownerKey = incomingFaceIndex.get(incomingRow.faceId);
    if (!ownerKey) continue; // 全包导出下不会发生，防御性跳过
    const key = businessKeyOf(incomingRow, ownerKey);
    const existing = acc.rows.get(key);
    if (!existing) {
      // 新增：本机 id 只是主键，统一重发，不拿包内 id 当身份
      acc.rows.set(key, { ...incomingRow, id: newId(), faceId: finalFaceIdByKey.get(ownerKey)! });
      acc.added += 1;
      continue;
    }
    const incomingRevised = revisedAtOf(incomingRow);
    const existingRevised = revisedAtOf(existing);
    if (allowUpdate && incomingRevised > existingRevised) {
      // 业务键相同且包内更新：保留本地主键（外键/素描键不漂移），字段取新值
      acc.rows.set(key, { ...incomingRow, id: existing.id, faceId: existing.faceId });
      acc.updated += 1;
    } else {
      // 本地更新或平局（如同基线 v2 数据）：保留本地值
      acc.unchanged += 1;
    }
  }

  return acc;
}

/**
 * 计算本地快照与编录包的合并结果。纯函数：不写任何存储。
 * newId 由调用方注入，便于测试中使用确定性 id。
 */
export function computeMerge(local: LocalSnapshot, pkg: CatalogPackage, newId: () => string): MergeResult {
  // 掌子面：业务键 -> 本地行 / 包内行
  const localByKey = new Map<string, TunnelFace>();
  for (const face of local.faces) localByKey.set(faceKey(face.faceNo, face.mileageRange), face);
  const incomingByKey = new Map<string, TunnelFace>();
  for (const face of pkg.faces) incomingByKey.set(faceKey(face.faceNo, face.mileageRange), face);

  // 包内掌子面 id -> 业务键（解析子记录的包内 faceId 用）
  const incomingFaceIndex = new Map<string, string>();
  for (const face of pkg.faces) incomingFaceIndex.set(face.id, faceKey(face.faceNo, face.mileageRange));

  const report: MergeReport = {
    faces: { added: 0, updated: 0, unchanged: 0 },
    joints: { added: 0, updated: 0, unchanged: 0 },
    grades: { added: 0, updated: 0, unchanged: 0 },
    waters: { added: 0, updated: 0, unchanged: 0 },
    sketches: { faces: 0, segmentsAdded: 0, unchanged: 0 },
  };

  const mergedFaces: TunnelFace[] = [];
  /** 业务键 -> 合并后本地掌子面 id（子记录重定向用） */
  const localFaceIndex = new Map<string, string>();
  /** 合并前本地掌子面 id -> 业务键（解析本地子记录归属用） */
  const localOwnerKeyById = new Map<string, string>();
  for (const face of local.faces) {
    localOwnerKeyById.set(face.id, faceKey(face.faceNo, face.mileageRange));
  }

  const allFaceKeys = new Set<string>([...localByKey.keys(), ...incomingByKey.keys()]);
  for (const key of allFaceKeys) {
    const localFace = localByKey.get(key);
    const incomingFace = incomingByKey.get(key);
    if (localFace && incomingFace) {
      if (faceRevisedAt(incomingFace) > faceRevisedAt(localFace)) {
        mergedFaces.push({ ...incomingFace, id: localFace.id });
        report.faces.updated += 1;
      } else {
        mergedFaces.push(localFace);
        report.faces.unchanged += 1;
      }
      localFaceIndex.set(key, localFace.id);
    } else if (incomingFace) {
      const created = { ...incomingFace, id: newId() };
      mergedFaces.push(created);
      localFaceIndex.set(key, created.id);
      report.faces.added += 1;
    } else if (localFace) {
      mergedFaces.push(localFace);
      localFaceIndex.set(key, localFace.id);
    }
  }

  // 子表独立合并（关键：不随掌子面记录整体替换，级别/涌水各按自身修订时间取胜）
  const jointAcc = mergeChildren(
    local.joints,
    pkg.joints,
    localOwnerKeyById,
    localFaceIndex,
    incomingFaceIndex,
    (row, ownerKey) => jointKey(ownerKey, row.setNo),
    jointRevisedAt,
    newId,
    true,
  );
  const gradeAcc = mergeChildren(
    local.grades,
    pkg.grades,
    localOwnerKeyById,
    localFaceIndex,
    incomingFaceIndex,
    (row, ownerKey) => gradeKey(ownerKey, row.judgedAt),
    gradeRevisedAt,
    newId,
    true, // 级别：同一判定时间是同一条记录，两边都改过按修订时间取新值
  );
  const waterAcc = mergeChildren(
    local.waters,
    pkg.waters,
    localOwnerKeyById,
    localFaceIndex,
    incomingFaceIndex,
    (row, ownerKey) => waterKey(ownerKey, row.measuredAt, row.position, row.estimatedFlow, row.type),
    waterRevisedAt,
    newId,
    true,
  );
  report.joints = { added: jointAcc.added, updated: jointAcc.updated, unchanged: jointAcc.unchanged };
  report.grades = { added: gradeAcc.added, updated: gradeAcc.updated, unchanged: gradeAcc.unchanged };
  report.waters = { added: waterAcc.added, updated: waterAcc.updated, unchanged: waterAcc.unchanged };

  // 素描线段：按最终本地掌子面 id 归位，按指纹去重并集（重复导入不产生副本）
  const sketchMap = new Map<string, SketchSegment[]>();
  for (const entry of local.sketches) sketchMap.set(entry.faceId, [...entry.segments]);
  for (const incoming of pkg.sketches) {
    const ownerKey = incomingFaceIndex.get(incoming.faceId);
    if (ownerKey === undefined) continue;
    const localFaceId = localFaceIndex.get(ownerKey);
    if (localFaceId === undefined) continue;
    const existing = sketchMap.get(localFaceId) ?? [];
    const seen = new Set(existing.map((s) => fingerprintOf(s)));
    let added = 0;
    const merged = [...existing];
    for (const seg of incoming.segments) {
      const fp = fingerprintOf(seg);
      if (seen.has(fp)) continue;
      seen.add(fp);
      merged.push({ ...seg, id: newId() });
      added += 1;
    }
    sketchMap.set(localFaceId, merged);
    if (added > 0) {
      report.sketches.faces += 1;
      report.sketches.segmentsAdded += added;
    } else {
      report.sketches.unchanged += 1;
    }
  }

  return {
    faces: mergedFaces,
    joints: [...jointAcc.rows.values()],
    grades: [...gradeAcc.rows.values()],
    waters: [...waterAcc.rows.values()],
    sketches: [...sketchMap.entries()].map(([faceId, segments]) => ({ faceId, segments })),
    report,
  };
}

/** 素描线段指纹（与 utils/sketch 的指纹口径一致，这里内联以保持纯逻辑无 DOM 依赖） */
function fingerprintOf(seg: SketchSegment): string {
  return [seg.x, seg.y, seg.dipAngle, seg.dipDirection, seg.length].map(Number).join('/');
}

/** 给页面/提示用的合并摘要文本 */
export function formatMergeReport(report: MergeReport): string {
  const parts = [
    `掌子面新增 ${report.faces.added}、更新 ${report.faces.updated}`,
    `节理新增 ${report.joints.added}、更新 ${report.joints.updated}`,
    `级别判定新增 ${report.grades.added}、更新 ${report.grades.updated}`,
    `涌水新增 ${report.waters.added}、更新 ${report.waters.updated}`,
  ];
  if (report.sketches.segmentsAdded > 0) parts.push(`素描线段新增 ${report.sketches.segmentsAdded}`);
  return parts.join('；');
}

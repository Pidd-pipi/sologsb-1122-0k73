import { db, DB_VERSION, toPlain } from './db';
import { newId } from './id';
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { RockMassGrade } from '../types/grade';
import type { WaterInflow } from '../types/water';

export const PACKAGE_FORMAT = 'gbtunnelface-package';
export const PACKAGE_VERSION = 1;

/** 素描线段（按掌子面存于 localStorage） */
export interface SketchSegmentDTO {
  id: string;
  x: number;
  y: number;
  dipAngle: number;
  dipDirection: number;
  length: number;
  label: string;
}

/** 编录包：包内同时带掌子面、节理、涌水、级别判定与素描线段 */
export interface CatalogPackage {
  format: typeof PACKAGE_FORMAT;
  version: number;
  exportedAt: number;
  appVersion: number;
  faces: PackageFace[];
  joints: PackageJoint[];
  grades: PackageGrade[];
  waters: PackageWater[];
  sketches: Record<string, SketchSegmentDTO[]>;
}

export interface PackageFace extends Omit<TunnelFace, 'id'> {
  /** 掌子面业务键：编号 + 里程区间（跨机器身份依据，非本机 ID） */
  faceKey: string;
}
export interface PackageJoint extends Omit<JointSet, 'id' | 'faceId'> {
  faceKey: string;
}
export interface PackageGrade extends Omit<RockMassGrade, 'id' | 'faceId'> {
  faceKey: string;
}
export interface PackageWater extends Omit<WaterInflow, 'id' | 'faceId'> {
  faceKey: string;
}

export interface ImportStats {
  facesAdded: number;
  facesUpdated: number;
  facesUnchanged: number;
  jointsAdded: number;
  jointsUpdated: number;
  gradesAdded: number;
  gradesUpdated: number;
  watersAdded: number;
  watersUpdated: number;
  sketchesAdded: number;
  skippedOrphans: number;
}

function emptyStats(): ImportStats {
  return {
    facesAdded: 0,
    facesUpdated: 0,
    facesUnchanged: 0,
    jointsAdded: 0,
    jointsUpdated: 0,
    gradesAdded: 0,
    gradesUpdated: 0,
    watersAdded: 0,
    watersUpdated: 0,
    sketchesAdded: 0,
    skippedOrphans: 0,
  };
}

/**
 * 掌子面业务键：按掌子面编号 + 里程区间识别同一循环。
 * 不使用本机 ID —— 同一循环在不同机器上 ID 不同。
 */
export function faceKeyOf(face: { faceNo: string; mileageRange: [number, number] }): string {
  return JSON.stringify([face.faceNo, face.mileageRange[0], face.mileageRange[1]]);
}

/* ------------------------------ 素描线段存取 ------------------------------ */

const SKETCH_PREFIX = 'gbtunnelface:sketch:';

/** 取本地存储（浏览器为 window.localStorage；非浏览器环境回退 globalThis.localStorage） */
function getStorage(): Storage | null {
  try {
    const w = (globalThis as { window?: { localStorage?: Storage } }).window;
    if (w && w.localStorage) return w.localStorage;
    const g = globalThis as { localStorage?: Storage };
    if (g.localStorage) return g.localStorage;
  } catch {
    /* 存储不可用时忽略 */
  }
  return null;
}

function sketchStorageKey(faceId: string): string {
  return `${SKETCH_PREFIX}${faceId}`;
}

function loadSketch(faceId: string): SketchSegmentDTO[] {
  try {
    const storage = getStorage();
    const raw = storage?.getItem(sketchStorageKey(faceId));
    return raw ? (JSON.parse(raw) as SketchSegmentDTO[]) : [];
  } catch {
    return [];
  }
}

function saveSketch(faceId: string, segments: SketchSegmentDTO[]): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(sketchStorageKey(faceId), JSON.stringify(segments));
}

/* --------------------------------- 导出 --------------------------------- */

/** 导出当前整本编录为可交接的编录包（JSON 对象） */
export async function exportPackage(): Promise<CatalogPackage> {
  const [faces, joints, grades, waters] = await Promise.all([
    db.faces.toArray(),
    db.joints.toArray(),
    db.grades.toArray(),
    db.waters.toArray(),
  ]);

  const faceIdToKey = new Map<string, string>();
  for (const f of faces) faceIdToKey.set(f.id, faceKeyOf(f));

  const sketches: Record<string, SketchSegmentDTO[]> = {};
  for (const f of faces) {
    const segs = loadSketch(f.id);
    if (segs.length > 0) sketches[faceKeyOf(f)] = segs;
  }

  return {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    exportedAt: Date.now(),
    appVersion: DB_VERSION,
    faces: faces.map((f) => {
      const { id: _id, ...rest } = toPlain(f);
      return { ...rest, faceKey: faceKeyOf(f) };
    }),
    joints: joints
      .filter((j) => faceIdToKey.has(j.faceId))
      .map((j) => {
        const { id: _id, faceId: _fid, ...rest } = toPlain(j);
        return { ...rest, faceKey: faceIdToKey.get(j.faceId)! };
      }),
    grades: grades
      .filter((g) => faceIdToKey.has(g.faceId))
      .map((g) => {
        const { id: _id, faceId: _fid, ...rest } = toPlain(g);
        return { ...rest, faceKey: faceIdToKey.get(g.faceId)! };
      }),
    waters: waters
      .filter((w) => faceIdToKey.has(w.faceId))
      .map((w) => {
        const { id: _id, faceId: _fid, ...rest } = toPlain(w);
        return { ...rest, faceKey: faceIdToKey.get(w.faceId)! };
      }),
    sketches,
  };
}

/** 把编录包下载为 JSON 文件 */
export function downloadPackage(pkg: CatalogPackage): void {
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const t = new Date(pkg.exportedAt || Date.now());
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}`;
  a.href = url;
  a.download = `gbtunnelface-package-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* --------------------------------- 导入 --------------------------------- */

function validatePackage(pkg: unknown): asserts pkg is CatalogPackage {
  if (!pkg || typeof pkg !== 'object') throw new Error('无效的编录包：文件不是合法的 JSON 对象');
  const p = pkg as Record<string, unknown>;
  if (p.format !== PACKAGE_FORMAT) throw new Error('无效的编录包：format 不是本系统的编录包');
  if (typeof p.version !== 'number' || p.version > PACKAGE_VERSION)
    throw new Error('编录包版本不受支持，请升级到最新版后再导入');
  if (!Array.isArray(p.faces)) throw new Error('无效的编录包：缺少掌子面数据');
  for (const f of p.faces as unknown[]) {
    if (!f || typeof f !== 'object') throw new Error('无效的编录包：掌子面记录格式不正确');
    const ff = f as Record<string, unknown>;
    if (typeof ff.faceNo !== 'string' || ff.faceNo.trim() === '')
      throw new Error('编录包中存在缺少掌子面编号的记录');
    if (!Array.isArray(ff.mileageRange) || ff.mileageRange.length !== 2)
      throw new Error('编录包中存在缺少里程区间的掌子面');
  }
  for (const key of ['joints', 'grades', 'waters'] as const) {
    if (p[key] !== undefined && !Array.isArray(p[key]))
      throw new Error(`无效的编录包：${key} 字段不是数组`);
  }
  if (p.sketches !== undefined && (typeof p.sketches !== 'object' || p.sketches === null))
    throw new Error('无效的编录包：素描线段格式不正确');
}

interface ChildRecord {
  id: string;
  uuid: string;
  faceId: string;
  updatedAt: number;
}

/**
 * 合并一类子记录（节理 / 级别判定 / 涌水）。
 * 匹配规则由 matchLocal 给出（uuid 优先，业务键兜底）；
 * 冲突时按修订时间 updatedAt 取新值，较新的掌子面不会覆盖较新的子记录。
 */
async function mergeChildren<T extends ChildRecord>(args: {
  table: { put: (row: T) => Promise<unknown> };
  makeId: () => string;
  localList: T[];
  importedList: Array<Omit<T, 'id' | 'faceId'> & { faceKey: string }>;
  resolveFaceId: (faceKey: string) => string | null;
  matchLocal: (
    list: T[],
    imp: Omit<T, 'id' | 'faceId'> & { faceKey: string },
    faceId: string,
  ) => T | undefined;
}): Promise<{ added: number; updated: number; skipped: number }> {
  const result = { added: 0, updated: 0, skipped: 0 };
  for (const imp of args.importedList) {
    const faceId = args.resolveFaceId(imp.faceKey);
    if (!faceId) {
      result.skipped++;
      continue;
    }
    const local = args.matchLocal(args.localList, imp, faceId);
    // 冲突时按修订时间取新值；缺失修订时间（旧版 v2 数据）按基线 0 参与比较
    if (!local) {
      const { faceKey: _fk, ...rest } = imp;
      const record = { ...toPlain(rest), id: args.makeId(), faceId } as unknown as T;
      await args.table.put(record);
      result.added++;
    } else if ((imp.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
      const { faceKey: _fk, ...rest } = imp;
      const record = { ...toPlain(rest), id: local.id, faceId: local.faceId } as unknown as T;
      await args.table.put(record);
      result.updated++;
    }
  }
  return result;
}

/**
 * 导入编录包并合并到本地库。
 * - 整包在一个事务内合并：任何一步失败都回滚，保留原库；
 * - 掌子面按 编号+里程区间 识别同一循环，子记录按 uuid / 业务键去重，重复导入不产生副本；
 * - 冲突时按各记录修订时间取新值；旧版 v2 数据无修订时间，迁移时已补齐基线。
 */
export async function importPackage(pkg: CatalogPackage): Promise<ImportStats> {
  validatePackage(pkg);
  const stats = emptyStats();

  await db.transaction('rw', db.faces, db.joints, db.grades, db.waters, async () => {
    const [localFaces, localJoints, localGrades, localWaters] = await Promise.all([
      db.faces.toArray(),
      db.joints.toArray(),
      db.grades.toArray(),
      db.waters.toArray(),
    ]);

    // 掌子面：按 编号 + 里程区间 识别同一循环（不使用本机 ID）
    const localFaceByKey = new Map<string, TunnelFace>();
    for (const f of localFaces) localFaceByKey.set(faceKeyOf(f), f);

    const faceKeyToLocalId = new Map<string, string>();

    for (const imp of pkg.faces) {
      const key = imp.faceKey || faceKeyOf(imp);
      const local = localFaceByKey.get(key);
      if (!local) {
        const id = newId('face');
        const { faceKey: _fk, ...rest } = imp;
        const record = { ...toPlain(rest), id } as unknown as TunnelFace;
        await db.faces.put(record);
        localFaceByKey.set(key, record);
        faceKeyToLocalId.set(key, id);
        stats.facesAdded++;
      } else {
        faceKeyToLocalId.set(key, local.id);
        // 掌子面按修订时间取新值；缺失修订时间（旧版 v2 数据）按基线 0 参与比较。
        // 掌子面的合并只影响自身字段，不会覆盖其下较新的级别 / 涌水记录。
        if ((imp.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
          const { faceKey: _fk, ...rest } = imp;
          const record = { ...toPlain(rest), id: local.id } as unknown as TunnelFace;
          await db.faces.put(record);
          stats.facesUpdated++;
        } else {
          stats.facesUnchanged++;
        }
      }
    }

    const resolveFaceId = (faceKey: string): string | null => {
      const mapped = faceKeyToLocalId.get(faceKey);
      if (mapped) return mapped;
      const f = localFaceByKey.get(faceKey);
      return f ? f.id : null;
    };

    // 节理组：uuid 优先，其次按 (掌子面, 组号 setNo) 识别同一组
    const jointResult = await mergeChildren<JointSet>({
      table: db.joints,
      makeId: () => newId('joint'),
      localList: localJoints,
      importedList: pkg.joints ?? [],
      resolveFaceId,
      matchLocal: (list, imp, faceId) =>
        list.find((j) => j.faceId === faceId && (j.uuid === imp.uuid || j.setNo === imp.setNo)),
    });
    stats.jointsAdded = jointResult.added;
    stats.jointsUpdated = jointResult.updated;
    stats.skippedOrphans += jointResult.skipped;

    // 级别判定：按 uuid 识别同一条（跨机器独立判定作为历史保留，不互相覆盖）
    const gradeResult = await mergeChildren<RockMassGrade>({
      table: db.grades,
      makeId: () => newId('grade'),
      localList: localGrades,
      importedList: pkg.grades ?? [],
      resolveFaceId,
      matchLocal: (list, imp, faceId) => list.find((g) => g.faceId === faceId && g.uuid === imp.uuid),
    });
    stats.gradesAdded = gradeResult.added;
    stats.gradesUpdated = gradeResult.updated;
    stats.skippedOrphans += gradeResult.skipped;

    // 涌水记录：uuid 优先，其次按 (掌子面, 出水部位, 里程) 识别同一出水点
    const waterResult = await mergeChildren<WaterInflow>({
      table: db.waters,
      makeId: () => newId('water'),
      localList: localWaters,
      importedList: pkg.waters ?? [],
      resolveFaceId,
      matchLocal: (list, imp, faceId) =>
        list.find(
          (w) =>
            w.faceId === faceId &&
            (w.uuid === imp.uuid || (w.position === imp.position && w.chainage === imp.chainage)),
        ),
    });
    stats.watersAdded = waterResult.added;
    stats.watersUpdated = waterResult.updated;
    stats.skippedOrphans += waterResult.skipped;

    // 素描线段：按掌子面业务键归并到本机掌子面，按线段 id 去重（重复导入不产生副本）
    for (const [key, segments] of Object.entries(pkg.sketches ?? {})) {
      const faceId = resolveFaceId(key);
      if (!faceId) continue;
      const localSegs = loadSketch(faceId);
      const existing = new Set(localSegs.map((s) => s.id));
      let changed = false;
      for (const seg of segments) {
        if (!existing.has(seg.id)) {
          localSegs.push({ ...toPlain(seg) });
          existing.add(seg.id);
          changed = true;
          stats.sketchesAdded++;
        }
      }
      if (changed) saveSketch(faceId, localSegs);
    }
  });

  return stats;
}

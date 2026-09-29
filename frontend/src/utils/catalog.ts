/**
 * 编录包导出 / 导入的 I/O 编排：
 * 纯合并算法见 transfer.ts；这里负责 IndexedDB 事务、localStorage 素描与文件下载。
 *
 * 原子性：导入先在内存里完成解析与合并，再写库；IndexedDB 单事务提交，
 * 素描线段（localStorage）先落键、事务失败即回滚全部已写键——
 * 任一步失败都保留原库，不会留下半合并状态。
 */
import { db, toPlain } from './db';
import { newId } from './id';
import { SKETCH_KEY_PREFIX, loadSketch, saveSketch, type SketchSegment } from './sketch';
import {
  CATALOG_PACKAGE_FORMAT,
  CATALOG_PACKAGE_TYPE,
  computeMerge,
  formatMergeReport,
  parseCatalogPackage,
  type CatalogPackage,
  type LocalSnapshot,
  type MergeReport,
} from './transfer';

/** 读出本机全量数据，打成编录包 */
export async function exportCatalogPackage(): Promise<CatalogPackage> {
  const [faces, joints, grades, waters] = await Promise.all([
    db.faces.toArray(),
    db.joints.toArray(),
    db.grades.toArray(),
    db.waters.toArray(),
  ]);

  // 只导出属于现存掌子面且非空的素描
  const faceIds = new Set(faces.map((f) => f.id));
  const sketches = collectSketchKeys()
    .map(({ faceId, segments }) => ({ faceId, segments }))
    .filter((entry) => faceIds.has(entry.faceId) && entry.segments.length > 0);

  return {
    packageType: CATALOG_PACKAGE_TYPE,
    format: CATALOG_PACKAGE_FORMAT,
    exportedAt: Date.now(),
    faces: toPlain(faces),
    joints: toPlain(joints),
    grades: toPlain(grades),
    waters: toPlain(waters),
    sketches: toPlain(sketches),
  };
}

/** 触发浏览器下载编录包 JSON */
export async function downloadCatalogPackage(): Promise<void> {
  const pkg = await exportCatalogPackage();
  const blob = new Blob([JSON.stringify(pkg)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  anchor.href = url;
  anchor.download = `gbtunnelface-catalog-${stamp}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export interface ImportOutcome {
  report: MergeReport;
  summary: string;
}

/**
 * 导入并合并编录包。
 * - 解析/校验在任何写入之前完成，失败抛错且原库不动；
 * - 整包在单个 IndexedDB 读写事务内提交，事务失败素描键同步回滚。
 */
export async function importCatalogPackage(raw: string): Promise<ImportOutcome> {
  const pkg = parseCatalogPackage(raw);

  const local: LocalSnapshot = {
    faces: await db.faces.toArray(),
    joints: await db.joints.toArray(),
    grades: await db.grades.toArray(),
    waters: await db.waters.toArray(),
    sketches: collectSketchKeys(),
  };

  const merged = computeMerge(local, pkg, () => newId('rec'));

  // 先写素描（localStorage 不在 IndexedDB 事务里），逐键记录旧值用于回滚。
  const localSketchBefore = new Map(local.sketches.map((entry) => [entry.faceId, entry.segments]));
  const touchedKeys: string[] = [];
  const writeSketches = () => {
    for (const entry of merged.sketches) {
      if (entry.segments.length === 0) continue;
      touchedKeys.push(entry.faceId);
      saveSketch(entry.faceId, entry.segments);
    }
  };
  const rollbackSketches = () => {
    for (const faceId of touchedKeys) {
      const previous = localSketchBefore.get(faceId);
      try {
        if (previous && previous.length > 0) saveSketch(faceId, previous);
        else window.localStorage.removeItem(`${SKETCH_KEY_PREFIX}${faceId}`);
      } catch {
        /* 回滚尽力而为 */
      }
    }
  };

  try {
    writeSketches();
    await db.transaction('rw', db.faces, db.joints, db.grades, db.waters, async () => {
      await db.faces.clear();
      await db.joints.clear();
      await db.grades.clear();
      await db.waters.clear();
      await db.faces.bulkPut(toPlain(merged.faces));
      await db.joints.bulkPut(toPlain(merged.joints));
      await db.grades.bulkPut(toPlain(merged.grades));
      await db.waters.bulkPut(toPlain(merged.waters));
    });
  } catch (error) {
    rollbackSketches();
    throw new Error(`编录包合并失败，已保留原库：${(error as Error)?.message ?? String(error)}`);
  }

  return { report: merged.report, summary: formatMergeReport(merged.report) };
}

/** 枚举 localStorage 中全部素描键（含非掌子面临时键，按前缀过滤） */
function collectSketchKeys(): { faceId: string; segments: SketchSegment[] }[] {
  const result: { faceId: string; segments: SketchSegment[] }[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key || !key.startsWith(SKETCH_KEY_PREFIX)) continue;
    const faceId = key.slice(SKETCH_KEY_PREFIX.length);
    const segments = loadSketch(faceId);
    // 兼容历史脏数据：过滤掉结构不完整的线段
    result.push({ faceId, segments: segments.filter(isUsableSegment) });
  }
  return result;
}

function isUsableSegment(seg: SketchSegment): boolean {
  return (
    !!seg &&
    typeof seg.id === 'string' &&
    [seg.x, seg.y, seg.dipAngle, seg.dipDirection, seg.length].every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

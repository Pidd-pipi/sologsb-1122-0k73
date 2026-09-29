/**
 * 编录包导入/导出 I/O 自检：node scripts/selftest-catalog.mjs
 *
 * 用 fake-indexeddb 与内存版 localStorage 模拟浏览器环境，
 * 验证真实 Dexie 事务落库、重复导入幂等、失败保留原库、素描导出/导入与回滚。
 */
import { build } from 'vite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

// ---- 浏览器环境垫片（必须在导入 db/catalog 之前安装）----
const memoryStore = new Map();
globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
globalThis.localStorage = {
  getItem: (k) => (memoryStore.has(k) ? memoryStore.get(k) : null),
  setItem: (k, v) => void memoryStore.set(k, String(v)),
  removeItem: (k) => void memoryStore.delete(k),
  clear: () => memoryStore.clear(),
  key: (i) => [...memoryStore.keys()][i] ?? null,
  get length() {
    return memoryStore.size;
  },
};
globalThis.window = globalThis;
const elements = [];
globalThis.document = {
  createElement: () => {
    const el = { href: '', download: '', click() {}, remove() {} };
    elements.push(el);
    return el;
  },
  body: { appendChild() {} },
};
globalThis.Blob = class Blob {
  constructor(parts) {
    this.text = JSON.parse(parts[0]);
  }
};
const RealURL = globalThis.URL;
let revoked = 0;
globalThis.URL = class URL extends RealURL {};
globalThis.URL.createObjectURL = () => 'blob:mock';
globalThis.URL.revokeObjectURL = () => {
  revoked += 1;
};

const root = dirname(fileURLToPath(import.meta.url));
const tmp = join(root, '.selftest-tmp-io');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const entry = join(tmp, 'entry.ts');
const outfile = join(tmp, 'bundle.mjs');
writeFileSync(
  entry,
  `export * from '../../src/utils/catalog.ts';\nexport * as transfer from '../../src/utils/transfer.ts';\nexport { db, ensureSeedData } from '../../src/utils/db.ts';\nexport { saveSketch, sketchStorageKey } from '../../src/utils/sketch.ts';\n`,
);

try {
  await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"test"' },
    build: {
      lib: { entry, formats: ['es'], fileName: () => 'bundle.mjs' },
      outDir: tmp,
      emptyOutDir: false,
      minify: false,
    },
  });

  const M = await import(pathToFileURL(outfile).href);
  const { db, ensureSeedData, saveSketch, sketchStorageKey, transfer } = M;

  await ensureSeedData();
  const seedFaces = await db.faces.toArray();
  const faceA = seedFaces.find((f) => f.faceNo === 'ZK-102');
  const faceB = seedFaces.find((f) => f.faceNo === 'ZK-103');
  saveSketch(faceA.id, [
    { id: 'sa1', x: 10, y: 10, dipAngle: 30, dipDirection: 120, length: 56, label: 'J1' },
    { id: 'sa2', x: 20, y: 10, dipAngle: 30, dipDirection: 120, length: 56, label: 'J2' },
  ]);

  // 1) 导出：四表 + 素描齐全，可被解析器回读；空素描不进包
  const raw1 = JSON.stringify(await M.exportCatalogPackage());
  const parsed1 = transfer.parseCatalogPackage(raw1);
  assert.equal(parsed1.faces.length, 2);
  assert.equal(parsed1.joints.length, 4);
  assert.equal(parsed1.grades.length, 1);
  assert.equal(parsed1.waters.length, 3);
  assert.equal(parsed1.sketches.find((s) => s.faceId === faceA.id)?.segments.length, 2);
  assert.equal(parsed1.sketches.some((s) => s.faceId === faceB.id), false);

  // 2) 把自己导出的包导回本机：编号+里程匹配 → 全部按同一循环合并，零副本
  const before = {
    faces: await db.faces.count(),
    joints: await db.joints.count(),
    grades: await db.grades.count(),
    waters: await db.waters.count(),
  };
  const outcome1 = await M.importCatalogPackage(raw1);
  const after1 = {
    faces: await db.faces.count(),
    joints: await db.joints.count(),
    grades: await db.grades.count(),
    waters: await db.waters.count(),
  };
  assert.deepEqual(after1, before, '导回本机不产生任何副本');
  assert.ok(outcome1.summary.includes('新增 0'));

  // 3) 再次导入同一包：仍然幂等，素描线段也不重复
  await M.importCatalogPackage(raw1);
  const after2 = {
    faces: await db.faces.count(),
    joints: await db.joints.count(),
    grades: await db.grades.count(),
    waters: await db.waters.count(),
  };
  assert.deepEqual(after2, before);
  const sketchAfterReimport = JSON.parse(localStorage.getItem(sketchStorageKey(faceA.id)));
  assert.equal(sketchAfterReimport.length, 2, '重复导入素描不产生重复线段');

  // 4) 冲突合并：包内更新 ZK-103 岩性并给 ZK-102 追加一条级别；本地级别改得更新须保留
  const pkg = transfer.parseCatalogPackage(raw1);
  pkg.faces = pkg.faces.map((f) =>
    f.faceNo === 'ZK-103' ? { ...f, lithology: '板岩', revisedAt: Date.now() + 5000 } : f,
  );
  pkg.joints = []; // 子表只带增量：缺失的不删除本地已有
  pkg.waters = [];
  pkg.grades = [
    { ...pkg.grades[0], correctedBq: 111, revisedAt: Date.now() - 100000 },
    {
      ...pkg.grades[0],
      id: 'remote-new-grade',
      judgedAt: Date.now() + 2000,
      correctedBq: 401,
      revisedAt: Date.now() + 2000,
    },
  ];
  const localGrade = (await db.grades.toArray()).find((g) => g.faceId === faceA.id);
  await db.grades.update(localGrade.id, { grade: 'Ⅴ', revisedAt: Date.now() + 99999 });
  const gradesBefore = await db.grades.count();
  const watersBefore = await db.waters.count();

  const outcome4 = await M.importCatalogPackage(JSON.stringify(pkg));
  assert.ok(outcome4.summary.includes('更新 1'), '掌子面岩性被包内新值更新');
  const zk103 = (await db.faces.toArray()).find((f) => f.faceNo === 'ZK-103');
  assert.equal(zk103.lithology, '板岩');
  assert.equal(zk103.id, faceB.id, '更新时保留本地主键，外键不漂移');
  assert.equal(await db.grades.count(), gradesBefore + 1, '只追加一条新判定');
  const keptGrade = await db.grades.get(localGrade.id);
  assert.equal(keptGrade.grade, 'Ⅴ', '本地较新的级别不被包内旧值覆盖');
  assert.equal(await db.waters.count(), watersBefore, '包内未带涌水不影响本地涌水');
  assert.equal(await db.joints.count(), before.joints, '包内未带节理不影响本地节理');

  // 5) 非法包：原库与素描完全保留（任何写入都还没发生）
  const sketchSnapshot = localStorage.getItem(sketchStorageKey(faceA.id));
  await assert.rejects(() => M.importCatalogPackage('{"packageType":"wrong"}'), /packageType/);
  await assert.rejects(() => M.importCatalogPackage('not json'), /合法的 JSON/);
  const broken = transfer.parseCatalogPackage(raw1);
  broken.joints = [{ ...broken.joints[0], faceId: 'no-such-face' }];
  await assert.rejects(() => M.importCatalogPackage(JSON.stringify(broken)), /包内不存在的掌子面/);
  const dup = transfer.parseCatalogPackage(raw1);
  dup.faces = [...dup.faces, { ...dup.faces[0], id: 'dup' }];
  await assert.rejects(() => M.importCatalogPackage(JSON.stringify(dup)), /重复的编号/);
  assert.deepEqual(
    {
      faces: await db.faces.count(),
      joints: await db.joints.count(),
      grades: await db.grades.count(),
      waters: await db.waters.count(),
    },
    { faces: after2.faces, joints: before.joints, grades: gradesBefore + 1, waters: watersBefore },
    '校验失败后表行数不变',
  );
  assert.equal(localStorage.getItem(sketchStorageKey(faceA.id)), sketchSnapshot, '校验失败后素描不变');

  // 6) 库事务在提交阶段失败：素描键先写入、随后一起回滚，原库完整保留
  const faceCountBeforeFail = await db.faces.count();
  const sketchBeforeFail = localStorage.getItem(sketchStorageKey(faceA.id));
  const incomingRaw = JSON.stringify(
    (() => {
      const p = transfer.parseCatalogPackage(raw1);
      p.faces = p.faces.map((f) =>
        f.faceNo === 'ZK-102' ? { ...f, mileageRange: [99990, 99993], lithology: '待回滚岩性' } : f,
      );
      p.sketches = [
        {
          faceId: p.faces.find((f) => f.faceNo === 'ZK-102').id,
          segments: [{ id: 'rollback-seg', x: 333, y: 10, dipAngle: 30, dipDirection: 120, length: 56, label: 'J' }],
        },
      ];
      return p;
    })(),
  );
  // 强制 grades.bulkPut 失败（等价于浏览器里的 DataCloneError / 约束失败）。
  // 素描（localStorage）在事务之前已写入，必须在 catch 中一并回滚。
  const originalBulkPut = db.grades.bulkPut.bind(db.grades);
  db.grades.bulkPut = async () => {
    throw new Error('simulated DataCloneError');
  };
  await assert.rejects(() => M.importCatalogPackage(incomingRaw), /已保留原库/);
  db.grades.bulkPut = originalBulkPut;
  assert.equal(await db.faces.count(), faceCountBeforeFail, '库事务失败后表行数不变');
  assert.equal(localStorage.getItem(sketchStorageKey(faceA.id)), sketchBeforeFail, '素描键随库失败一起回滚');
  const rolledFace = (await db.faces.toArray()).find((f) => f.faceNo === 'ZK-102');
  assert.equal(rolledFace.lithology, '石灰岩', '回滚后掌子面字段是原值');

  // 7) 导出走下载流程不抛错
  await M.downloadCatalogPackage();
  assert.equal(elements.length, 1);
  assert.ok(elements[0].download.includes('gbtunnelface-catalog-'));
  assert.equal(revoked, 1, '对象 URL 已释放');

  console.log('catalog I/O self-test: all 7 scenarios passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/**
 * 编录交接合并算法自检：node scripts/selftest-transfer.mjs
 *
 * 不依赖浏览器/Dexie：transfer.ts 是纯逻辑，用 vite 的 build API 即时转译后直接跑。
 * 生成物放在独立临时目录，避免 Vite 清空 scripts 目录删掉自身。
 */
import { build } from 'vite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = dirname(fileURLToPath(import.meta.url));
const tmp = join(root, '.selftest-tmp');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const entry = join(tmp, 'entry.ts');
const outfile = join(tmp, 'bundle.mjs');

writeFileSync(
  entry,
  `export * from '../../src/utils/transfer.ts';\n`,
);

try {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      lib: { entry, formats: ['es'], fileName: () => 'bundle.mjs' },
      outDir: tmp,
      emptyOutDir: false,
      write: true,
      minify: false,
    },
  });

  const T = await import(pathToFileURL(outfile).href);

  let counter = 0;
  const newId = () => `new_${++counter}`;
  const base = (over = {}) => ({
    id: 'f1',
    faceNo: 'ZK-102',
    chainage: 12480,
    mileageRange: [12480, 12483],
    excavationMethod: '台阶法',
    faceSize: '12.6×9.8',
    lithology: '石灰岩',
    weathering: '微风化',
    rockStrength: 62,
    attitude: { strike: 42, dipDirection: 132, dipAngle: 34 },
    recordedAt: 1000,
    geologist: '甲',
    ...over,
  });
  const joint = (over = {}) => ({
    id: 'j1', faceId: 'f1', setNo: 1, dipDirection: 128, dipAngle: 72,
    spacing: 42, persistence: 3.6, aperture: 1.2, fillMaterial: '方解石',
    roughness: '粗糙', waterWet: '潮湿', jointCount: 9, ...over,
  });
  const grade = (over = {}) => ({
    id: 'g1', faceId: 'f1', grade: 'Ⅲ', bqValue: 358, rqd: 78, jv: 6.2, kv: 0.61,
    groundwater: '点滴状出水', spanWidth: 12.6, correction: 0.1, correctedBq: 348,
    supportSuggestion: '', manualAdjusted: false, judgedAt: 1000, ...over,
  });
  const water = (over = {}) => ({
    id: 'w1', faceId: 'f1', position: '拱顶', type: '滴水', estimatedFlow: 6,
    waterTemp: 14, waterPressure: 0.12, changeTrend: '稳定', measuredAt: 1000, chainage: 12478, ...over,
  });
  const seg = (id, x) => ({ id, x, y: 10, dipAngle: 30, dipDirection: 120, length: 56, label: 'J1' });
  const snapshot = (over = {}) => ({
    faces: [base()], joints: [joint()], grades: [grade()], waters: [water()],
    sketches: [{ faceId: 'f1', segments: [seg('s1', 5)] }], ...over,
  });
  const pkg = (over = {}) => {
    const p = {
      packageType: T.CATALOG_PACKAGE_TYPE, format: T.CATALOG_PACKAGE_FORMAT, exportedAt: 9000,
      faces: [base({ id: 'xF1' })], joints: [joint({ id: 'xJ1', faceId: 'xF1' })],
      grades: [grade({ id: 'xG1', faceId: 'xF1' })], waters: [water({ id: 'xW1', faceId: 'xF1' })],
      sketches: [{ faceId: 'xF1', segments: [seg('xs1', 5)] }],
      ...over,
    };
    return T.validatePackage(p);
  };

  // 1) 身份按编号+里程区间，包内 id 不同也能匹配；新记录统一换本地主键
  {
    const r = T.computeMerge(snapshot(), pkg(), newId);
    assert.equal(r.faces.length, 1);
    assert.equal(r.faces[0].id, 'f1', '匹配到同一循环时保留本地掌子面主键');
    assert.equal(r.joints.length, 1);
    assert.equal(r.joints[0].id, 'j1', '平局（同基线）保留本地节理主键与值');
    assert.equal(r.grades.length, 1, '级别不产生副本');
    assert.equal(r.waters.length, 1, '涌水不产生副本');
    assert.equal(r.sketches[0].segments.length, 1, '同指纹素描线段不产生副本');
    assert.equal(r.report.faces.added, 0);
  }

  // 2) 重复导入同一包幂等（连续两次合并，结果不变）
  {
    const once = T.computeMerge(snapshot(), pkg(), newId);
    const local2 = {
      faces: once.faces, joints: once.joints, grades: once.grades, waters: once.waters,
      sketches: once.sketches,
    };
    const twice = T.computeMerge(local2, pkg(), newId);
    assert.deepEqual(twice.faces, once.faces);
    assert.deepEqual(twice.joints, once.joints);
    assert.deepEqual(twice.grades, once.grades);
    assert.deepEqual(twice.waters, once.waters);
    assert.deepEqual(twice.sketches, once.sketches);
    assert.equal(twice.sketches[0].segments.length, 1);
  }

  // 3) 两边都改过：掌子面包内更新 → 字段取新值；但本地更新的级别/涌水不被覆盖
  {
    const local = snapshot({
      faces: [base({ lithology: '本地新岩性-砂岩', revisedAt: 5000 })],
      grades: [grade({ grade: 'Ⅳ', correctedBq: 300, revisedAt: 8000 })],
      waters: [water({ estimatedFlow: 99, revisedAt: 8000 })],
      joints: [joint({ spacing: 99, revisedAt: 2000 })],
    });
    const incoming = pkg({
      faces: [base({ id: 'xF1', lithology: '包内新岩性-泥岩', revisedAt: 6000 })],
      grades: [grade({ id: 'xG1', faceId: 'xF1', grade: 'Ⅴ', correctedBq: 300, revisedAt: 3000 })],
      waters: [water({ id: 'xW1', faceId: 'xF1', estimatedFlow: 7, revisedAt: 3000 })],
      joints: [joint({ id: 'xJ1', faceId: 'xF1', spacing: 50, revisedAt: 7000 })],
    });
    const r = T.computeMerge(local, incoming, newId);
    assert.equal(r.faces[0].lithology, '包内新岩性-泥岩', '掌子面按修订时间取包内新值');
    assert.equal(r.grades[0].grade, 'Ⅳ', '较新的掌子面不能覆盖较新的级别记录');
    assert.equal(r.waters[0].estimatedFlow, 99, '较新的掌子面不能覆盖较新的涌水记录');
    assert.equal(r.joints[0].spacing, 50, '节理按自身修订时间取新值');
    assert.equal(r.faces[0].id, 'f1');
    assert.equal(r.grades[0].id, 'g1', '被保留的级别仍是本地主键');
    assert.equal(r.joints[0].id, 'j1', '被更新的节理也保留本地主键');
  }

  // 4) 本地掌子面更新、包内子记录更新：各自独立取新
  {
    const local = snapshot({ faces: [base({ lithology: '本地-页岩', revisedAt: 9000 })] });
    const incoming = pkg({
      joints: [joint({ id: 'xJ1', faceId: 'xF1', spacing: 33, revisedAt: 4000 })],
      grades: [], waters: [], sketches: [],
    });
    const r = T.computeMerge(local, incoming, newId);
    assert.equal(r.faces[0].lithology, '本地-页岩', '本地掌子面较新，保留');
    assert.equal(r.joints[0].spacing, 33, '包内节理较新，照常更新');
    assert.equal(r.grades.length, 1, '本地级别原样保留');
  }

  // 5) v2 旧数据（无 revisedAt）：先补基线再判冲突，不新不旧的平局保留本地
  {
    const local = snapshot({
      faces: [base({ recordedAt: 5000 })], // 无 revisedAt → 基线 recordedAt=5000
      joints: [joint()],                  // 无 revisedAt → 节理基线 0
    });
    const incoming = pkg({
      faces: [base({ id: 'xF1', lithology: '泥岩', recordedAt: 3000 })], // 基线 3000 < 5000
      joints: [joint({ id: 'xJ1', faceId: 'xF1', spacing: 70 })],        // 基线 0 = 0
    });
    const r = T.computeMerge(local, incoming, newId);
    assert.equal(r.faces[0].lithology, '石灰岩', '掌子面基线较旧，不覆盖本地');
    assert.equal(r.joints[0].spacing, 42, '节理同为 v2 基线 0（平局），保留本地');
    assert.equal(r.joints[0].id, 'j1');
  }

  // 6) v2 基线较新的一侧取胜
  {
    const local = snapshot({ faces: [base({ recordedAt: 2000 })] });
    const incoming = pkg({
      faces: [base({ id: 'xF1', lithology: '泥岩', recordedAt: 8000 })],
      grades: [grade({ id: 'xG1', faceId: 'xF1', grade: 'Ⅴ', correctedBq: 300, revisedAt: 7000 })],
    });
    const r = T.computeMerge(local, incoming, newId);
    assert.equal(r.faces[0].lithology, '泥岩', '包内掌子面基线 8000 > 本地 2000，取包内');
    assert.equal(r.grades.length, 1);
    assert.equal(r.grades[0].grade, 'Ⅴ');
  }

  // 7) 新掌子面（编号+里程不同）整组带入，外键重定向到新本地 id；不污染原循环
  {
    const incoming = pkg({
      faces: [
        base({ id: 'xF1' }),
        base({ id: 'xF2', faceNo: 'ZK-109', chainage: 13000, mileageRange: [13000, 13003] }),
      ],
      joints: [
        joint({ id: 'xJ1', faceId: 'xF1' }),
        joint({ id: 'xJ2', faceId: 'xF2', setNo: 2, revisedAt: 5000 }),
      ],
      grades: [grade({ id: 'xG1', faceId: 'xF2', judgedAt: 5000, revisedAt: 5000 })],
      waters: [water({ id: 'xW2', faceId: 'xF2', position: '边墙', revisedAt: 5000 })],
      sketches: [
        { faceId: 'xF1', segments: [seg('xs1', 5)] },
        { faceId: 'xF2', segments: [seg('xs2', 99)] },
      ],
    });
    const r = T.computeMerge(snapshot(), incoming, newId);
    assert.equal(r.faces.length, 2, '新循环作为新掌子面加入，而非副本');
    const newFace = r.faces.find((f) => f.faceNo === 'ZK-109');
    assert.ok(newFace, '新掌子面存在');
    assert.ok(!newFace.id.startsWith('x'), '新掌子面使用本地新主键');
    assert.ok(r.joints.some((j) => j.faceId === newFace.id && j.setNo === 2), '新节理外键重定向到新掌子面');
    assert.ok(r.grades.some((g) => g.faceId === newFace.id), '新级别外键重定向');
    assert.ok(r.waters.some((w) => w.faceId === newFace.id), '新涌水外键重定向');
    assert.ok(r.sketches.some((s) => s.faceId === newFace.id && s.segments.length === 1), '新素描归位到新掌子面');
    assert.equal(r.joints.length, 2);
    assert.equal(r.report.faces.added, 1);
    assert.equal(r.report.joints.added, 1);
  }

  // 8) 同一循环不同判定时间的级别事件、不同测量时间的涌水事件各自追加
  {
    const local = snapshot();
    const incoming = pkg({
      joints: [],
      grades: [
        grade({ id: 'xG1', faceId: 'xF1', judgedAt: 1000 }),
        grade({ id: 'xG2', faceId: 'xF1', judgedAt: 2000, grade: 'Ⅱ', correctedBq: 500, revisedAt: 2000 }),
      ],
      waters: [
        water({ id: 'xW1', faceId: 'xF1' }),
        water({ id: 'xW2', faceId: 'xF1', position: '拱顶', measuredAt: 2000, estimatedFlow: 40, revisedAt: 2000 }),
      ],
      sketches: [],
    });
    const r = T.computeMerge(local, incoming, newId);
    assert.equal(r.grades.length, 2, '同循环两次判定（不同判定时间）各自保留');
    assert.equal(r.waters.length, 2, '不同测量时间/流量的涌水各自保留');
    assert.ok(!r.grades.some((g) => g.id.startsWith('x')), '新增级别不沿用包内主键');
  }

  // 9) 非法包：parseCatalogPackage 抛错；结构损坏（子记录引用缺失掌子面）被拦截
  {
    assert.throws(() => T.parseCatalogPackage('{not json'), /合法的 JSON/);
    assert.throws(() => T.parseCatalogPackage(JSON.stringify({ packageType: 'nope' })), /packageType/);
    const badFormat = { ...pkg(), format: 99 };
    assert.throws(() => T.validatePackage(badFormat), /格式版本/);
    // 以下构造原始对象（绕过 pkg 的校验）
    const orphanRaw = {
      packageType: T.CATALOG_PACKAGE_TYPE, format: 1, exportedAt: 1,
      faces: [base({ id: 'xF1' })],
      joints: [joint({ id: 'xj', faceId: 'ghost' })], grades: [], waters: [], sketches: [],
    };
    assert.throws(() => T.validatePackage(orphanRaw), /包内不存在的掌子面/);
    const dupRaw = {
      packageType: T.CATALOG_PACKAGE_TYPE, format: 1, exportedAt: 1,
      faces: [base({ id: 'a' }), base({ id: 'b' })],
      joints: [], grades: [], waters: [], sketches: [],
    };
    assert.throws(() => T.validatePackage(dupRaw), /重复的编号\+里程区间/);
    const badRange = {
      packageType: T.CATALOG_PACKAGE_TYPE, format: 1, exportedAt: 1,
      faces: [base({ id: 'c', mileageRange: [100, 50] })],
      joints: [], grades: [], waters: [], sketches: [],
    };
    assert.throws(() => T.validatePackage(badRange), /终点不能小于起点/);
  }

  // 10) 仅编号不同或仅里程区间不同 → 不是同一循环
  {
    const local = snapshot();
    const incomingNo = pkg({
      faces: [base({ id: 'xF1', faceNo: 'ZK-102X' })],
      joints: [], grades: [], waters: [], sketches: [],
    });
    const r1 = T.computeMerge(local, incomingNo, newId);
    assert.equal(r1.faces.length, 2, '编号不同视为不同掌子面');
    const incomingRange = pkg({
      faces: [base({ id: 'xF1', mileageRange: [12480, 12490] })],
      joints: [], grades: [], waters: [], sketches: [],
    });
    const r2 = T.computeMerge(snapshot(), incomingRange, newId);
    assert.equal(r2.faces.length, 2, '里程区间不同视为不同掌子面');
  }

  // 11) 本地独有记录在合并后保留；孤儿子记录（本地无对应掌子面）被清掉
  {
    const local = snapshot({
      faces: [base(), base({ id: 'f2', faceNo: 'ZK-200', mileageRange: [200, 203] })],
      joints: [joint(), joint({ id: 'orphan', faceId: 'gone' })],
    });
    const r = T.computeMerge(local, pkg(), newId);
    assert.equal(r.faces.length, 2, '本地独有掌子面保留');
    assert.ok(r.faces.some((f) => f.id === 'f2'));
    assert.equal(r.joints.length, 1, '孤儿子记录不保留');
  }

  // 12) 素描：同位置同产状去重，不同位置追加
  {
    const local = snapshot({
      sketches: [{ faceId: 'f1', segments: [seg('a', 5), seg('b', 6)] }],
    });
    const incoming = pkg({
      sketches: [{ faceId: 'xF1', segments: [seg('c', 5), seg('d', 7)] }],
    });
    const r = T.computeMerge(local, incoming, newId);
    const xs = r.sketches[0].segments.map((s) => s.x).sort((a, b) => a - b);
    assert.deepEqual(xs, [5, 6, 7], '指纹相同不重复，新位置追加');
  }

  console.log('transfer self-test: all 12 scenarios passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

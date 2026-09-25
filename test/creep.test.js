'use strict';

// 骑马钉爬移补偿测试：
//   1. 纸厚解析（0.05～0.5 mm，数字字符串接受，其余拒绝）；
//   2. 方案中每张纸的单侧内移量＝（帖内张号－1）×纸厚，分册各帖分别从零；
//   3. 端到端：同一印张正背两面左页向右、右页向左平移，槽位裁剪在各自半区
//      （q re W n ... Do Q 结构、裁剪矩形恰为半区），补白保持空白，
//      页序、输出页数与纸张尺寸不变；未启用时内容流与原输出完全一致；
//   4. 缺页补印沿用本次纸厚：补印页与完整拼版对应输出页逐页一致；
//   5. 定位标记 + 爬移叠加：裁剪半区随版心偏移 8mm，印张尺寸仍为加标记尺寸。
const assert = require('assert');
const zlib = require('zlib');
const { PDFDocument, PDFName, StandardFonts, rgb } = require('pdf-lib');
const {
  imposePdf,
  buildImpositionPlan,
  buildSignaturePlan,
  parseCreepPaperThickness,
  creepForSheet,
  CREEP_MIN_PAPER_THICKNESS_MM,
  CREEP_MAX_PAPER_THICKNESS_MM,
} = require('../lib/impose');
const { reprintPdf } = require('../lib/reprint');
const { MARK_MARGIN_PT, PT_PER_MM } = require('../lib/sheet-marks');

// ---------- 1. 纸厚解析 ----------
assert.strictEqual(CREEP_MIN_PAPER_THICKNESS_MM, 0.05);
assert.strictEqual(CREEP_MAX_PAPER_THICKNESS_MM, 0.5);
for (const ok of [0.05, 0.5, 0.1, 0.3, '0.1', '  0.2  ']) {
  const v = parseCreepPaperThickness(ok);
  assert.ok(Number.isFinite(v) && v >= 0.05 && v <= 0.5, `应接受 ${JSON.stringify(ok)}`);
}
for (const bad of [
  0, 0.04, 0.51, -0.1, 10, NaN, Infinity, '', '   ', 'abc', '0.1mm',
  true, false, null, undefined, {}, [], '1e-1', '.1', '1.', '0,1',
]) {
  assert.throws(
    () => parseCreepPaperThickness(bad),
    /0.05～0.5/,
    `应拒绝 ${JSON.stringify(bad)}`,
  );
}
assert.throws(() => buildImpositionPlan(0, 0.1), /至少需要包含 1 页/);
console.log('✅ 纸厚解析通过：仅接受 0.05～0.5 mm 的数字/数字字符串');

// ---------- 2. 爬移量纯函数 ----------
assert.deepStrictEqual(creepForSheet(1, 0.1), { shiftMm: 0, shiftPt: 0 });
assert.strictEqual(creepForSheet(2, 0.1).shiftMm, 0.1);
assert.ok(Math.abs(creepForSheet(2, 0.1).shiftPt - 0.1 * PT_PER_MM) < 1e-6);
assert.strictEqual(creepForSheet(4, 0.05).shiftMm, 0.15);
assert.strictEqual(creepForSheet(1, 0).shiftMm, 0);

// 整册 8 页、纸厚 0.1：两张纸内移 0 / 0.1mm
const p8 = buildImpositionPlan(8, 0.1);
assert.deepStrictEqual(p8.creep, { enabled: true, paperThicknessMm: 0.1 });
assert.deepStrictEqual(p8.sheets.map((s) => s.creep.shiftMm), [0, 0.1]);
// 页序槽位不受影响
assert.strictEqual(p8.sheets[0].front.left.page, 8);
assert.strictEqual(p8.sheets[0].front.right.page, 1);

// 未启用：所有内移量为 0，creep.enabled=false
const p8off = buildImpositionPlan(8);
assert.deepStrictEqual(p8off.creep, { enabled: false, paperThicknessMm: 0 });
assert.deepStrictEqual(p8off.sheets.map((s) => s.creep.shiftMm), [0, 0]);

// 分册 13 页、每帖 2 张、纸厚 0.1：两帖均为 [0, 0.1]，分别从零
const sig = buildSignaturePlan(13, 2, 0.1);
assert.deepStrictEqual(
  sig.signatures.map((s) => s.sheets.map((sh) => sh.creep.shiftMm)),
  [[0, 0.1], [0, 0.1]],
);
assert.deepStrictEqual(sig.creep, { enabled: true, paperThicknessMm: 0.1 });

// 任意页数 / 每帖张数 / 纸厚：内移量 = (张号-1) × 纸厚，各帖第 1 张恒为 0
for (const n of [1, 5, 8, 13, 40, 80]) {
  for (const max of [1, 3, 20]) {
    const plan = buildSignaturePlan(n, max, 0.123);
    for (const s of plan.signatures) {
      s.sheets.forEach((sh, i) => {
        assert.ok(Math.abs(sh.creep.shiftMm - i * 0.123) < 1e-9,
          `n=${n} max=${max} 帖${s.signature} 张${sh.sheet}`);
        assert.strictEqual(s.sheets[0].creep.shiftMm, 0, '每帖第 1 张内移量为 0');
      });
    }
  }
}
console.log('✅ 爬移量计算通过：整册按张号、分册各帖分别从零，内移量＝(张号-1)×纸厚');

// 读取输出页的内容流文本
function decodePageContent(doc, pageIndex) {
  const node = doc.getPage(pageIndex).node;
  const contents = node.get(PDFName.of('Contents'));
  const refs = typeof contents.asArray === 'function' ? contents.asArray() : [contents];
  return refs.map((ref) => {
    const stream = doc.context.lookup(ref);
    return zlib.inflateSync(Buffer.from(stream.getContents())).toString('latin1');
  }).join('\n');
}

// 解析内容流中的全部 cm 矩阵 [a b c d e f]
function parseCmOperators(content) {
  const ops = [];
  const re = /(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+cm/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    ops.push(m.slice(1, 7).map(Number));
  }
  return ops;
}

// 内容流中 q / Q 是否配平
function assertGraphicsBalanced(content, label) {
  const lines = content.split('\n');
  const q = lines.filter((l) => l === 'q').length;
  const capQ = lines.filter((l) => l === 'Q').length;
  assert.strictEqual(q, capQ, `${label}: q(${q})/Q(${capQ}) 应配平`);
}

// 内容流中的裁剪矩形（re 操作符）
function parseRects(content) {
  const rects = [];
  const re = /(-?[\d.eE+-]+) (-?[\d.eE+-]+) (-?[\d.eE+-]+) (-?[\d.eE+-]+) re/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    rects.push(m.slice(1, 5).map(Number));
  }
  return rects;
}

function hasRect(rects, x, y, w, h, eps = 1e-6) {
  return rects.some((r) => Math.abs(r[0] - x) < eps && Math.abs(r[1] - y) < eps
    && Math.abs(r[2] - w) < eps && Math.abs(r[3] - h) < eps);
}

(async () => {
  // ---------- 3. 端到端：8 页 A4、纸厚 0.1mm ----------
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  for (let i = 1; i <= 8; i += 1) {
    src.addPage([PAGE_W, PAGE_H]).drawText(`PAGE ${i}`, {
      x: 200, y: 400, size: 40, font, color: rgb(0, 0, 0),
    });
  }
  const srcBytes = await src.save();
  const shiftPt = 0.1 * PT_PER_MM;

  const { pdfBytes: plainBytes, plan: plainPlan } = await imposePdf(srcBytes);
  const { pdfBytes: creepBytes, plan: creepPlan } = await imposePdf(srcBytes, {
    creepPaperThicknessMm: 0.1,
  });
  const plain = await PDFDocument.load(plainBytes);
  const creepDoc = await PDFDocument.load(creepBytes);

  // 3.1 纸张尺寸、输出页数不变
  assert.strictEqual(creepDoc.getPageCount(), 4);
  for (let i = 0; i < 4; i += 1) {
    assert.ok(Math.abs(creepDoc.getPage(i).getWidth() - PAGE_W * 2) < 0.01, `第 ${i + 1} 页宽不变`);
    assert.ok(Math.abs(creepDoc.getPage(i).getHeight() - PAGE_H) < 0.01, `第 ${i + 1} 页高不变`);
  }
  assert.ok(Math.abs(creepPlan.sheet.width - PAGE_W * 2) < 0.01);
  assert.ok(Math.abs(creepPlan.sheet.height - PAGE_H) < 0.01);

  // 3.2 页序槽位与补白完全一致
  assert.deepStrictEqual(
    creepPlan.sheets.map((s) => [s.front, s.back]),
    plainPlan.sheets.map((s) => [s.front, s.back]),
  );

  // 3.3 帖内第 1 张（shift=0）：内容流逐字节与未启用一致，且无裁剪矩形
  assert.strictEqual(decodePageContent(creepDoc, 0), decodePageContent(plain, 0));
  assert.strictEqual(decodePageContent(creepDoc, 1), decodePageContent(plain, 1));
  assert.strictEqual(parseRects(decodePageContent(creepDoc, 0)).length, 0);

  // 3.4 帖内第 2 张正背两面：左页向右 +shift、右页向左 -shift
  for (const pageIndex of [2, 3]) {
    const content = decodePageContent(creepDoc, pageIndex);
    const ops = parseCmOperators(content);
    assert.ok(ops.find((m) => Math.abs(m[4] - shiftPt) < 1e-6 && Math.abs(m[5]) < 1e-6),
      `输出第 ${pageIndex + 1} 页左页应右移 ${shiftPt.toFixed(3)} pt`);
    assert.ok(ops.find((m) => Math.abs(m[4] - (PAGE_W - shiftPt)) < 1e-6 && Math.abs(m[5]) < 1e-6),
      `输出第 ${pageIndex + 1} 页右页应左移 ${shiftPt.toFixed(3)} pt`);
    assertGraphicsBalanced(content, `输出第 ${pageIndex + 1} 页`);

    // 槽位裁剪在各自半区：两个矩形分别为左/右半区（无标记时原点 0）
    const rects = parseRects(content);
    assert.strictEqual(rects.length, 2, `输出第 ${pageIndex + 1} 页应有 2 个半区裁剪矩形`);
    assert.ok(hasRect(rects, 0, 0, PAGE_W, PAGE_H), '左半区裁剪矩形');
    assert.ok(hasRect(rects, PAGE_W, 0, PAGE_W, PAGE_H), '右半区裁剪矩形');
    // W（裁剪）与 n（结束路径）各 2 个
    const lines = content.split('\n');
    assert.strictEqual(lines.filter((l) => l === 'W').length, 2);
    assert.strictEqual(lines.filter((l) => l === 'n').length, 2);
  }

  console.log('✅ 端到端爬移通过：8 页 2 张，第 1 张输出不变；第 2 张正背面左页右移/右页左移，');
  console.log('   裁剪矩形恰为各自半区，q/Q 配平，页序、页数与纸张尺寸不变');

  // ---------- 4. 补白槽位保持空白：5 页（补 3 白）、纸厚 0.2mm ----------
  const src5 = await PDFDocument.create();
  const font5 = await src5.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 5; i += 1) {
    src5.addPage([PAGE_W, PAGE_H]).drawText(`P${i}`, { x: 200, y: 400, size: 40, font: font5 });
  }
  const { pdfBytes: c5 } = await imposePdf(await src5.save(), { creepPaperThicknessMm: 0.2 });
  const doc5 = await PDFDocument.load(c5);
  // 帖内第 1 张 shift=0：即便有补白也不压入裁剪
  assert.strictEqual(parseRects(decodePageContent(doc5, 0)).length, 0);
  // 第 2 张正面 F[空白|3]：只有右半区 1 个裁剪矩形、1 个 Do（补白不绘制）
  const front2 = decodePageContent(doc5, 2);
  assert.strictEqual((front2.match(/ Do\n/g) || []).length, 1, '补白槽位不绘制任何内容');
  const rects2b = parseRects(front2);
  assert.strictEqual(rects2b.length, 1, '仅右半区（真实页）压入裁剪');
  assert.ok(hasRect(rects2b, PAGE_W, 0, PAGE_W, PAGE_H));
  // 右页 3 向左内移 0.2mm
  const ops5 = parseCmOperators(front2);
  assert.ok(ops5.find((m) => Math.abs(m[4] - (PAGE_W - 0.2 * PT_PER_MM)) < 1e-6), '右页内移 0.2mm');
  console.log('✅ 补白保持空白：补白槽位不绘制，仅真实页半区裁剪/平移');

  // ---------- 5. 端到端分册签帖：13 页每帖 2 张，各帖分别从零 ----------
  const sigSrc = await PDFDocument.create();
  const sigFont = await sigSrc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 13; i += 1) {
    sigSrc.addPage([PAGE_W, PAGE_H]).drawText(`P${i}`, { x: 200, y: 400, size: 40, font: sigFont });
  }
  const sigBytes = await sigSrc.save();
  const { pdfBytes: sigCreepBytes, plan: sigCreepPlan } = await imposePdf(sigBytes, {
    maxSheetsPerSignature: 2,
    creepPaperThicknessMm: 0.1,
  });
  const sigDoc = await PDFDocument.load(sigCreepBytes);
  assert.strictEqual(sigDoc.getPageCount(), 8);
  // 输出页 0,1,4,5 为两帖帖内第 1 张：无裁剪
  for (const idx of [0, 1, 4, 5]) {
    assert.strictEqual(parseRects(decodePageContent(sigDoc, idx)).length, 0,
      `输出第 ${idx + 1} 页（帖内第 1 张）不应裁剪`);
  }
  // 输出页 2,3（帖1第2张）：左右平移
  const ops2 = parseCmOperators(decodePageContent(sigDoc, 2));
  assert.ok(ops2.find((m) => Math.abs(m[4] - shiftPt) < 1e-6));
  assert.ok(ops2.find((m) => Math.abs(m[4] - (PAGE_W - shiftPt)) < 1e-6));
  // 输出页 6,7（帖2第2张）：同样平移 0.1mm（从零计算，而非累计 0.2mm）
  const ops6 = parseCmOperators(decodePageContent(sigDoc, 6));
  assert.ok(ops6.find((m) => Math.abs(m[4] - (PAGE_W - shiftPt)) < 1e-6),
    '第 2 帖帖内第 2 张也只内移 0.1mm（分别从零）');
  assert.ok(!ops6.find((m) => Math.abs(m[4] - (PAGE_W - 2 * shiftPt)) < 1e-6),
    '不应累计为 0.2mm');
  assert.deepStrictEqual(
    sigCreepPlan.signatures.map((s) => s.sheets.map((sh) => sh.creep.shiftMm)),
    [[0, 0.1], [0, 0.1]],
  );
  console.log('✅ 端到端分册爬移通过：两帖帖内第 1 张不动，第 2 张各自内移 0.1mm（不累计）');

  // ---------- 6. 爬移 + 定位标记叠加 ----------
  const { pdfBytes: bothBytes, plan: bothPlan } = await imposePdf(srcBytes, {
    creepPaperThicknessMm: 0.1,
    registrationMarks: true,
  });
  const bothDoc = await PDFDocument.load(bothBytes);
  const m = MARK_MARGIN_PT;
  // 印张尺寸为加标记尺寸（四周 +8mm）
  for (let i = 0; i < bothDoc.getPageCount(); i += 1) {
    assert.ok(Math.abs(bothDoc.getPage(i).getWidth() - (PAGE_W * 2 + 2 * m)) < 0.01);
    assert.ok(Math.abs(bothDoc.getPage(i).getHeight() - (PAGE_H + 2 * m)) < 0.01);
  }
  // 裁剪半区随版心偏移 m：左半区 [m,m, PAGE_W,PAGE_H]，右半区 [m+PAGE_W, m, ...]
  const content2 = decodePageContent(bothDoc, 2);
  const rects2 = parseRects(content2);
  // 标记线本身不产生 re 矩形，故仍为 2 个裁剪矩形
  assert.ok(hasRect(rects2, m, m, PAGE_W, PAGE_H), '启用标记后左半区裁剪随版心偏移');
  assert.ok(hasRect(rects2, m + PAGE_W, m, PAGE_W, PAGE_H), '启用标记后右半区裁剪随版心偏移');
  // 左页绘制位置 = 标记偏移 m + 爬移 shift
  const opsBoth = parseCmOperators(content2);
  assert.ok(opsBoth.find((mm) => Math.abs(mm[4] - (m + shiftPt)) < 1e-6),
    '左页位置 = 8mm 版心偏移 + 爬移内移');
  assert.strictEqual(bothPlan.marks.enabled, true);
  assert.strictEqual(bothPlan.creep.enabled, true);
  console.log('✅ 爬移 + 定位标记叠加通过：半区裁剪随版心偏移 8mm，印张尺寸保持加标记尺寸');

  // ---------- 7. 缺页补印沿用本次纸厚 ----------
  // 10 页 -> 3 张纸；受损 2,3 -> 第 1 张（页 2，shift 0）+ 第 2 张（页 3，shift 0.1）
  const src10 = await PDFDocument.create();
  const f10 = await src10.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 10; i += 1) {
    src10.addPage([PAGE_W, PAGE_H]).drawText(`PAGE ${i}`, { x: 200, y: 400, size: 40, font: f10 });
  }
  const bytes10 = await src10.save();
  const { pdfBytes: full10 } = await imposePdf(bytes10, { creepPaperThicknessMm: 0.1 });
  const full10Doc = await PDFDocument.load(full10);

  const { pdfBytes: rpBytes, reprint } = await reprintPdf(bytes10, { creepPaperThicknessMm: 0.1 }, '2,3');
  assert.strictEqual(reprint.creep.enabled, true);
  assert.strictEqual(reprint.creep.paperThicknessMm, 0.1);
  assert.strictEqual(reprint.sheetCount, 2);
  assert.deepStrictEqual(reprint.sheets.map((s) => s.sheet), [1, 2]);
  // 每张补印纸带本次爬移内移量
  assert.strictEqual(reprint.sheets[0].creep.shiftMm, 0);
  assert.strictEqual(reprint.sheets[1].creep.shiftMm, 0.1);
  assert.deepStrictEqual(reprint.sheets[1].outputPages, [3, 4]);

  const rpDoc = await PDFDocument.load(rpBytes);
  assert.strictEqual(rpDoc.getPageCount(), 4);
  // 与完整拼版对应印张（输出页 1,2,3,4）逐页一致
  for (let i = 0; i < 4; i += 1) {
    assert.strictEqual(
      decodePageContent(rpDoc, i),
      decodePageContent(full10Doc, i),
      `补印第 ${i + 1} 页应与完整拼版第 ${i + 1} 页一致（含爬移）`,
    );
  }
  // 补印第 3 页（完整拼版第 3 页：第 2 张正面 F[10|3]）应含 0.1mm 爬移平移
  const rpOps = parseCmOperators(decodePageContent(rpDoc, 2));
  assert.ok(rpOps.find((mm) => Math.abs(mm[4] - (PAGE_W - shiftPt)) < 1e-6),
    '补印页应含与完整拼版一致的爬移平移');
  assert.strictEqual(parseRects(decodePageContent(rpDoc, 2)).length, 2, '补印页保留半区裁剪');
  console.log('✅ 爬移补印通过：沿用本次纸厚，补印页与完整拼版对应印张逐页一致（含平移与裁剪）');

  // 未启用爬移的补印：reprint.creep.enabled=false，每张 shift 为 0
  const { reprint: rpOff } = await reprintPdf(bytes10, {}, '2');
  assert.deepStrictEqual(rpOff.creep, { enabled: false, paperThicknessMm: 0 });
  assert.strictEqual(rpOff.sheets[0].creep.shiftMm, 0);

  // ---------- 8. 非法纸厚在核心层拒绝 ----------
  await assert.rejects(() => imposePdf(srcBytes, { creepPaperThicknessMm: 0.04 }), /0.05～0.5/);
  await assert.rejects(() => imposePdf(srcBytes, { creepPaperThicknessMm: 0.51 }), /0.05～0.5/);
  await assert.rejects(() => imposePdf(srcBytes, { creepPaperThicknessMm: '厚' }), /0.05～0.5/);
  await assert.rejects(() => reprintPdf(srcBytes, { creepPaperThicknessMm: 0 }, '2'), /0.05～0.5/);

  console.log('✅ 非法纸厚明确报错（0、超界、非数字）');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

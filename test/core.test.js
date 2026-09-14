'use strict';
/* mindmap-core 纯逻辑层单测：数据模型、树操作、撤销重做、布局、导出。 */
const assert = require('assert');
const C = require('../media/core.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('  ✔ ' + name);
}

console.log('mindmap-core tests');

/* ---------- 解析 / 序列化 ---------- */
ok('parse 合法 JSON 并规范化', () => {
  const data = C.parse(JSON.stringify({ root: { text: 'a', children: [{ text: 'b' }] } }));
  assert.strictEqual(data.root.text, 'a');
  assert.ok(data.root.id, '自动补 id');
  assert.strictEqual(data.root.children[0].collapsed, false, '自动补 collapsed');
  assert.strictEqual(C.serialize(data), JSON.stringify(data, null, 2));
});

ok('parse 非法输入抛错', () => {
  assert.throws(() => C.parse('{bad json'), SyntaxError);
  assert.throws(() => C.parse('{"foo":1}'), /root/);
  assert.throws(() => C.parse('null'), Error);
});

ok('defaultData 结构完整', () => {
  const d = C.defaultData();
  assert.strictEqual(d.version, 1);
  assert.strictEqual(d.root.text, '');
  assert.strictEqual(d.root.children.length, 0);
  assert.strictEqual(C.countNodes(d.root), 1);
});

/* ---------- 模型操作 ---------- */
function sample() {
  return C.parse(
    JSON.stringify({
      root: {
        text: 'root',
        children: [
          { text: 'a', children: [{ text: 'a1' }, { text: 'a2' }] },
          { text: 'b', children: [] },
        ],
      },
    })
  );
}

ok('addChild / addSibling', () => {
  const m = new C.MindMapModel(sample());
  const a = m.root.children[0];
  const aId = a.id;
  const n1 = m.addChild(aId, 'x');
  assert.ok(n1);
  assert.strictEqual(a.children[a.children.length - 1].id, n1.id);
  const n2 = m.addSibling(n1.id, 'y', false);
  assert.ok(n2);
  assert.strictEqual(a.children[a.children.length - 1].id, n2.id);
  const n3 = m.addSibling(n1.id, 'z', true);
  assert.strictEqual(a.children.indexOf(n3), a.children.indexOf(n1) - 1);
  // 根节点无同级
  assert.strictEqual(m.addSibling(m.root.id, 'w'), null);
});

ok('removeNode 子节点提升', () => {
  const m = new C.MindMapModel(sample());
  const a = m.root.children[0];
  const a1 = a.children[0].id;
  const a2 = a.children[1].id;
  const bId = m.root.children[1].id;
  assert.strictEqual(m.removeNode(a.id), true);
  assert.deepStrictEqual(
    m.root.children.map((c) => c.id),
    [a1, a2, bId]
  );
  assert.strictEqual(m.removeNode(m.root.id), false, '根节点不可删');
});

ok('setText / toggleCollapse', () => {
  const m = new C.MindMapModel(sample());
  const a = m.root.children[0];
  assert.strictEqual(m.setText(a.id, 'AA'), true);
  assert.strictEqual(a.text, 'AA');
  assert.strictEqual(m.toggleCollapse(a.id), true);
  assert.strictEqual(a.collapsed, true);
  assert.strictEqual(m.toggleCollapse(a.id), true);
  assert.strictEqual(a.collapsed, false);
});

ok('moveNode 三种位置', () => {
  const m = new C.MindMapModel(sample());
  const a = m.root.children[0];
  const b = m.root.children[1];
  const a2 = a.children[1];
  // 成为 b 的子节点
  assert.strictEqual(m.moveNode(a2.id, b.id, 'child'), true);
  assert.strictEqual(b.children[0].id, a2.id);
  // 成为 a 的 before 同级（在根下）
  assert.strictEqual(m.moveNode(a2.id, a.id, 'before'), true);
  assert.strictEqual(m.root.children[0].id, a2.id);
  // 不能拖到自己的子孙
  const m2 = new C.MindMapModel(sample());
  const a3 = m2.root.children[0];
  assert.strictEqual(m2.moveNode(a3.id, a3.children[0].id, 'child'), false);
  assert.strictEqual(m2.moveNode(a3.id, a3.id, 'child'), false);
});

ok('promote 提升层级', () => {
  const m = new C.MindMapModel(sample());
  const a = m.root.children[0];
  const a1 = a.children[0];
  assert.strictEqual(m.promote(a1.id), true);
  assert.strictEqual(m.root.children[1].id, a1.id, '提升为 a 的下一个同级');
  assert.strictEqual(m.promote(a.id), false, '根的直接子级不可提升');
});

/* ---------- 撤销 / 重做 ---------- */
ok('undo/redo 恢复结构', () => {
  const m = new C.MindMapModel(sample());
  const before = JSON.stringify(m.data);
  m.addChild(m.root.children[0].id, 'x');
  assert.notStrictEqual(JSON.stringify(m.data), before);
  assert.strictEqual(m.undo(), true);
  assert.strictEqual(JSON.stringify(m.data), before);
  assert.strictEqual(m.redo(), true);
  assert.notStrictEqual(JSON.stringify(m.data), before);
  assert.strictEqual(m.undo(), true);
  assert.strictEqual(m.canRedo(), true);
});

/* ---------- 布局 ---------- */
ok('layoutTree 尺寸/边界/侧向交替', () => {
  const m = new C.MindMapModel(sample());
  const measure = C.createMeasure('14px sans-serif');
  const { sideOf, bounds, visible } = C.layoutTree(m.root, measure);
  assert.ok(bounds.maxX > bounds.minX && bounds.maxY > bounds.minY);
  // 根的两个子级左右交替
  assert.strictEqual(sideOf.get(m.root.children[0].id), 'right');
  assert.strictEqual(sideOf.get(m.root.children[1].id), 'left');
  // 孙级继承父级侧向
  assert.strictEqual(sideOf.get(m.root.children[0].children[0].id), 'right');
  // 可见节点 = 全部（未折叠）
  assert.strictEqual(visible.length, C.countNodes(m.root));
  // 左右子树不与根重叠
  const a = m.root.children[0];
  const b = m.root.children[1];
  assert.ok(a._x >= m.root._x + m.root._w, '右分支在根右侧');
  assert.ok(b._x + b._w <= m.root._x, '左分支在根左侧');
});

ok('layoutTree 折叠隐藏子树', () => {
  const m = new C.MindMapModel(sample());
  m.root.children[0].collapsed = true;
  const measure = C.createMeasure('14px sans-serif');
  const { visible } = C.layoutTree(m.root, measure);
  assert.strictEqual(visible.length, 3, '折叠后只剩 root/a/b');
});

/* ---------- 导出 ---------- */
ok('markdownExport 层级缩进', () => {
  const m = new C.MindMapModel(sample());
  const md = C.markdownExport(m.data);
  const lines = md.trim().split('\n');
  assert.strictEqual(lines[0], '# root');
  assert.strictEqual(lines[1], '  - a');
  assert.strictEqual(lines[2], '    - a1');
  assert.strictEqual(lines[3], '    - a2');
  assert.strictEqual(lines[4], '  - b');
});

ok('markdownExport 折叠分支不展开', () => {
  const m = new C.MindMapModel(sample());
  m.root.children[0].collapsed = true;
  const md = C.markdownExport(m.data);
  assert.ok(!md.includes('a1'));
});

ok('htmlExport 生成独立页面且包含数据', () => {
  const m = new C.MindMapModel(sample());
  const html = C.htmlExport(m.data);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('center') || html.includes('思维导图'));
  assert.ok(html.includes('root'));
});

/* ---------- 主题 ---------- */
ok('THEMES 完整且分支色足够', () => {
  for (const key of Object.keys(C.THEMES)) {
    const t = C.THEMES[key];
    assert.ok(t.rootFill && t.branch && t.branch.length >= 4, key + ' 主题字段完整');
  }
});

console.log('\n全部通过：' + passed + ' 项');

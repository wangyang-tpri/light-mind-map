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



ok('无效移动保持树结构与撤销栈不变', () => {
  const m = new C.MindMapModel(sample());
  const before = C.serialize(m.data);
  const id = m.root.children[0].id;
  for (const [target, where] of [['missing', 'child'], [m.root.id, 'before'], [m.root.id, 'invalid']]) {
    assert.strictEqual(m.moveNode(id, target, where), false);
    assert.strictEqual(C.serialize(m.data), before);
    assert.strictEqual(m.canUndo(), false);
  }
});
ok('布局缓存不进入文档或撤销快照', () => {
  const m = new C.MindMapModel(sample());
  C.layoutTree(m.root, C.createMeasure('14px sans-serif'));
  assert.ok(!C.serialize(m.data).includes('"_w"'));
  assert.ok(!JSON.stringify(m.snapshot()).includes('"_x"'));
});

ok('新增布局间距、目录顺序及折叠正确', () => {
  const measure = C.createMeasure('14px sans-serif');
  const sizes = {};
  for (const mode of ['compact', 'right', 'spacious', 'outline']) {
    const data = sample();
    const result = C.layoutTree(data.root, measure, mode);
    sizes[mode] = result.bounds;
    assert.strictEqual(result.visible.length, C.countNodes(data.root));
    for (let i = 0; i < result.visible.length; i++) {
      const a = result.visible[i];
      for (const b of result.visible.slice(i + 1)) {
        assert.ok(a._x + a._w <= b._x || b._x + b._w <= a._x || a._y + a._h <= b._y || b._y + b._h <= a._y, mode + ' 节点不重叠');
      }
      if (mode === 'outline' && i > 0) assert.ok(a._y > result.visible[i - 1]._y);
    }
    data.root.children[0].collapsed = true;
    const folded = C.layoutTree(data.root, measure, mode);
    assert.ok(folded.visible.length < result.visible.length);
  }
  assert.ok(sizes.compact.maxX < sizes.right.maxX);
  assert.ok(sizes.spacious.maxX > sizes.right.maxX);
  assert.ok(sizes.spacious.maxY > sizes.compact.maxY);
});

ok('关联线校验、删除节点清理及撤销恢复', () => {
  const m = new C.MindMapModel(sample());
  const a = m.root.children[0].id, b = m.root.children[1].id;
  assert.strictEqual(m.addRelation(a, a), false);
  assert.strictEqual(m.addRelation(a, 'missing'), false);
  assert.ok(m.addRelation(a, b));
  assert.strictEqual(m.addRelation(b, a), false);
  const link = m.data.relations[0];
  assert.ok(m.removeRelation(link.id));
  m.undo();
  assert.strictEqual(m.data.relations.length, 1);
  m.removeNode(a);
  assert.strictEqual(m.data.relations.length, 0);
  m.undo();
  assert.strictEqual(m.data.relations.length, 1);
  assert.strictEqual(C.parse(C.serialize(m.data)).relations[0].from, a);
});
ok('组织图和放射布局坐标有效且支持折叠', () => {
  for (const mode of ['org', 'up', 'radial']) {
    const data = sample();
    const result = C.layoutTree(data.root, C.createMeasure('14px sans-serif'), mode);
    for (const n of result.visible) assert.ok(Number.isFinite(n._x) && Number.isFinite(n._y));
    if (mode === 'org') assert.ok(data.root.children[0]._y > data.root._y + data.root._h);
    if (mode === 'up') assert.ok(data.root.children[0]._y + data.root.children[0]._h < data.root._y);
    data.root.collapsed = true;
    assert.strictEqual(C.layoutTree(data.root, C.createMeasure('14px sans-serif'), mode).visible.length, 1);
  }
});

ok('Markdown 标题、嵌套列表、任务与代码块导入', () => {
  const data = C.markdownImport('# 项目\n## 计划\n- [x] 开发\n  1. 接口\n  2. 页面\n- 测试\n## 资料\n```js\n# 不是标题\n```', '文件');
  assert.strictEqual(data.root.text, '项目');
  assert.deepStrictEqual(data.root.children.map(n => n.text), ['计划', '资料']);
  const plan = data.root.children[0];
  assert.deepStrictEqual(plan.children.map(n => n.text), ['开发', '测试']);
  assert.deepStrictEqual(plan.children[0].children.map(n => n.text), ['接口', '页面']);
  assert.strictEqual(data.root.children[1].children[0].text, '# 不是标题');
  assert.throws(() => C.markdownImport('  '));
  assert.strictEqual(C.markdownImport('- 条目', '笔记').root.text, '笔记');
});

ok('富内容 Markdown 保留表格、语言和 Mermaid 源码', () => {
  const md = '# 文档\n| 字段 | 值 |\n| --- | --- |\n| 名称 | 测试 |\n\n```js\n  const x = "<script>";\n```\n```mermaid\nflowchart LR\nA --> B\n```';
  const data = C.markdownImport(md);
  assert.deepStrictEqual(data.root.children.map(n => n.content.type), ['table', 'code', 'mermaid']);
  assert.strictEqual(data.root.children[1].content.language, 'js');
  assert.ok(data.root.children[1].text.startsWith('  const'));
  const saved = C.parse(C.serialize(data));
  assert.strictEqual(saved.root.children[2].content.type, 'mermaid');
  assert.ok(C.markdownExport(saved).includes('```mermaid'));
  assert.ok(C.markdownExport(saved).includes('| 字段 | 值 |'));
});

ok('节点样式继承、子级覆盖、重置和撤销可恢复', () => {
  const m = new C.MindMapModel(sample());
  const a = m.root.children[0], b = m.root.children[1], child = a.children[0];
  assert.ok(m.setNodeStyle(a.id, { lineColor: '#cc2233', textColor: '#224488', fontWeight: 700 }));
  let colors = C.assignBranchColors(m.root, C.THEMES.lightMap);
  let texts = C.resolveTextStyles(m.root, C.THEMES.lightMap);
  assert.strictEqual(colors.get(child.id), '#cc2233');
  assert.strictEqual(texts.get(child.id).fontWeight, 700);
  assert.strictEqual(texts.get(child.id).textColor, '#224488');
  assert.strictEqual(colors.get(b.id), C.THEMES.lightMap.rootFill);
  m.setNodeStyle(child.id, { lineColor: '#00aa55' });
  m.setNodeStyle(a.id, { lineColor: '#aa00cc' });
  assert.strictEqual(C.assignBranchColors(m.root, C.THEMES.lightMap).get(child.id), '#00aa55');
  m.setNodeStyle(child.id, { lineColor: null });
  assert.strictEqual(C.assignBranchColors(m.root, C.THEMES.lightMap).get(child.id), '#aa00cc');
  m.undo();
  assert.strictEqual(C.assignBranchColors(m.root, C.THEMES.lightMap).get(child.id), '#00aa55');
  assert.strictEqual(C.parse(C.serialize(m.data)).root.children[0].style.fontWeight, 700);
  assert.strictEqual(m.setNodeStyle(a.id, { textColor: 'url(x)', fontWeight: 999 }), false);
});

ok('PNG 长导图不再压缩到 4096，超大尺寸建议使用 SVG', () => {
  assert.deepStrictEqual(C.pngExportSize(1000, 800), { scale: 3, width: 3000, height: 2400 });
  const long = C.pngExportSize(1200, 8000);
  assert.ok(long.height > 8000 && long.width >= 1200);
  assert.ok(long.scale >= 1);
  assert.throws(() => C.pngExportSize(40000, 1000), /SVG/);
  assert.throws(() => C.pngExportSize(10000, 10000), /SVG/);
});

ok('组织图长短节点同层对齐，使用共享横线和圆角分支', () => {
  for (const mode of ['org', 'up']) {
    const data = sample();
    data.root.children.push(C.createNode('第三个节点'));
    data.root.children[1].text = '多行\n第二行\n第三行';
    C.layoutTree(data.root, C.createMeasure('14px sans-serif'), mode);
    const topEdges = data.root.children.map(n => mode === 'org' ? n._y : n._y + n._h);
    assert.ok(topEdges.every(y => y === topEdges[0]));
    const paths = C.organizationEdges(data.root, mode, C.assignBranchColors(data.root, C.THEMES.lightMap));
    const buses = paths.filter(path => path.role === 'bus' && path.from === data.root.id);
    assert.strictEqual(buses.length, 1);
    const nums = buses[0].d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    assert.strictEqual(nums[1], nums[3], '横线保持同高');
    const branches = paths.filter(path => path.role === 'branch' && path.from === data.root.id);
    assert.strictEqual(branches.length, 3);
    assert.strictEqual(branches.filter(path => path.d.includes(' Q')).length, 2, '仅两端使用圆角');
    branches.forEach(path => {
      const child = C.findNode(data.root, path.to);
      const n = path.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
      assert.strictEqual(n[n.length - 2], child._x + child._w / 2);
      assert.strictEqual(n[n.length - 1], mode === 'org' ? child._y - 6 : child._y + child._h + 6);
    });
    data.root.collapsed = true;
    assert.strictEqual(C.organizationEdges(data.root, mode, new Map()).length, 0);
  }
});
ok('小地图投影正确处理长图留白和负坐标', () => {
  const box = {x:-50,y:20,width:1000,height:200};
  const t = C.minimapProjection(box, 200, 120);
  assert.strictEqual(t.scale, .2);
  assert.strictEqual((100 - t.x) / t.scale, 450);
  assert.strictEqual((60 - t.y) / t.scale, 120);
});

ok('单侧错位连线两端均使用圆角，各布局坐标有效', () => {
  const root = C.createNode('父', [C.createNode('子')]);
  Object.assign(root, {_x:0,_y:0,_w:40,_h:20});
  Object.assign(root.children[0], {_x:120,_y:100,_w:40,_h:20,_side:'right'});
  const edges = C.treeEdges(root, 'outline', C.assignBranchColors(root, C.THEMES.lightMap));
  assert.strictEqual(edges.filter(edge => edge.d.includes(' Q')).length, 2, '起点与终点均圆角');
  for (const mode of ['standard','right','left','compact','spacious','outline','org','up','radial']) {
    const data = sample();
    C.layoutTree(data.root, C.createMeasure('14px sans-serif'), mode);
    const paths = C.treeEdges(data.root, mode, C.assignBranchColors(data.root, C.THEMES.lightMap));
    assert.ok(paths.length > 0);
    assert.ok(paths.every(path => !/NaN|Infinity/.test(path.d)), mode);
  }
});
ok('宽父节点的子节点组居中，默认主题名称为科技蓝', () => {
  for (const mode of ['org','up']) {
    const root = C.createNode('很宽的父节点标题'.repeat(5), [C.createNode('一'),C.createNode('二')]);
    C.layoutTree(root, C.createMeasure('14px sans-serif'), mode);
    const first = root.children[0], last = root.children[1];
    assert.strictEqual((first._x + last._x + last._w) / 2, root._x + root._w / 2);
    const single = C.createNode('父节点标题'.repeat(6), [C.createNode('子')]);
    C.layoutTree(single, C.createMeasure('14px sans-serif'), mode);
    const edges = C.treeEdges(single, mode, C.assignBranchColors(single, C.THEMES.lightMap));
    assert.strictEqual(edges.length, 1);
    assert.strictEqual(edges[0].role, 'stem');
  }
  assert.strictEqual(C.THEMES.lightMap.name, '科技蓝');
});

ok('全部展开和收起遍历隐藏后代，一步撤销且保存状态', () => {
  const data = sample();
  data.root.collapsed = true;
  data.root.children[0].collapsed = true;
  data.root.children[0].style = {lineColor:'#00b96b'};
  data.relations = [{id:'link',from:data.root.children[0].id,to:data.root.children[1].id}];
  const m = new C.MindMapModel(data);
  const before = C.serialize(m.data);
  assert.ok(m.hasCollapsedBranches());
  assert.ok(m.setAllCollapsed(false));
  assert.strictEqual(m.hasCollapsedBranches(), false);
  assert.strictEqual(m.undoStack.length, 1);
  assert.strictEqual(m.setAllCollapsed(false), false);
  assert.strictEqual(m.undoStack.length, 1);
  m.undo();
  assert.strictEqual(C.serialize(m.data), before);
  m.redo();
  assert.strictEqual(m.root.children[0].style.lineColor, '#00b96b');
  assert.strictEqual(m.data.relations.length, 1);
  assert.ok(m.setAllCollapsed(true));
  assert.ok(m.root.collapsed && m.root.children[0].collapsed);
  const restored = C.parse(C.serialize(m.data));
  assert.ok(restored.root.collapsed && restored.root.children[0].collapsed);
});
ok('根节点已收起时仍能收起隐藏分支，空导图不产生撤销记录', () => {
  const m = new C.MindMapModel(sample());
  m.root.collapsed = true;
  assert.ok(m.setAllCollapsed(true));
  assert.ok(m.root.children[0].collapsed);
  m.undo();
  assert.strictEqual(m.root.children[0].collapsed, false);
  const empty = new C.MindMapModel(C.defaultData());
  assert.strictEqual(empty.setAllCollapsed(true), false);
  assert.strictEqual(empty.setAllCollapsed(false), false);
  assert.strictEqual(empty.canUndo(), false);
});

ok('远端高节点不再撑开近端表格之间的空白', () => {
  const make = (text, width, height, children = []) => Object.assign(C.createNode(text, children), {size:{width,height}});
  for (const mode of ['right','left','compact','spacious']) {
    const upper = make('上表', 300, 200), lower = make('下表', 300, 200);
    const root = make('中心', 50, 20, [make('三',80,20,[upper]),make('中间分支',600,20,[make('远端高代码',250,800)]),make('五',80,20,[lower])]);
    C.layoutTree(root, (text,node) => node.size, mode);
    const gap = lower._y - upper._y - upper._h;
    assert.ok(gap > 0 && gap < 120, mode + ' gap=' + gap);
  }
});
ok('混合宽高节点紧凑排列后仍保持节点互不重叠', () => {
  let seed = 782;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const make = depth => {
    const node = C.createNode('节点');
    node.size = {width:40 + Math.floor(random()*400),height:20 + Math.floor(random()*450)};
    if (depth < 3) for (let i=0,n=1+Math.floor(random()*3);i<n;i++) node.children.push(make(depth+1));
    return node;
  };
  for (const mode of ['right','left','standard','compact','spacious']) {
    for (let trial=0;trial<5;trial++) {
      const root = make(0);
      const {visible} = C.layoutTree(root, (text,node)=>node.size, mode);
      for (let i=0;i<visible.length;i++) for (const b of visible.slice(i+1)) {
        const a=visible[i];
        assert.ok(a._x+a._w<=b._x+.01 || b._x+b._w<=a._x+.01 || a._y+a._h<=b._y+.01 || b._y+b._h<=a._y+.01, mode + ' overlap');
      }
      const original=C.serialize({version:1,root});
      root.children[0].collapsed=true;
      C.layoutTree(root,(text,node)=>node.size,mode);
      root.children[0].collapsed=false;
      C.layoutTree(root,(text,node)=>node.size,mode);
      assert.strictEqual(C.serialize({version:1,root}),original);
    }
  }
});

ok('相邻表格保留最小间距，紧凑后的分支线不穿过节点', () => {
  const make = (text,width,height,children=[]) => Object.assign(C.createNode(text,children),{size:{width,height}});
  for (const mode of ['right','left']) {
    const a=make('表一',350,240),b=make('表二',300,180);
    const root=make('中心',70,20,[make('上',60,20,[a]),make('下',80,20,[b])]);
    const {visible}=C.layoutTree(root,(text,node)=>node.size,mode);
    assert.strictEqual(b._y-a._y-a._h,C.LAYOUT.V_GAP);
    const paths=C.treeEdges(root,mode,C.assignBranchColors(root,C.THEMES.lightMap));
    for (const path of paths) {
      let point=null;
      for (const match of path.d.matchAll(/([MLQ])([^MLQ]+)/g)) {
        const n=match[2].match(/-?\d+(?:\.\d+)?/g).map(Number);
        if (match[1]==='M') {point={x:n[0],y:n[1]};continue;}
        const start=point,end=match[1]==='Q'?{x:n[2],y:n[3]}:{x:n[0],y:n[1]};
        for(let step=1;step<=20;step++) {
          const t=step/20,u=1-t;
          const p=match[1]==='Q'?{x:u*u*start.x+2*u*t*n[0]+t*t*end.x,y:u*u*start.y+2*u*t*n[1]+t*t*end.y}:{x:start.x+(end.x-start.x)*t,y:start.y+(end.y-start.y)*t};
          assert.ok(!visible.some(node=>p.x>node._x+.1&&p.x<node._x+node._w-.1&&p.y>node._y+.1&&p.y<node._y+node._h-.1));
        }
        point=end;
      }
    }
  }
});

ok('奇数对齐中间子节点，偶数对齐中间两个节点，不受尺寸影响', () => {
  const make=(index,children=[])=>Object.assign(C.createNode('节点'+index,children),{size:{width:50+(index%5)*57,height:20+(index%4)*83}});
  for (const mode of ['right','left','standard','compact','spacious','org','up']) {
    for (const count of [1,3,5,4,6]) {
      const root=make(0,Array.from({length:count},(_,i)=>make(i+1,i===1?[make(7),make(8),make(9)]:[])));
      const {visible}=C.layoutTree(root,(text,node)=>node.size,mode);
      for (const parent of visible) {
        const groups=mode==='org'||mode==='up'?[parent.children]:[parent.children.filter(c=>c._side!=='left'),parent.children.filter(c=>c._side==='left')];
        for(const children of groups) {
          if(!children.length) continue;
          const coordinate=n=>mode==='org'||mode==='up'?n._x+n._w/2:n._y+n._h/2;
          const centers=children.map(coordinate),middle=Math.floor(centers.length/2);
          const expected=centers.length%2?centers[middle]:(centers[middle-1]+centers[middle])/2;
          assert.ok(Math.abs(coordinate(parent)-expected)<.01,mode+' count='+children.length);
        }
      }
      for(let i=0;i<visible.length;i++) for(const b of visible.slice(i+1)) {
        const a=visible[i];
        assert.ok(a._x+a._w<=b._x+.01||b._x+b._w<=a._x+.01||a._y+a._h<=b._y+.01||b._y+b._h<=a._y+.01,mode+' overlap');
      }
    }
  }
});

ok('展开表格后不会占据相邻节点外侧按钮区域', () => {
  const make=(text,width,height,children=[])=>Object.assign(C.createNode(text,children),{size:{width,height}});
  for(const mode of ['right','left','compact','standard','org','up']) {
    const table=make('展开后的表格',560,400);
    const product=make('产品定位',100,20,[table]);
    const target=make('目标用户与核心场景',200,20);
    const root=make('中心',70,20,[product,target,make('竞品参照',120,20)]);
    const {visible}=C.layoutTree(root,(text,node)=>node.size,mode);
    for(const node of visible) {
      const left=node._side==='left'?node._x-56:node._x+node._w;
      const top=node._y+node._h/2-12;
      assert.ok(!visible.some(other=>other!==node&&left<other._x+other._w-.01&&left+56>other._x+.01&&top<other._y+other._h-.01&&top+24>other._y+.01),mode+' button overlap');
    }
  }
});


ok('Markdown 图片语法和多行 HTML 图片保留路径、替代文本与尺寸，代码块不解析图片', () => {
  const source='# 图片\n<p align="center">\n<img src="resources/icon.png" alt="知枝"\n width="128" height="128" onerror="alert(1)" />\n</p>\n\n![示例](<images/my icon.png>)\n\n~~~html\n<img src="code.png">\n~~~';
  const data=C.markdownImport(source);const images=[];C.walkVisible(data.root,n=>{if(n.content?.type==='image')images.push(n);});
  assert.strictEqual(images.length,2);assert.strictEqual(images[0].content.src,'resources/icon.png');
  assert.strictEqual(images[0].content.width,128);assert.strictEqual(images[0].content.alt,'知枝');
  assert.strictEqual(images[0].content.onerror,undefined);assert.strictEqual(images[1].content.src,'images/my icon.png');
  assert.strictEqual(data.root.children.at(-1).content.type,'code');
  assert.strictEqual(C.imageInfo('![x](https://example.com/a(b).png)').src,'https://example.com/a(b).png');
});

console.log('\n全部通过：' + passed + ' 项');

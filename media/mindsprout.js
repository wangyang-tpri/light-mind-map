/* ============================================================
 * mindmap-core.js —— 思维导图纯逻辑层
 * 数据模型 / 树操作 / 布局算法 / 序列化 / 导出文本
 * 同时供 Webview 与 Node 单测加载（UMD 风格）。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MindMapCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;
  const FILE_EXTENSIONS = ['.mindmap', '.mindm'];

  /* ---------------- ID ---------------- */
  function genId() {
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------------- 数据模型 ---------------- */
  function createNode(text, children) {
    return {
      id: genId(),
      text: text == null ? '' : String(text),
      collapsed: false,
      children: children || [],
    };
  }

  function defaultData() {
    const now = new Date().toISOString();
    return {
      version: VERSION,
      meta: { createdBy: 'ThoughtWeave', createdAt: now },
      root: {
        id: genId(),
        text: '',
        collapsed: false,
        children: [],
      },
    };
  }

  function normalize(node) {
    if (!node || typeof node !== 'object') {
      throw new Error('节点格式不正确');
    }
    if (!node.id) node.id = genId();
    node.text = node.text == null ? '' : String(node.text);
    if (typeof node.collapsed !== 'boolean') node.collapsed = false;
    if (!Array.isArray(node.children)) node.children = [];
    for (let i = 0; i < node.children.length; i++) {
      node.children[i] = normalize(node.children[i]);
    }
    return node;
  }

  /** 解析文件文本为思维导图数据；失败抛出带中文信息的 Error。 */
  function parse(text) {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') {
      throw new Error('文件内容不是有效的思维导图 JSON');
    }
    if (!obj.root || typeof obj.root !== 'object') {
      throw new Error('文件缺少 root 节点');
    }
    obj.version = obj.version == null ? VERSION : obj.version;
    obj.root = normalize(obj.root);
    return obj;
  }

  function serialize(data) {
    return JSON.stringify(data, (key, value) => key.startsWith('_') ? undefined : value, 2);
  }

  /* ---------------- 树遍历工具 ---------------- */
  function findNode(root, id) {
    if (root.id === id) return root;
    for (let i = 0; i < root.children.length; i++) {
      const r = findNode(root.children[i], id);
      if (r) return r;
    }
    return null;
  }

  function findParent(root, id) {
    for (let i = 0; i < root.children.length; i++) {
      const c = root.children[i];
      if (c.id === id) return root;
      const r = findParent(c, id);
      if (r) return r;
    }
    return null;
  }

  function isDescendant(root, ancestorId, id) {
    if (ancestorId === id) return true;
    const anc = findNode(root, ancestorId);
    if (!anc) return false;
    return !!findNode(anc, id);
  }

  function countNodes(node) {
    let n = 1;
    for (let i = 0; i < node.children.length; i++) n += countNodes(node.children[i]);
    return n;
  }

  function cloneNode(node) {
    return JSON.parse(serialize(node));
  }

  /* ---------------- 模型：带撤销/重做的树操作 ---------------- */
  class MindMapModel {
    constructor(data) {
      this.data = data;
      this.undoStack = [];
      this.redoStack = [];
      this.maxStack = 100;
    }

    snapshot() {
      return cloneNode(this.data);
    }

    canUndo() {
      return this.undoStack.length > 0;
    }

    canRedo() {
      return this.redoStack.length > 0;
    }

    commit() {
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > this.maxStack) this.undoStack.shift();
      this.redoStack = [];
    }

    undo() {
      if (!this.canUndo()) return false;
      this.redoStack.push(this.snapshot());
      this.data = this.undoStack.pop();
      return true;
    }

    redo() {
      if (!this.canRedo()) return false;
      this.undoStack.push(this.snapshot());
      this.data = this.redoStack.pop();
      return true;
    }

    get root() {
      return this.data.root;
    }

    find(id) {
      return findNode(this.root, id);
    }

    /** 添加子节点；若父节点处于折叠状态则先展开。返回新节点。 */
    addChild(parentId, text) {
      const parent = findNode(this.root, parentId);
      if (!parent) return null;
      this.commit();
      if (parent.collapsed) parent.collapsed = false;
      const node = createNode(text);
      parent.children.push(node);
      return node;
    }

    /** 添加同级节点（before 为 true 时插到目标前）。根节点无同级，返回 null。 */
    addSibling(nodeId, text, before) {
      const parent = findParent(this.root, nodeId);
      if (!parent) return null;
      this.commit();
      const node = createNode(text);
      const idx = parent.children.findIndex((c) => c.id === nodeId);
      parent.children.splice(before ? idx : idx + 1, 0, node);
      return node;
    }

    /** 删除节点，其子节点自动提升为父节点子级。根节点不可删除。 */
    removeNode(nodeId) {
      const parent = findParent(this.root, nodeId);
      if (!parent) return false;
      this.commit();
      const idx = parent.children.findIndex((c) => c.id === nodeId);
      const node = parent.children.splice(idx, 1)[0];
      parent.children.splice(idx, 0, ...node.children);
      if (this.data.relations) this.data.relations = this.data.relations.filter(link => link.from !== nodeId && link.to !== nodeId);
      return true;
    }

    addRelation(from, to) {
      if (from === to || !this.find(from) || !this.find(to)) return false;
      const links = this.data.relations || [];
      if (links.some(link => (link.from === from && link.to === to) || (link.from === to && link.to === from))) return false;
      this.commit();
      this.data.relations = links.concat({ id: genId(), from, to, arrow: 'forward' });
      return true;
    }

    updateRelation(id, changes) {
      const link = (this.data.relations || []).find(item => item.id === id);
      if (!link) return false;
      const next = {};
      if (['none', 'forward', 'backward', 'both'].includes(changes.arrow)) next.arrow = changes.arrow;
      for (const key of ['control1', 'control2']) {
        if (changes[key] === null) next[key] = null;
        else if (changes[key] && Number.isFinite(changes[key].x) && Number.isFinite(changes[key].y)) next[key] = { x: changes[key].x, y: changes[key].y };
      }
      if (!Object.keys(next).some(key => JSON.stringify(link[key]) !== JSON.stringify(next[key]))) return false;
      this.commit();
      Object.assign(link, next);
      return true;
    }

    removeRelation(id) {
      const links = this.data.relations || [];
      if (!links.some(link => link.id === id)) return false;
      this.commit();
      this.data.relations = links.filter(link => link.id !== id);
      return true;
    }

    setNodeStyle(id, changes) {
      const node = this.find(id);
      if (!node) return false;
      const next = Object.assign({}, node.style);
      for (const key of ['lineColor', 'textColor', 'fontWeight']) {
        if (!(key in changes)) continue;
        const value = changes[key];
        if (value === null) delete next[key];
        else if (key === 'fontWeight' ? [400, 600, 700].includes(Number(value)) : /^#[0-9a-f]{6}$/i.test(value)) next[key] = key === 'fontWeight' ? Number(value) : value;
      }
      if (JSON.stringify(node.style || {}) === JSON.stringify(next)) return false;
      this.commit();
      node.style = next;
      return true;
    }

    setText(nodeId, text) {
      const node = findNode(this.root, nodeId);
      if (!node) return false;
      if (node.text === String(text)) return false;
      this.commit();
      node.text = String(text);
      return true;
    }

    toggleCollapse(nodeId) {
      const node = findNode(this.root, nodeId);
      if (!node || !node.children.length) return false;
      this.commit();
      node.collapsed = !node.collapsed;
      return true;
    }

    setCollapsed(nodeId, collapsed) {
      const node = findNode(this.root, nodeId);
      if (!node || !node.children.length) return false;
      if (node.collapsed === !!collapsed) return false;
      this.commit();
      node.collapsed = !!collapsed;
      return true;
    }

    hasCollapsedBranches() {
      const pending = [this.root];
      while (pending.length) {
        const node = pending.pop();
        if (node.children.length && node.collapsed) return true;
        pending.push(...node.children);
      }
      return false;
    }

    /** Update hidden descendants too, as one undoable operation. */
    setAllCollapsed(collapsed) {
      const pending = [this.root];
      const changes = [];
      while (pending.length) {
        const node = pending.pop();
        if (node.children.length && node.collapsed !== !!collapsed) changes.push(node);
        pending.push(...node.children);
      }
      if (!changes.length) return false;
      this.commit();
      changes.forEach(node => { node.collapsed = !!collapsed; });
      return true;
    }

    /**
     * 移动节点：把 nodeId 挂到 targetId 下。
     * where: 'child' 成为其子节点 | 'before' / 'after' 成为其同级。
     * 禁止移动到自身或自己的子孙下。
     */
    moveNode(nodeId, targetId, where) {
      if (nodeId === targetId) return false;
      const parent = findParent(this.root, nodeId);
      if (!parent) return false;
      if (isDescendant(this.root, nodeId, targetId)) return false;
      if (!['child', 'before', 'after'].includes(where)) return false;
      if (!findNode(this.root, targetId)) return false;
      if (where !== 'child' && !findParent(this.root, targetId)) return false;
      this.commit();
      const idx = parent.children.findIndex((c) => c.id === nodeId);
      const node = parent.children.splice(idx, 1)[0];
      if (where === 'child') {
        const target = findNode(this.root, targetId);
        if (!target) return false;
        if (target.collapsed) target.collapsed = false;
        target.children.push(node);
      } else {
        const tParent = findParent(this.root, targetId);
        if (!tParent) return false;
        const tIdx = tParent.children.findIndex((c) => c.id === targetId);
        tParent.children.splice(where === 'before' ? tIdx : tIdx + 1, 0, node);
      }
      return true;
    }

    /** 提升层级：成为父节点之后的同级节点。根节点的直接子级不可再提升。 */
    promote(nodeId) {
      const parent = findParent(this.root, nodeId);
      if (!parent || parent === this.root) return false;
      this.commit();
      const idx = parent.children.findIndex((c) => c.id === nodeId);
      const node = parent.children.splice(idx, 1)[0];
      const grand = findParent(this.root, parent.id);
      const gIdx = grand.children.indexOf(parent);
      grand.children.splice(gIdx + 1, 0, node);
      return true;
    }
  }

  /* ---------------- 布局算法 ---------------- */
  const LAYOUT = {
    H_GAP: 80, // 父节点与子节点水平间距（连线长度加倍）
    V_GAP: 16, // 同级节点垂直间距
    PAD_X: 3, // 节点水平内边距（与 CSS .mm-node padding 一致）
    PAD_Y: 5, // 节点垂直内边距（节点高度=行高20+5*2=30px）
    LINE_H: 20, // 行高
    MIN_W: 20, // 节点最小宽度
    MIN_H: 20, // 节点最小高度
  };

  /**
   * 创建文本测量器。Webview 下用 canvas 精确测量；Node 下按字符数近似。
   */
  function createMeasure(font, maxWidth) {
    let ctx = null;
    if (typeof document !== 'undefined' && document.createElement) {
      const canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d');
      if (ctx) ctx.font = font;
    }
    const mw = maxWidth || 0;
    // 单行超宽时按字符自动换行（中文可任意断行，英文也按字符断以保证不溢出）
    function wrapLine(line) {
      if (mw <= 0 || line.length === 0) return [line];
      const out = [];
      let cur = '';
      let curW = 0;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const cw = ctx ? ctx.measureText(ch).width : 13;
        if (curW + cw > mw && cur.length > 0) {
          out.push(cur);
          cur = ch;
          curW = cw;
        } else {
          cur += ch;
          curW += cw;
        }
      }
      if (cur.length > 0) out.push(cur);
      return out;
    }
    return function measureText(text) {
      const rawLines = String(text).split('\n');
      const lines = [];
      for (let i = 0; i < rawLines.length; i++) {
        const wrapped = wrapLine(rawLines[i]);
        for (let j = 0; j < wrapped.length; j++) lines.push(wrapped[j]);
      }
      let w = 0;
      for (let i = 0; i < lines.length; i++) {
        const lw = ctx ? ctx.measureText(lines[i]).width : lines[i].length * 13;
        if (lw > w) w = lw;
      }
      return {
        // +6px 余量：canvas measureText 与实际渲染有亚像素误差，避免文字被截断
        width: Math.max(Math.ceil(w) + 6, LAYOUT.MIN_W),
        height: Math.max(lines.length * LAYOUT.LINE_H, LAYOUT.MIN_H),
      };
    };
  }

  /** 计算每个节点的尺寸与子树包围盒高度（结果写入 node._w/_h/_subtreeHeight）。 */
  function calcSubtree(node, measure, settings) {
    const size = measure(node.text || '输入文本', node);
    node._w = Math.max(36, size.width + LAYOUT.PAD_X * 2 + 4);
    node._h = size.height + LAYOUT.PAD_Y * 2 + 4;
    let total = 0;
    for (let i = 0; i < node.children.length; i++) {
      total += calcSubtree(node.children[i], measure, settings).height;
    }
    if (!node.collapsed && node.children.length) {
      total += settings.V_GAP * (node.children.length - 1);
      node._subtreeHeight = Math.max(node._h, total);
    } else {
      node._subtreeHeight = node._h;
    }
    return { height: node._subtreeHeight };
  }

  function middleAnchor(centers) {
    const middle = Math.floor(centers.length / 2);
    return centers.length % 2 ? centers[middle] : (centers[middle - 1] + centers[middle]) / 2;
  }

  function placeNode(node, x, topY, side, sideOf, mode, settings) {
    // Pack actual horizontal contours, rather than treating each subtree as one
    // full rectangle. A tall block in a distant column must not reserve empty
    // space between unrelated nodes nearer the parent.
    const shift = (work, dy) => {
      work.nodes.forEach(item => { item._y += dy; });
      work.boxes.forEach(box => { box.top += dy; box.bottom += dy; });
    };
    const overlapX = (a, b) => a.left < b.right - .01 && b.left < a.right - .01;
    const build = (current, currentX, currentSide) => {
      current._x = currentX;
      current._y = -current._h / 2;
      current._side = currentSide;
      if (currentSide !== 'root') sideOf.set(current.id, currentSide);
      const result = { nodes: [current], boxes: [{ left: currentX, right: currentX + current._w, top: current._y, bottom: current._y + current._h }] };
      // Add/expand controls extend outside the text box and need their own lane.
      result.boxes.push(currentSide === 'left'
        ? {left:currentX-56,right:currentX,top:-12,bottom:12}
        : {left:currentX+current._w,right:currentX+current._w+56,top:-12,bottom:12});
      const children = current.collapsed ? [] : current.children;
      const groups = { left: [], right: [] };
      children.forEach((child, index) => {
        const childSide = mode === 'right' ? 'right' : mode === 'left' ? 'left' : currentSide === 'root' ? (index % 2 ? 'left' : 'right') : currentSide;
        groups[childSide].push(child);
      });
      for (const childSide of ['right', 'left']) {
        const siblings = groups[childSide];
        if (!siblings.length) continue;
        const placed = [];
        const occupied = [];
        for (const child of siblings) {
          const childX = childSide === 'right' ? currentX + current._w + settings.H_GAP : currentX - child._w - settings.H_GAP;
          const work = build(child, childX, childSide);
          let dy = 0;
          for (const prior of occupied) {
            for (const next of work.boxes) {
              if (overlapX(prior, next)) dy = Math.max(dy, prior.bottom + settings.V_GAP - next.top);
            }
          }
          shift(work, dy);
          occupied.push(...work.boxes);
          placed.push(work);
        }
        const center = middleAnchor(siblings.map(child => child._y + child._h / 2));
        placed.forEach(work => {
          shift(work, -center);
          result.nodes.push(...work.nodes);
          result.boxes.push(...work.boxes);
        });
        // Reserve the actual connection corridors too, so compaction never
        // moves a node across another branch's connector.
        const direction = childSide === 'right' ? 1 : -1;
        const edge = currentX + (direction > 0 ? current._w : 0);
        const childEdge = child => child._x + (direction > 0 ? 0 : child._w);
        const distance = Math.min(...siblings.map(child => Math.abs(childEdge(child) - edge)));
        const bus = edge + direction * (8 + Math.min(22, (distance - 16) / 2));
        const ys = siblings.map(child => child._y + child._h / 2);
        result.boxes.push({left: Math.min(edge, bus), right: Math.max(edge, bus), top: -10, bottom: 10});
        result.boxes.push({left: bus - 2, right: bus + 2, top: Math.min(0, ...ys), bottom: Math.max(0, ...ys)});
        siblings.forEach((child, index) => result.boxes.push({left: Math.min(bus, childEdge(child)), right: Math.max(bus, childEdge(child)), top: ys[index] - 10, bottom: ys[index] + 10}));
      }
      current._subtreeHeight = Math.max(...result.nodes.map(item => item._y + item._h)) - Math.min(...result.nodes.map(item => item._y));
      return result;
    };
    const work = build(node, x, side);
    const top = Math.min(...work.nodes.map(item => item._y));
    shift(work, topY - top);
  }

  function computeBounds(root) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    walkVisible(root, (n) => {
      if (n._x < minX) minX = n._x;
      if (n._y < minY) minY = n._y;
      if (n._x + n._w > maxX) maxX = n._x + n._w;
      if (n._y + n._h > maxY) maxY = n._y + n._h;
    });
    return { minX, minY, maxX, maxY };
  }

  /** 遍历所有可见节点（折叠子树不展开）。 */
  function walkVisible(node, fn) {
    fn(node);
    if (!node.collapsed) {
      for (let i = 0; i < node.children.length; i++) walkVisible(node.children[i], fn);
    }
  }

  /**
   * 布局整棵树。
   * @param {Function} measure 文本测量器
   * @param {string} mode 布局模式：standard（左右交替）/ right（右向树）/ left（左向树）
   * @returns {{ sideOf: Map, bounds: object, visible: Array }}
   */
  function layoutTree(root, measure, mode) {
    if (!mode) mode = 'standard';
    const settings = Object.assign({}, LAYOUT,
      mode === 'compact' ? { H_GAP: 64, V_GAP: 8 } :
      mode === 'spacious' ? { H_GAP: 120, V_GAP: 32 } : {});
    calcSubtree(root, measure, settings);
    const sideOf = new Map();
    if (mode === 'org' || mode === 'up') {
      const spans = new Map();
      const span = node => {
        const children = node.collapsed ? [] : node.children;
        let cursor = 0;
        const offsets = [];
        const centers = [];
        children.forEach(child => {
          const metric = span(child);
          offsets.push(cursor);
          centers.push(cursor + metric.center);
          cursor += metric.width + 28;
        });
        const total = children.length ? cursor - 28 : 0;
        const center = children.length ? middleAnchor(centers) : node._w / 2;
        const left = Math.min(0, center - node._w / 2);
        const right = Math.max(total, center + node._w / 2 + 56);
        const metric = { width: right - left, center: center - left, offsets: offsets.map(offset => offset - left) };
        spans.set(node.id, metric);
        return metric;
      };
      span(root);
      const heights = [];
      const scan = (node, depth) => {
        heights[depth] = Math.max(heights[depth] || 0, node._h);
        if (!node.collapsed) node.children.forEach(child => scan(child, depth + 1));
      };
      scan(root, 0);
      const rows = [0];
      for (let depth = 1; depth < heights.length; depth++) rows[depth] = rows[depth - 1] + heights[depth - 1] + 72;
      const place = (node, x, depth, isRoot) => {
        const y = rows[depth];
        const metric = spans.get(node.id);
        node._x = x + metric.center - node._w / 2;
        node._y = mode === 'up' ? -y - node._h : y;
        node._side = isRoot ? 'root' : 'right';
        if (!isRoot) sideOf.set(node.id, 'right');
        const children = node.collapsed ? [] : node.children;
        children.forEach((child, index) => {
          place(child, x + metric.offsets[index], depth + 1, false);
        });
      };
      place(root, 0, 0, true);
    } else if (mode === 'radial') {
      const weights = new Map();
      const weight = node => {
        const n = node.collapsed || !node.children.length ? 1 : node.children.reduce((sum, child) => sum + weight(child), 0);
        weights.set(node.id, n);
        return n;
      };
      weight(root);
      const nodes = [];
      walkVisible(root, node => nodes.push(node));
      const step = Math.max(...nodes.map(node => node._w + 90), nodes.length * 16);
      const place = (node, depth, start, end) => {
        const angle = (start + end) / 2;
        node._x = Math.cos(angle) * depth * step - node._w / 2;
        node._y = Math.sin(angle) * depth * step - node._h / 2;
        node._side = depth === 0 ? 'root' : (Math.cos(angle) < 0 ? 'left' : 'right');
        if (depth) sideOf.set(node.id, node._side);
        let cursor = start;
        if (!node.collapsed) node.children.forEach(child => {
          const next = cursor + (end - start) * weights.get(child.id) / weights.get(node.id);
          place(child, depth + 1, cursor, next);
          cursor = next;
        });
      };
      place(root, 0, -Math.PI, Math.PI);
    } else if (mode === 'outline') {
      let rowY = 0;
      const placeOutline = (node, x, isRoot) => {
        node._x = x;
        node._y = rowY;
        node._side = isRoot ? 'root' : 'right';
        if (!isRoot) sideOf.set(node.id, 'right');
        rowY += node._h + settings.V_GAP;
        if (!node.collapsed) node.children.forEach(child => placeOutline(child, x + node._w + settings.H_GAP, false));
      };
      placeOutline(root, 0, true);
    } else {
      placeNode(root, 0, 0, 'root', sideOf,
        ['compact', 'spacious'].includes(mode) ? 'right' : mode, settings);
    }
    const bounds = computeBounds(root);
    const visible = [];
    walkVisible(root, (n) => visible.push(n));
    return { sideOf, bounds, visible };
  }

  /** One orthogonal geometry for the canvas, thumbnails, PNG and SVG. */
  function treeEdges(root, mode, colors) {
    const result = [];
    const px = node => node._rx ?? node._x;
    const py = node => node._ry ?? node._y;
    walkVisible(root, parent => {
      const children = parent.collapsed ? [] : parent.children;
      if (!children.length) return;
      if (mode === 'radial') {
        const ax = px(parent) + parent._w / 2, ay = py(parent) + parent._h / 2;
        children.forEach(child => {
          const bx = px(child) + child._w / 2, by = py(child) + child._h / 2;
          const dx = bx - ax, dy = by - ay;
          const edge = node => Math.min(dx ? node._w / 2 / Math.abs(dx) : Infinity, dy ? node._h / 2 / Math.abs(dy) : Infinity);
          const t1 = edge(parent), t2 = edge(child);
          result.push({d:'M' + (ax + dx * t1) + ',' + (ay + dy * t1) + ' L' + (bx - dx * t2) + ',' + (by - dy * t2),color:colors.get(child.id),role:'radial',from:parent.id,to:child.id});
        });
        return;
      }
      const vertical = mode === 'org' || mode === 'up';
      const groups = vertical ? [[mode === 'up' ? -1 : 1, children]] : [
        [1, children.filter(child => child._side !== 'left')],
        [-1, children.filter(child => child._side === 'left')],
      ];
      groups.forEach(([direction, group]) => {
        if (!group.length) return;
        // u points outwards from the parent; v runs along the shared bus.
        const map = (u, v) => vertical ? [v, direction * u] : [direction * u, v];
        const command = (type, u, v) => type + map(u, v).join(',');
        const curve = (u, v, endU, endV) => ' Q' + map(u, v).join(',') + ' ' + map(endU, endV).join(',');
        const gap = vertical ? 6 : 8;
        const startU = direction * (vertical ? py(parent) + (direction > 0 ? parent._h : 0) : px(parent) + (direction > 0 ? parent._w : 0)) + gap;
        const parentV = vertical ? px(parent) + parent._w / 2 : py(parent) + parent._h / 2;
        const entries = group.map(child => ({child,
          u: direction * (vertical ? py(child) + (direction > 0 ? 0 : child._h) : px(child) + (direction > 0 ? 0 : child._w)) - gap,
          v: vertical ? px(child) + child._w / 2 : py(child) + child._h / 2,
        }));
        const add = (d, role, child) => result.push({d,color:colors.get(child ? child.id : parent.id),role,from:parent.id,...(child ? {to:child.id} : {})});
        if (entries.length === 1 && Math.abs(entries[0].v - parentV) < .01) {
          add(command('M', startU, parentV) + command(' L', entries[0].u, parentV), 'stem', entries[0].child);
          return;
        }
        const nearest = Math.min(...entries.map(entry => entry.u));
        const busU = vertical ? (startU + nearest) / 2 : startU + Math.min(22, (nearest - startU) / 2);
        const values = [parentV, ...entries.map(entry => entry.v)];
        const low = Math.min(...values), high = Math.max(...values);
        const radius = v => Math.max(0, Math.min(10, busU - startU, nearest - busU,
          ...values.filter(other => Math.abs(other - v) > .01).map(other => Math.abs(other - v) / 2)));
        const parentTurn = entries.some(entry => Math.abs(entry.v - parentV) < .01) ? 0 : parentV === low ? 1 : parentV === high ? -1 : 0;
        const parentRadius = parentTurn ? radius(parentV) : 0;
        const first = entries.find(entry => entry.v === low && entry.v < parentV);
        const last = entries.find(entry => entry.v === high && entry.v > parentV);
        // A true T junction stays straight. A two-way elbow rounds both ends.
        add(parentTurn ? command('M', startU, parentV) + command(' L', busU - parentRadius, parentV) + curve(busU, parentV, busU, parentV + parentTurn * parentRadius) : command('M', startU, parentV) + command(' L', busU, parentV), 'trunk');
        const lowTrim = parentTurn === 1 ? parentRadius : first ? radius(first.v) : 0;
        const highTrim = parentTurn === -1 ? parentRadius : last ? radius(last.v) : 0;
        add(command('M', busU, low + lowTrim) + command(' L', busU, high - highTrim), 'bus');
        entries.forEach(entry => {
          const turn = entry === first ? 1 : entry === last ? -1 : 0;
          const r = turn ? radius(entry.v) : 0;
          const d = turn ? command('M', busU, entry.v + turn * r) + curve(busU, entry.v, busU + r, entry.v) + command(' L', entry.u, entry.v) : command('M', busU, entry.v) + command(' L', entry.u, entry.v);
          add(d, 'branch', entry.child);
        });
      });
    });
    return result;
  }

  function organizationEdges(root, mode, colors) { return treeEdges(root, mode, colors); }

  function minimapProjection(bounds, width, height) {
    const scale = Math.min(width / Math.max(bounds.width, 1), height / Math.max(bounds.height, 1));
    return { scale, x: (width - bounds.width * scale) / 2 - bounds.x * scale, y: (height - bounds.height * scale) / 2 - bounds.y * scale };
  }

  function pngExportSize(width, height) {
    if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) throw new Error('导出尺寸无效');
    const scale = Math.min(3, 32760 / Math.max(width, height), Math.sqrt(64000000 / (width * height)));
    if (scale < 1) throw new Error('导图过大，请导出 SVG，放大后仍保持清晰');
    return { scale, width: Math.ceil(width * scale), height: Math.ceil(height * scale) };
  }

  /** 给每个顶级分支分配主题色；后代继承所属分支色。返回 id -> color 的 Map。 */
  function assignBranchColors(root, theme) {
    const map = new Map();
    const paint = (node, inherited) => {
      const color = /^#[0-9a-f]{6}$/i.test(node.style?.lineColor) ? node.style.lineColor : inherited;
      map.set(node.id, color);
      node.children.forEach(child => paint(child, color));
    };
    paint(root, theme.rootFill || '#3370FF');
    return map;
  }

  function resolveTextStyles(root, theme) {
    const map = new Map();
    const walk = (node, inherited) => {
      const custom = Object.assign({}, inherited);
      if (/^#[0-9a-f]{6}$/i.test(node.style?.textColor)) custom.textColor = node.style.textColor;
      if ([400, 600, 700].includes(node.style?.fontWeight)) custom.fontWeight = node.style.fontWeight;
      map.set(node.id, { textColor: custom.textColor || (node === root ? theme.rootText : theme.nodeText), fontWeight: custom.fontWeight || (node === root ? 600 : 400) });
      node.children.forEach(child => walk(child, custom));
    };
    walk(root, {});
    return map;
  }

  /** 可见节点的前序遍历顺序（含折叠子树跳过）。 */
  function visibleOrder(root) {
    const order = [];
    walkVisible(root, (n) => order.push(n));
    return order;
  }

  /* ---------------- 导出：Markdown ---------------- */
  // Only extract image data; never execute Markdown HTML.
  function imageInfo(source) {
    const html = source.match(/<img\b[^>]*>/i);
    if (html) {
      const attr = name => { const m = html[0].match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"\\n]*)"|\'([^\'\\n]*)\'|([^\\s>]+))', 'i')); return m ? (m[1] ?? m[2] ?? m[3]) : ''; };
      const src = attr('src').replace(/&amp;/g, '&');
      return src ? { src, alt: attr('alt'), width: Number(attr('width')) || undefined, height: Number(attr('height')) || undefined } : null;
    }
    const md = source.match(/!\[([^\]]*)\]\(\s*(?:<([^>]+)>|((?:[^()\s]|\([^()]*\))+))(?:\s+["'][^"']*["'])?\s*\)/);
    return md ? { src: md[2] || md[3], alt: md[1] } : null;
  }

  /** Headings form sections; indented lists become child topics. */
  function markdownImport(text, name) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Markdown 文件为空');
    const data = defaultData();
    data.root.text = name || '导入的思维导图';
    const headings = [{ level: 0, node: data.root }];
    let lists = [];
    let first = true;
    let fence = null;
    let code = [];
    let language = '';
    let paragraph = [];
    const section = () => headings[headings.length - 1].node;
    const flush = () => {
      if (paragraph.length) {
        const parent = lists.length ? lists[lists.length - 1].node : section();
        parent.children.push(createNode(paragraph.join(' ')));
        paragraph = [];
        first = false;
      }
    };
    const sourceLines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    const appendBlock = (source, type, lang) => {
      const node = createNode(source);
      node.content = { type, language: lang || '' };
      (lists.length ? lists[lists.length - 1].node : section()).children.push(node);
      first = false;
    };
    for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex++) {
      const raw = sourceLines[lineIndex];
      const line = raw.replace(/\t/g, '    ');
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) {
          appendBlock(code.join('\n'), language === 'mermaid' ? 'mermaid' : 'code', language);
          fence = null; code = []; first = false;
        } else code.push(raw);
        continue;
      }
      if (marker) { flush(); fence = marker[1]; language = line.slice(line.indexOf(marker[1]) + marker[1].length).trim().split(/\s+/)[0].toLowerCase(); continue; }
      if (/<img\b/i.test(line) || /!\[[^\]]*\]\(/.test(line)) {
        let source = line;
        while (/<img\b/i.test(source) && !/<img\b[^>]*>/i.test(source) && lineIndex + 1 < sourceLines.length) source += '\n' + sourceLines[++lineIndex];
        const info = imageInfo(source);
        if (info) {
          flush();
          const node = createNode(source.replace(/<\/?p\b[^>]*>/gi, '').trim());
          node.content = { type: 'image', ...info };
          (lists.length ? lists[lists.length - 1].node : section()).children.push(node);
          first = false; continue;
        }
      }
      if (/^\s*<\/?p(?:\s[^>]*)?>\s*$/i.test(line)) continue;
      if (line.includes('|') && lineIndex + 1 < sourceLines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(sourceLines[lineIndex + 1])) {
        flush();
        const rows = [raw, sourceLines[++lineIndex]];
        while (lineIndex + 1 < sourceLines.length && sourceLines[lineIndex + 1].trim() && sourceLines[lineIndex + 1].includes('|')) rows.push(sourceLines[++lineIndex]);
        appendBlock(rows.join('\n'), 'table');
        continue;
      }
      const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      const list = line.match(/^(\s*)(?:[-+*]|\d+[.)])\s+(.*)$/);
      if (heading) {
        flush(); lists = [];
        const level = heading[1].length;
        if (first && level === 1) {
          data.root.text = heading[2];
          headings.push({ level, node: data.root });
        } else {
          while (headings.length > 1 && headings[headings.length - 1].level >= level) headings.pop();
          const node = createNode(heading[2]);
          section().children.push(node);
          headings.push({ level, node });
        }
        first = false;
      } else if (list) {
        flush();
        const indent = list[1].length;
        while (lists.length && lists[lists.length - 1].indent >= indent) lists.pop();
        const node = createNode(list[2].replace(/^\[[ xX]\]\s*/, ''));
        (lists.length ? lists[lists.length - 1].node : section()).children.push(node);
        lists.push({ indent, node }); first = false;
      } else if (!line.trim()) {
        flush();
      } else if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flush(); lists = [];
      } else {
        if (!/^\s+/.test(line)) { flush(); lists = []; }
        paragraph.push(line.trim());
      }
    }
    flush();
    if (fence) appendBlock(code.join('\n'), language === 'mermaid' ? 'mermaid' : 'code', language);
    return data;
  }

  function markdownExport(data) {
    const lines = [];
    const walk = (node, depth) => {
      const indent = '  '.repeat(depth);
      const bullet = depth === 0 ? '# ' : '- ';
      if (node.content && depth > 0) {
        const prefix = '  '.repeat(depth);
        if (node.content.type === 'table') lines.push(prefix + '- 表格\n\n' + node.text.split('\n').map(line => prefix + '  ' + line).join('\n'));
        else lines.push(prefix + '- ' + (node.content.type === 'mermaid' ? '图表' : '代码') + '\n\n' + prefix + '  ```' + (node.content.language || '') + '\n' + node.text.split('\n').map(line => prefix + '  ' + line).join('\n') + '\n' + prefix + '  ```');
        node.children.forEach(child => walk(child, depth + 1));
        return;
      }
      const text = String(node.text).replace(/\n/g, ' ');
      lines.push(indent + bullet + text);
      if (!node.collapsed) {
        for (let i = 0; i < node.children.length; i++) walk(node.children[i], depth + 1);
      }
    };
    walk(data.root, 0);
    return lines.join('\n') + '\n';
  }

  /* ---------------- 导出：独立 HTML ---------------- */
  function htmlExport(data) {
    const json = serialize(data).replace(/</g, '\\u003c');
    const lines = [];
    lines.push('<!DOCTYPE html>');
    lines.push('<html lang="zh-CN"><head><meta charset="UTF-8"/>');
    lines.push('<meta name="viewport" content="width=device-width, initial-scale=1.0"/>');
    lines.push('<title>思络 · ThoughtWeave</title>');
    lines.push('<style>');
    lines.push(
      'html,body{margin:0;height:100%;overflow:hidden;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#fff}'
    );
    lines.push(
      '#stage{position:absolute;inset:0;overflow:hidden;cursor:grab}#stage:active{cursor:grabbing}#world{position:absolute;left:0;top:0;transform-origin:0 0}'
    );
    lines.push(
      '.node{position:absolute;box-sizing:border-box;padding:5px 5px;border-radius:8px;border:none;background:transparent;font-size:14px;color:#1F2329;line-height:20px;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;max-width:370px;cursor:pointer;transition:color .15s}'
    );
    lines.push(
      '.node.root{background:#3370FF;color:#fff;border:1.5px solid #3370FF;font-weight:600;box-shadow:0 2px 10px rgba(0,0,0,.12)}.node:hover{color:#3370FF}'
    );
    lines.push('.node .fold{position:absolute;width:20px;height:20px;border-radius:50%;background:#3370FF;border:none;color:#fff;font-size:12px;line-height:18px;text-align:center;user-select:none;cursor:pointer;display:none!important}.node:hover .fold{display:none!important}');
    lines.push('#hint{position:fixed;left:12px;bottom:10px;font-size:12px;color:#9AA0A6}');
    lines.push('</style></head><body>');
    lines.push('<div id="stage"><div id="world"></div></div>');
    lines.push('<div id="hint">滚轮缩放 · 拖拽平移</div>');
    lines.push('<script>');
    lines.push('var DATA=' + json + ';');
    lines.push(
      '(function(){var HG=80,VG=8,PX=5,PY=5,LH=20,MINW=20,MINH=20,MW=360;function m(t){var raw=String(t).split("\\n"),lines=[];for(var i=0;i<raw.length;i++){var line=raw[i];if(line.length*14<=MW||line.length===0){lines.push(line);}else{var cur="",curW=0;for(var j=0;j<line.length;j++){var ch=line[j],cw=14;if(curW+cw>MW&&cur.length>0){lines.push(cur);cur=ch;curW=cw;}else{cur+=ch;curW+=cw;}}if(cur.length>0)lines.push(cur);}}var w=0;for(var k=0;k<lines.length;k++){var c=lines[k].length*14;if(c>w)w=c;}return{width:Math.max(w+6,MINW)+PX*2,height:Math.max(lines.length*LH,MINH)+PY*2};}'
    );
    lines.push(
      'function cs(n){var s=m(n.text);n.w=s.width;n.h=s.height;var t=0;for(var i=0;i<n.children.length;i++)t+=cs(n.children[i]).h;if(!n.collapsed&&n.children.length){t+=VG*(n.children.length-1);n.sh=Math.max(n.h,t);}else n.sh=n.h;return{height:n.sh};}'
    );
    lines.push(
      'function pl(n,x,y,side){var ny=y+Math.max(0,n.sh-n.h)/2;n.x=x;n.y=ny;n.side=side;var ch=n.collapsed?[]:n.children;if(!ch.length)return;var t=0;for(var i=0;i<ch.length;i++)t+=ch[i].sh;t+=VG*(ch.length-1);var cy=ny+n.h/2,yc=cy-t/2;for(var i=0;i<ch.length;i++){var s=side==="root"?(i%2===0?"right":"left"):side;var cx=s==="right"?x+n.w+HG:x-ch[i].w-HG;pl(ch[i],cx,yc,s);yc+=ch[i].sh+VG;}}'
    );
    lines.push(
      'var PAL=["#3370FF","#34C724","#FF9A2E","#F53F3F","#722ED1","#13C2C2","#EB2F96","#00B96B"];cs(DATA.root);pl(DATA.root,0,0,"root");'
    );
    lines.push(
      'var ns=[],mx=1e9,my=1e9,MX=-1e9,MY=-1e9;(function w(n){ns.push(n);if(n.x<mx)mx=n.x;if(n.y<my)my=n.y;if(n.x+n.w>MX)MX=n.x+n.w;if(n.y+n.h>MY)MY=n.y+n.h;if(!n.collapsed)n.children.forEach(w);})(DATA.root);'
    );
    lines.push(
      'var world=document.getElementById("world");var svg="<svg style=\\"position:absolute;left:0;top:0\\" width=\\""+(MX-mx+200)+"\\" height=\\""+(MY-my+200)+"\\">";'
    );
    // 分支着色：为每个顶级分支按数组顺序取色
    lines.push(
      'var BCOL={};DATA.root.children.forEach(function(c,i){var cc=PAL[i%PAL.length];(function paint(n){BCOL[n.id]=cc;n.children.forEach(paint);})(c);});BCOL[DATA.root.id]="#3370FF";'
    );
    lines.push(
      'function edge(p,c){}'
    );
    lines.push(
      '(function draw(n){var ch=n.collapsed?[]:n.children;if(ch.length){var sides={right:[],left:[]};ch.forEach(function(c){var s=c.side==="left"?"left":"right";sides[s].push(c);});["right","left"].forEach(function(side){var sc=sides[side];if(!sc.length)return;var dir=side==="right"?1:-1;var px=dir===1?n.x+n.w:n.x;var py=n.y+n.h/2;var minCY=1e9,maxCY=-1e9;sc.forEach(function(c){var cy=c.y+c.h/2;if(cy<minCY)minCY=cy;if(cy>maxCY)maxCY=cy;});if(sc.length===1&&Math.abs(py-(sc[0].y+sc[0].h/2))<4){var c0=sc[0];var cx0=dir===1?c0.x:c0.x+c0.w;svg+=\'<path d="M\'+(px+dir*8)+\',\'+py+\' L\'+(cx0-dir*8)+\',\'+py+\'" fill="none" stroke="\'+(BCOL[c0.id]||"#3370FF")+\'" stroke-width="2" stroke-linecap="round"/>\';}else{var firstCX=dir===1?sc[0].x:sc[0].x+sc[0].w;var dx=Math.abs(firstCX-px);var seg=Math.min(22,Math.max(4,dx/2-8-2));var r=Math.min(14,Math.max(3,seg*0.6));var bx=px+dir*(8+seg);var sx=px+dir*8;var q1x=bx-dir*r;var trunk=\'M\'+sx+\',\'+py+\' L\'+q1x+\',\'+py;if(minCY<py-1)trunk+=\' Q\'+bx+\',\'+py+\' \'+bx+\',\'+(py-r)+\' L\'+bx+\',\'+(minCY+r);if(maxCY>py+1)trunk+=\' M\'+q1x+\',\'+py+\' Q\'+bx+\',\'+py+\' \'+bx+\',\'+(py+r)+\' L\'+bx+\',\'+(maxCY-r);svg+=\'<path d="\'+trunk+\'" fill="none" stroke="\'+(BCOL[n.id]||"#3370FF")+\'" stroke-width="2" stroke-linecap="round"/>\';sc.forEach(function(c){var cy=c.y+c.h/2;var cx=dir===1?c.x:c.x+c.w;var ex=cx-dir*8;var q2x=bx+dir*r;var vStart=cy<py?cy+r:cy-r;svg+=\'<path d="M\'+bx+\',\'+vStart+\' Q\'+bx+\',\'+cy+\' \'+q2x+\',\'+cy+\' L\'+ex+\',\'+cy+\'" fill="none" stroke="\'+(BCOL[c.id]||"#3370FF")+\'" stroke-width="2" stroke-linecap="round"/>\';});}});}n.children.forEach(function(c){c._p=n;draw(c);});})(DATA.root);svg+="</svg>";world.innerHTML=svg;'
    );
    lines.push(
      'ns.forEach(function(n){var d=document.createElement("div");d.className="node"+(n.side==="root"?" root":"");d.style.left=(n.x-mx+100)+"px";d.style.top=(n.y-my+100)+"px";d.style.width=n.w+"px";d.style.minHeight=n.h+"px";d.textContent=n.text;d.dataset.id=n.id;if(n.children.length){var f=document.createElement("span");f.className="fold";f.textContent=n.collapsed?"→":"←";f.style.left=(n.side==="left"?(-24):(n.w+4))+"px";f.style.top=(n.h/2-10)+"px";f.onclick=function(e){e.stopPropagation();n.collapsed=!n.collapsed;location.reload();};d.appendChild(f);}world.appendChild(d);});'
    );
    lines.push(
      'var stage=document.getElementById("stage"),scale=1,px=0,py=0;world.style.transform="translate("+px+"px,"+py+"px) scale("+scale+")";'
    );
    lines.push(
      'stage.addEventListener("wheel",function(e){e.preventDefault();if(e.ctrlKey){var r=stage.getBoundingClientRect(),cx=e.clientX-r.left,cy=e.clientY-r.top;var ns=Math.max(.2,Math.min(2.5,scale*(e.deltaY<0?1.1:.9)));px=cx-(cx-px)/scale*ns;py=cy-(cy-py)/scale*ns;scale=ns;}else{px-=e.deltaX;py-=e.deltaY;}world.style.transform="translate("+px+"px,"+py+"px) scale("+scale+")";},{passive:false});'
    );
    lines.push(
      'var drag=false,sx=0,sy=0,opx=0,opy=0;stage.addEventListener("mousedown",function(e){drag=true;sx=e.clientX;sy=e.clientY;opx=px;opy=py;});window.addEventListener("mousemove",function(e){if(!drag)return;px=opx+e.clientX-sx;py=opy+e.clientY-sy;world.style.transform="translate("+px+"px,"+py+"px) scale("+scale+")";});window.addEventListener("mouseup",function(){drag=false;});'
    );
    lines.push('})();');
    lines.push('</script></body></html>');
    return lines.join('\n');
  }

  /* ---------------- 主题 ---------------- */
  const THEMES = {
    lightMap: {
      name: '科技蓝',
      canvas: '#FFFFFF',
      rootFill: '#3370FF',
      rootText: '#FFFFFF',
      nodeFill: '#FFFFFF',
      nodeBorder: '#E5E6EB',
      nodeText: '#1F2329',
      hoverBorder: '#3370FF',
      selectedBorder: '#3370FF',
      selectedBg: 'rgba(51,112,255,0.08)',
      selectedGlow: 'rgba(51,112,255,.18)',
      collapseBg: '#FFFFFF',
      collapseBorder: '#C9CDD4',
      collapseText: '#646A73',
      branch: ['#3370FF', '#34C724', '#FF9A2E', '#F53F3F', '#722ED1', '#13C2C2', '#EB2F96', '#00B96B'],
    },
    fresh: {
      name: '清新绿',
      canvas: '#FAFDF9',
      rootFill: '#00B96B',
      rootText: '#FFFFFF',
      nodeFill: '#FFFFFF',
      nodeBorder: '#DCEDE3',
      nodeText: '#1F2D25',
      hoverBorder: '#00B96B',
      selectedBorder: '#00B96B',
      selectedBg: 'rgba(0,185,107,0.08)',
      selectedGlow: 'rgba(0,185,107,.16)',
      collapseBg: '#FFFFFF',
      collapseBorder: '#BFD9CC',
      collapseText: '#4E7A66',
      branch: ['#00B96B', '#4CB6AC', '#F7BA1E', '#5B8FF9', '#61DDAA', '#757EFF', '#F6903D', '#8ABB3B'],
    },
    night: {
      name: '深色夜间',
      canvas: '#1E1F24',
      rootFill: '#3D7EFF',
      rootText: '#FFFFFF',
      nodeFill: '#2A2B31',
      nodeBorder: '#3C3D45',
      nodeText: '#E8E9EB',
      hoverBorder: '#3D7EFF',
      selectedBorder: '#3D7EFF',
      selectedBg: 'rgba(61,126,255,0.15)',
      selectedGlow: 'rgba(61,126,255,.22)',
      collapseBg: '#2A2B31',
      collapseBorder: '#4A4B54',
      collapseText: '#B9BAC2',
      branch: ['#3D7EFF', '#34C759', '#FFB020', '#FF5D5D', '#AF52DE', '#4FD8EB', '#FF6482', '#30D158'],
    },
  };

  /* ---------------- 对外导出 ---------------- */
  return {
    VERSION,
    pngExportSize,
    organizationEdges,
    treeEdges,
    minimapProjection,
    FILE_EXTENSIONS,
    genId,
    createNode,
    defaultData,
    normalize,
    parse,
    serialize,
    findNode,
    findParent,
    isDescendant,
    countNodes,
    cloneNode,
    MindMapModel,
    LAYOUT,
    createMeasure,
    layoutTree,
    assignBranchColors,
    resolveTextStyles,
    visibleOrder,
    walkVisible,
    markdownExport,
    markdownImport, imageInfo,
    htmlExport,
    THEMES,
  };
});

;
(function () {
  'use strict';
  const cache = new Map();
  let sequence = 0;
  let imageLoader = src => Promise.resolve(src);
  const setImageLoader = loader => { imageLoader = loader; };
  function resetImages() { for (const [key, record] of cache) if (record.info) cache.delete(key); }

  try { if (window.mermaid) window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, flowchart: { htmlLabels: false }, theme: 'neutral' }); } catch (error) { console.warn('Mermaid 初始化失败', error); }
  const keyOf = node => JSON.stringify([node.content?.type === 'image' ? 'image' : node.content, node.text]);
  function tableRows(source) {
    return source.trim().split('\n').filter((_, i) => i !== 1).map(line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|')));
  }
  function element(node) {
    const box = document.createElement('div');
    box.className = 'mm-rich mm-rich-' + node.content.type;
    if (node._textStyle) {
      box.style.color = node._textStyle.textColor;
      box.style.fontWeight = String(node._textStyle.fontWeight);
      box.style.setProperty('--node-text', node._textStyle.textColor);
    }
    if (node.content.type === 'image') {
      const record = cache.get(keyOf(node));
      if (record?.image) {
        const img = document.createElement('img'); img.src = record.image.src;
        img.alt = record.info.alt || '图片';
        const width = Math.min(520, Math.max(1, record.info.width || record.image.naturalWidth || 256));
        img.style.width = width + 'px';
        if (record.info.height) img.style.height = Math.min(520, record.info.height) + 'px';
        box.appendChild(img);
      } else {
        const status = document.createElement('div'); status.className = 'mm-image-status';
        status.textContent = record?.error ? '图片加载失败 · ' + record.error : '图片加载中…';
        box.appendChild(status);
      }
    } else if (node.content.type === 'table') {
      const table = document.createElement('table');
      tableRows(node.text).forEach((cells, i) => {
        const row = document.createElement('tr');
        cells.forEach(value => { const cell = document.createElement(i ? 'td' : 'th'); cell.textContent = value; row.appendChild(cell); });
        table.appendChild(row);
      });
      box.appendChild(table);
    } else if (node.content.type === 'mermaid' && cache.get(keyOf(node))?.svg) {
      box.innerHTML = cache.get(keyOf(node)).svg;
    } else {
      const label = document.createElement('div');
      label.className = 'mm-code-label';
      label.textContent = node.content.type === 'mermaid' ? (cache.get(keyOf(node))?.error ? 'Mermaid 语法错误 · 双击修改源码' : 'Mermaid 图表加载中…') : (node.content.language || '代码');
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = node.text;
      pre.appendChild(code); box.append(label, pre);
    }
    if (node._textStyle) {
      box.querySelectorAll('pre,td,th').forEach(el => { el.style.fontWeight = String(el.tagName === 'TH' ? Math.max(600, node._textStyle.fontWeight) : node._textStyle.fontWeight); });
    }
    return box;
  }
  function prepare(root, changed) {
    const visit = node => {
      if (node.content) {
        const key = keyOf(node);
        if (!cache.has(key)) {
          const record = {};
          cache.set(key, record);
          if (node.content.type === 'image') {
            const info = window.MindMapCore.imageInfo(node.text) || node.content;
            record.info = info;
            record.ready = Promise.resolve().then(() => {
              if (!info.src || /^(?:javascript|vbscript):/i.test(info.src)) throw new Error('不支持的图片地址');
              const embedded = node.content.source === info.src && node.content.data;
              return embedded || (/^data:image\/(png|jpeg|gif|webp|svg\+xml|bmp|avif)[;,]/i.test(info.src) ? info.src : imageLoader(info.src));
            }).then(src => new Promise((resolve, reject) => {
              const image = new Image();
              image.onload = () => { record.image = image; node.content.data = src; node.content.source = info.src; resolve(); };
              image.onerror = () => reject(new Error('图片无法解码'));
              image.src = src;
            })).catch(error => { record.error = error.message; }).then(() => changed());
          } else if (node.content.type === 'mermaid') {
            if (window.mermaid) {
              window.mermaid.render('mm-diagram-' + (++sequence), node.text).then(result => {
                record.svg = result.svg;
                record.ready = new Promise(resolve => {
                  const image = new Image();
                  image.onload = () => { record.image = image; resolve(); };
                  image.onerror = () => resolve();
                  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(result.svg);
                });
                changed();
              }).catch(() => { record.error = true; changed(); });
            } else record.error = true;
          }
        }
        const probe = element(node);
        probe.classList.add('mm-rich-probe');
        document.body.appendChild(probe);
        const rect = probe.getBoundingClientRect();
        node._richSize = { width: Math.max(160, Math.ceil(rect.width)), height: Math.max(44, Math.ceil(rect.height)) };
        probe.remove();
      }
      if (!node.collapsed) node.children.forEach(visit);
    };
    visit(root);
  }
  function svg(node) { return cache.get(keyOf(node))?.svg; }
  function exportSvg(world, bounds, background) {
    const ns = 'http://www.w3.org/2000/svg';
    const root = document.createElementNS(ns, 'svg');
    root.setAttribute('width', bounds.width);
    root.setAttribute('height', bounds.height);
    root.setAttribute('viewBox', [bounds.x, bounds.y, bounds.width, bounds.height].join(' '));
    root.setAttribute('style', document.body.style.cssText);
    const style = document.createElementNS(ns, 'style');
    style.textContent = Array.from(document.styleSheets).flatMap(sheet => {
      try { return Array.from(sheet.cssRules, rule => rule.cssText); } catch (_) { return []; }
    }).join('\n');
    root.appendChild(style);
    const rect = document.createElementNS(ns, 'rect');
    for (const [key, value] of Object.entries({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, fill: background })) rect.setAttribute(key, value);
    root.appendChild(rect);
    const edges = world.querySelector('#edges').cloneNode(true);
    edges.querySelectorAll('.relation-handle,.relation-guide').forEach(el => el.remove());
    // Use a group to keep paths in world coordinates without a nested SVG viewport.
    const group = document.createElementNS(ns, 'g');
    while (edges.firstChild) group.appendChild(edges.firstChild);
    root.appendChild(group);
    world.querySelectorAll('.mm-node').forEach(node => {
      const object = document.createElementNS(ns, 'foreignObject');
      object.setAttribute('x', parseFloat(node.style.left));
      object.setAttribute('y', parseFloat(node.style.top));
      object.setAttribute('width', parseFloat(node.style.width));
      object.setAttribute('height', parseFloat(node.style.height));
      const clone = node.cloneNode(true);
      clone.classList.remove('selected', 'editing', 'dragging');
      clone.querySelectorAll('.mm-collapse,.mm-add-btn,.mm-editor').forEach(el => el.remove());
      clone.style.position = 'relative'; clone.style.left = '0'; clone.style.top = '0';
      object.appendChild(clone); root.appendChild(object);
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(root);
  }
  function html(world) {
    const clone = world.cloneNode(true);
    clone.style.transform = 'none'; clone.style.zoom = '1'; clone.style.left = '0'; clone.style.top = '0';
    clone.querySelectorAll('.mm-collapse,.mm-add-btn,.mm-editor,.relation-handle,.relation-guide').forEach(el => el.remove());
    clone.querySelectorAll('.mm-node').forEach(el => el.classList.remove('selected', 'editing'));
    const css = Array.from(document.styleSheets).flatMap(sheet => {
      try { return Array.from(sheet.cssRules, rule => rule.cssText); } catch (_) { return []; }
    }).join('\n');
    const navigation = '(function(){const w=document.getElementById("world");let x=40,y=40,z=1,drag=null;const draw=()=>{w.style.zoom=z;w.style.left=x/z+"px";w.style.top=y/z+"px";};document.addEventListener("wheel",e=>{e.preventDefault();const next=Math.max(.2,Math.min(3,z*(e.deltaY<0?1.1:1/1.1)));x=e.clientX-(e.clientX-x)*next/z;y=e.clientY-(e.clientY-y)*next/z;z=next;draw();},{passive:false});document.addEventListener("pointerdown",e=>{if(e.button===0)drag={x:e.clientX,y:e.clientY,px:x,py:y};});document.addEventListener("pointermove",e=>{if(drag){x=drag.px+e.clientX-drag.x;y=drag.py+e.clientY-drag.y;draw();}});document.addEventListener("pointerup",()=>drag=null);document.addEventListener("pointercancel",()=>drag=null);draw();})();';
    return '<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>思络 · ThoughtWeave</title><style>' + css + '\nhtml,body{overflow:hidden;min-height:100%;}#world{position:absolute;margin:0;}#edges{pointer-events:none;}</style><body style="' + document.body.style.cssText + '">' + clone.outerHTML + '<script>' + navigation + '</script></body></html>';
  }
  function prepareImages(nodes) { return Promise.all(nodes.map(node => cache.get(keyOf(node))?.ready)); }
  function draw(ctx, node, x, y, scale) {
    const probe = element(node);
    probe.classList.add('mm-rich-probe');
    document.body.appendChild(probe);
    const box = probe.getBoundingClientRect();
    ctx.save();
    ctx.translate(x + 5 * scale, y + 7 * scale);
    ctx.scale(scale, scale);
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    const write = (text, left, top, width, font, color) => {
      ctx.font = (node._textStyle?.fontWeight || 400) + ' ' + font.replace(/^600 /, ''); ctx.fillStyle = node._textStyle?.textColor || color;
      let row = '', line = 0;
      for (const ch of text) {
        if (ch === '\n' || (row && ctx.measureText(row + ch).width > width)) {
          ctx.fillText(row, left, top + line++ * 20); row = '';
        }
        if (ch !== '\n') row += ch;
      }
      ctx.fillText(row, left, top + line * 20);
    };
    const image = cache.get(keyOf(node))?.image;
    if (node.content.type === 'image' && image) {
      const img = probe.querySelector('img'); const rect = img.getBoundingClientRect();
      ctx.drawImage(image, rect.left - box.left, rect.top - box.top, rect.width, rect.height);
    } else if (node.content.type === 'mermaid' && image) ctx.drawImage(image, 0, 0, box.width, box.height);
    else if (node.content.type === 'table') {
      probe.querySelectorAll('th,td').forEach(cell => {
        const r = cell.getBoundingClientRect(), left = r.left - box.left, top = r.top - box.top;
        ctx.fillStyle = cell.tagName === 'TH' ? '#edf3ff' : '#ffffff';
        ctx.fillRect(left, top, r.width, r.height);
        ctx.strokeStyle = '#dfe3e9'; ctx.lineWidth = 1; ctx.strokeRect(left, top, r.width, r.height);
        write(cell.textContent, left + 10, top + 7, r.width - 20, '14px sans-serif', '#1f2329');
      });
    } else {
      ctx.fillStyle = '#f3f5f8'; ctx.fillRect(0, 0, box.width, box.height);
      write(node.content.language || '代码', 10, 2, box.width - 20, '11px sans-serif', '#8f959e');
      write(node.text, 12, 28, box.width - 24, '13px Consolas, monospace', '#1f2329');
    }
    ctx.restore(); probe.remove();
  }
  window.MindMapRich = { setImageLoader, resetImages, element, prepare, tableRows, svg, prepareImages, draw, html, exportSvg };
})();

;
﻿/* ============================================================
 * mindmap.js —— 思维导图 Webview UI 层
 * 渲染（节点/贝塞尔连线）、平移缩放、节点编辑、键盘导航、
 * 拖拽调整结构、折叠/展开、撤销重做、自动保存、导出。
 * 纯逻辑在 core.js（window.MindMapCore）。
 * ============================================================ */
(function () {
  'use strict';

  const C = window.MindMapCore;
  const vscode = window.mindSproutHost || acquireVsCodeApi();
  const imageRequests = new Map();
  let imageSequence = 0;
  window.MindMapRich?.setImageLoader?.(src => new Promise((resolve, reject) => {
    const requestId = 'image-' + (++imageSequence);
    const timer = setTimeout(() => { imageRequests.delete(requestId); reject(new Error('图片加载超时')); }, 25000);
    imageRequests.set(requestId, {resolve, reject, timer});
    vscode.postMessage({type:'resolve-image', requestId, src});
  }));
  const FONT = '14px -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

  /* ---------------- 状态 ---------------- */
  let model = null;
  let readOnly = false;
  let theme = C.THEMES.lightMap;
  let selectedId = null;
  let editingId = null;
  let layout = null; // { sideOf, bounds, visible }
  let branchColors = new Map();
  let textStyles = new Map();
  let measure = null;
  let fileName = '思络.mindmap';
  let scale = 1;
  let pan = { x: 0, y: 0 };
  let saveTimer = null;
  let isDirty = false;
  let spaceHeld = false;
  let dragState = null; // { id, startX, startY, moved, isRoot }
  let panState = null; // { startX, startY, panX, panY }
  let dropTarget = null;
  let toastTimer = null;
  let fittedOnce = false;
  let relationSource = null;
  let selectedRelationId = null;
  let relationDrag = null;
  let layoutMode = 'right'; // standard / right / left

  /* ---------------- DOM ---------------- */
  const canvasWrap = document.getElementById('canvas-wrap');
  const world = document.getElementById('world');
  const edgesSvg = document.getElementById('edges');
  const nodesLayer = document.getElementById('nodes');
  const zoomLabel = document.getElementById('zoom-label');
  // SVG 工具栏：标签保留给辅助技术，悬停和键盘聚焦显示提示。
  const toolbar = document.getElementById('toolbar');
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '思络 · ThoughtWeave 工具栏');
  toolbar.setAttribute('aria-orientation', 'vertical');
  const toolIcons = {
    'add-child': 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM17 13v8m-4-4h8',
    'import-markdown': 'M14 3H5v18h14V8zM14 3v5h5M8 13l4 4 4-4m-4-3v7',
    'toggle-all-nodes': 'M4 4h6v6H4zM14 14h6v6h-6zM14 4h6v6h-6zM4 14h6v6H4z',
    undo: 'M9 5L4 10l5 5M4 10h10a6 6 0 0 1 0 12',
    redo: 'M15 5l5 5-5 5M20 10H10a6 6 0 0 0 0 12',
    'zoom-out': 'M21 21l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0M7 10h6',
    'zoom-reset': 'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 8h8v8H8z',
    'zoom-in': 'M21 21l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0M7 10h6m-3-3v6',
    fit: 'M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6M8 8h8v8H8z',
    'layout-toggle': 'M9 3h6v5H9zM2 16h6v5H2zM16 16h6v5h-6zM12 8v4M5 16v-4h14v4',
    'style-toggle': 'M4 20L17 7l3 3L7 23zM14 4l3-3 6 6-3 3M3 3h7M6.5 3v10',
    'theme-toggle': 'M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 1-4 2 2 0 0 1 1-4h2a3 3 0 0 0 3-3c0-4-4-7-9-7M7 9h.01M10 6h.01M15 6h.01M18 9h.01',
    'export-toggle': 'M12 15V3m-4 4 4-4 4 4M5 13v8h14v-8'
  };
  toolbar.querySelectorAll(':scope > button, :scope > .tb-dropdown > button').forEach(button => {
    const label = button.textContent.replace(' ▾', '').trim();
    button.dataset.tooltip = button.title || label;
    button.removeAttribute('title');
    button.setAttribute('aria-label', label);
    button.classList.add('tb-tool');
    button.replaceChildren();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', toolIcons[button.dataset.action]); svg.appendChild(path); button.appendChild(svg);
    const caption = document.createElement('span'); caption.className = 'tool-label'; caption.textContent = label; button.appendChild(caption);
    if (button.parentElement.classList.contains('tb-dropdown')) {
      button.setAttribute('aria-haspopup', 'true'); button.setAttribute('aria-expanded', 'false');
    }
  });
  const toolTip = document.createElement('div'); toolTip.id = 'toolbar-tooltip'; toolTip.setAttribute('role', 'tooltip'); toolTip.hidden = true; document.body.appendChild(toolTip);
  function hideToolTip() { toolTip.hidden = true; toolbar.querySelectorAll('[aria-describedby="toolbar-tooltip"]').forEach(b => b.removeAttribute('aria-describedby')); }
  function showToolTip(button) {
    if (!button || !button.classList.contains('tb-tool')) return;
    hideToolTip();
    toolTip.textContent = button.dataset.tooltip;
    button.setAttribute('aria-describedby', 'toolbar-tooltip'); toolTip.hidden = false;
    const rect = button.getBoundingClientRect();
    toolTip.style.left = Math.min(rect.right + 16, window.innerWidth - toolTip.offsetWidth - 8) + 'px';
    toolTip.style.top = Math.max(8, Math.min(rect.top + (rect.height - toolTip.offsetHeight) / 2, window.innerHeight - toolTip.offsetHeight - 8)) + 'px';
  }
  toolbar.addEventListener('pointerover', e => showToolTip(e.target.closest('.tb-tool')));
  toolbar.addEventListener('pointerout', e => { if (!e.relatedTarget || !e.target.closest('.tb-tool')?.contains(e.relatedTarget)) hideToolTip(); });
  toolbar.addEventListener('focusin', e => showToolTip(e.target.closest('.tb-tool')));
  toolbar.addEventListener('focusout', hideToolTip);
  toolbar.addEventListener('pointerdown', hideToolTip);
  toolbar.addEventListener('scroll', () => { hideToolTip(); toggleMenu('', true); });
  window.addEventListener('resize', () => { hideToolTip(); toggleMenu('', true); });
  window.addEventListener('keydown', e => { if (e.key === 'Escape') hideToolTip(); }, true);
  const statusText = document.getElementById('status-text');
  const statusCount = document.getElementById('status-count');
  const toastEl = document.getElementById('toast');
  const indicator = document.getElementById('drag-indicator');
  const ghost = document.createElement('div');
  ghost.id = 'ghost';
  document.body.appendChild(ghost);

  const svgNamespace = 'http://www.w3.org/2000/svg';
  const minimap = document.createElement('aside');
  minimap.id = 'minimap';
  minimap.setAttribute('aria-label', '思络 · ThoughtWeave 小地图');
  minimap.innerHTML = '<div class="minimap-header"><span>小地图</span><button type="button" id="minimap-fit" title="适应整个导图">适应</button><button type="button" id="minimap-toggle" title="收起小地图" aria-expanded="true">−</button></div>';
  const minimapSvg = document.createElementNS(svgNamespace, 'svg');
  minimapSvg.id = 'minimap-canvas';
  minimapSvg.setAttribute('tabindex', '0');
  minimapSvg.setAttribute('role', 'application');
  minimapSvg.setAttribute('aria-label', '点击定位或拖动视口，方向键平移画布');
  minimap.appendChild(minimapSvg);
  canvasWrap.appendChild(minimap);
  let minimapBounds = null;
  let minimapDrag = null;

  function updateMinimapViewport() {
    if (!model || !layout) return;
    const viewport = minimapSvg.querySelector('.minimap-viewport');
    if (!viewport) return;
    const rect = canvasWrap.getBoundingClientRect();
    viewport.setAttribute('x', -pan.x / scale);
    viewport.setAttribute('y', -pan.y / scale);
    viewport.setAttribute('width', Math.max(0, rect.width / scale));
    viewport.setAttribute('height', Math.max(0, rect.height / scale));
  }

  function updateMinimap() {
    if (!model || !layout) return;
    const { box, minX, minY } = exportBounds();
    minimapBounds = { x: minX, y: minY, width: box.w, height: box.h };
    minimapSvg.setAttribute('viewBox', [minX, minY, box.w, box.h].join(' '));
    minimapSvg.replaceChildren();
    const lines = document.createElementNS(svgNamespace, 'g');
    lines.setAttribute('class', 'minimap-edges');
    edgesSvg.querySelectorAll(':scope > path:not(.relation-guide)').forEach(path => {
      const copy = path.cloneNode(false);
      copy.removeAttribute('marker-start'); copy.removeAttribute('marker-end');
      copy.removeAttribute('class');
      copy.setAttribute('vector-effect', 'non-scaling-stroke');
      copy.setAttribute('stroke-width', '0.7');
      lines.appendChild(copy);
    });
    minimapSvg.appendChild(lines);
    const nodes = document.createElementNS(svgNamespace, 'g');
    nodes.setAttribute('class', 'minimap-nodes');
    layout.visible.forEach(node => {
      const rect = document.createElementNS(svgNamespace, 'rect');
      for (const [key, value] of Object.entries({ x: node._rx, y: node._ry, width: node._w, height: node._h, rx: 4, fill: branchColors.get(node.id) })) rect.setAttribute(key, value);
      rect.setAttribute('opacity', node === model.root ? '1' : '.55');
      nodes.appendChild(rect);
    });
    minimapSvg.appendChild(nodes);
    const viewport = document.createElementNS(svgNamespace, 'rect');
    viewport.setAttribute('class', 'minimap-viewport');
    viewport.setAttribute('vector-effect', 'non-scaling-stroke');
    minimapSvg.appendChild(viewport);
    updateMinimapViewport();
  }

  function minimapPoint(event) {
    const rect = minimapSvg.getBoundingClientRect();
    if (!minimapBounds || !rect.width || !rect.height) return null;
    const transform = C.minimapProjection(minimapBounds, rect.width, rect.height);
    return { x: (event.clientX - rect.left - transform.x) / transform.scale, y: (event.clientY - rect.top - transform.y) / transform.scale };
  }

  function moveFromMinimap(event) {
    const point = minimapPoint(event);
    if (!point || !minimapDrag) return;
    const rect = canvasWrap.getBoundingClientRect();
    pan.x = rect.width / 2 - (point.x - minimapDrag.x) * scale;
    pan.y = rect.height / 2 - (point.y - minimapDrag.y) * scale;
    applyTransform();
  }

  minimap.addEventListener('pointerdown', event => event.stopPropagation());
  minimapSvg.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !layout) return;
    event.preventDefault(); event.stopPropagation();
    if (editingId) commitEdit();
    const point = minimapPoint(event);
    if (!point) return;
    const rect = canvasWrap.getBoundingClientRect();
    const onViewport = event.target.classList.contains('minimap-viewport');
    minimapDrag = onViewport ? { x: point.x - (rect.width / 2 - pan.x) / scale, y: point.y - (rect.height / 2 - pan.y) / scale } : { x: 0, y: 0 };
    if (event.isTrusted) minimapSvg.setPointerCapture?.(event.pointerId);
    moveFromMinimap(event);
  });
  minimapSvg.addEventListener('keydown', event => {
    const movement = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[event.key];
    if (!movement || !layout) return;
    event.preventDefault(); event.stopPropagation();
    pan.x += movement[0]; pan.y += movement[1]; applyTransform();
  });
  document.getElementById('minimap-fit').addEventListener('click', fitView);
  document.getElementById('minimap-toggle').addEventListener('click', event => {
    const collapsed = !minimapSvg.hasAttribute('hidden');
    minimapSvg.toggleAttribute('hidden', collapsed);
    minimap.classList.toggle('collapsed', collapsed);
    event.currentTarget.textContent = collapsed ? '+' : '−';
    event.currentTarget.title = collapsed ? '展开小地图' : '收起小地图';
    event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
    if (!collapsed) updateMinimapViewport();
  });
  window.addEventListener('resize', updateMinimapViewport);

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const escId = (id) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : String(id));

  /* ---------------- 视图变换 ---------------- */
  const PAD = 60;
  function contentBox() {
    const b = layout.bounds;
    return {
      x: b.minX - PAD,
      y: b.minY - PAD,
      w: b.maxX - b.minX + PAD * 2,
      h: b.maxY - b.minY + PAD * 2,
    };
  }
  function applyTransform() {
    // Layout positioning avoids putting text on a scaled compositor texture.
    const dpr = window.devicePixelRatio || 1;
    pan.x = Math.round(pan.x * dpr) / dpr;
    pan.y = Math.round(pan.y * dpr) / dpr;
    world.style.transform = '';
    world.style.left = (pan.x / scale) + 'px';
    world.style.top = (pan.y / scale) + 'px';
    world.style.zoom = String(scale);
    zoomLabel.querySelector('.tool-label').textContent = Math.round(scale * 100) + '%';
    zoomLabel.dataset.tooltip = '当前缩放 ' + Math.round(scale * 100) + '% · 点击恢复 100%';
    zoomLabel.setAttribute('aria-label', zoomLabel.dataset.tooltip);
    updateMinimapViewport();
  }
  function screenRect(node) {
    return {
      left: node._rx * scale + pan.x,
      top: node._ry * scale + pan.y,
      w: node._w * scale,
      h: node._h * scale,
    };
  }
  function zoomAt(cx, cy, factor) {
    const ns = clamp(scale * factor, 0.2, 3);
    const k = ns / scale;
    pan.x = cx - (cx - pan.x) * k;
    pan.y = cy - (cy - pan.y) * k;
    scale = ns;
    applyTransform();
  }
  function centerView(resetScale) {
    if (!model || !layout) return;
    if (resetScale) scale = 1;
    const rect = canvasWrap.getBoundingClientRect();
    const root = model.root;
    const right = ['right', 'compact', 'spacious', 'outline'].includes(layoutMode);
    const anchorX = rect.width * (right ? .25 : layoutMode === 'left' ? .75 : .5);
    const anchorY = layoutMode === 'org' ? Math.min(80, rect.height * .2) : layoutMode === 'up' ? rect.height - Math.min(80, rect.height * .2) : rect.height / 2;
    pan.x = anchorX - (root._rx + root._w / 2) * scale;
    pan.y = anchorY - (root._ry + root._h / 2) * scale;
    applyTransform();
  }

  function fitView() {
    if (!layout) return;
    const box = contentBox();
    const rect = canvasWrap.getBoundingClientRect();
    if (box.w <= 0 || box.h <= 0 || rect.width <= 0) return;
    scale = clamp(Math.min(rect.width / box.w, rect.height / box.h, 1), 0.2, 2);
    pan.x = (rect.width - box.w * scale) / 2;
    pan.y = (rect.height - box.h * scale) / 2;
    applyTransform();
  }

  /* ---------------- 主题 ---------------- */
  function canvasColor() {
    const color = model?.data.canvasColor;
    return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : theme.canvas;
  }
  function changeCanvasColor(color) {
    if (!model || readOnly || (color !== null && !/^#[0-9a-f]{6}$/i.test(color))) return;
    if ((model.data.canvasColor || null) === color) return;
    if (editingId) commitEdit();
    model.commit();
    if (color === null) delete model.data.canvasColor;
    else model.data.canvasColor = color;
    render(); scheduleSave();
  }
  function applyTheme() {
    const t = theme;
    const set = (k, v) => document.body.style.setProperty(k, v);
    set('--canvas', canvasColor());
    set('--node-border', t.nodeBorder);
    set('--node-fill', t.nodeFill);
    set('--node-text', t.nodeText);
    set('--editor-text', t.nodeText);
    set('--sel', t.selectedBorder);
    set('--sel-bg', t.selectedBg || 'rgba(51,112,255,0.08)');
    set('--hover', t.hoverBorder);
    set('--collapse-bg', t.collapseBg);
    set('--collapse-border', t.collapseBorder);
    set('--collapse-text', t.collapseText);
    set('--glow', t.selectedGlow);
    canvasWrap.style.background = canvasColor();
  }

  /* ---------------- 选择 ---------------- */
  function selectNode(id) {
    selectedId = id;
    syncStyleControls();
    const sels = nodesLayer.querySelectorAll('.mm-node.selected');
    for (let i = 0; i < sels.length; i++) sels[i].classList.remove('selected');
    if (id) {
      const el = nodesLayer.querySelector('.mm-node[data-id="' + escId(id) + '"]');
      if (el) el.classList.add('selected');
    }
  }

  function syncStyleControls() {
    const node = selectedId && model && model.find(selectedId);
    const hint = document.getElementById('style-hint');
    if (!hint) return;
    hint.textContent = !node ? '请先选中节点' : node === model.root ? '中心主题样式（后代默认继承）' : '调整当前节点，后代继承父级样式';
    for (const [id, value] of [['line-color', node ? branchColors.get(node.id) : '#3370ff'], ['text-color', node ? textStyles.get(node.id)?.textColor : '#1f2329'], ['font-weight', node ? textStyles.get(node.id)?.fontWeight : 400]]) {
      const control = document.getElementById(id);
      control.disabled = !node;
      control.value = value;
    }
    document.getElementById('canvas-color').value = canvasColor();
    document.querySelectorAll('[data-color-target]').forEach(button => {
      button.disabled = button.dataset.colorTarget === 'canvas-color' ? readOnly : !node;
      button.setAttribute('aria-pressed', String(!button.disabled && button.dataset.color.toLowerCase() === document.getElementById(button.dataset.colorTarget).value.toLowerCase()));
    });
  }
  function syncBulkToggle() {
    const button = document.getElementById('btn-toggle-all-nodes');
    if (!button || !model) return;
    const hasBranches = model.root.children.length > 0;
    const collapseNext = hasBranches && !model.hasCollapsedBranches();
    button.disabled = !hasBranches;
    button.querySelector('.tool-label').textContent = collapseNext ? '节点一键收起' : '节点一键展开';
    button.dataset.tooltip = button.textContent;
    button.classList.toggle('is-collapse', collapseNext);
    button.setAttribute('aria-label', button.textContent);
    button.dataset.nextState = collapseNext ? 'collapse' : 'expand';
  }

  function changeNodeStyle(changes) {
    if (!selectedId || !model || readOnly) return;
    if (editingId) commitEdit();
    if (model.setNodeStyle(selectedId, changes)) { render(); scheduleSave(); }
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    if (!model) return;
    applyTheme();
    // 保险性隐藏拖拽指示器，避免拖拽后残留
    if (indicator) indicator.style.display = 'none';
    textStyles = C.resolveTextStyles(model.root, theme);
    C.walkVisible(model.root, node => { node._textStyle = textStyles.get(node.id); });
    if (window.MindMapRich) window.MindMapRich.prepare(model.root, () => {
      if (!editingId && model) { render(); if (!readOnly) scheduleSave(); }
    });
    layout = C.layoutTree(model.root, measure, layoutMode);
    branchColors = C.assignBranchColors(model.root, theme);
    const box = contentBox();
    world.style.width = box.w + 'px';
    world.style.height = box.h + 'px';
    nodesLayer.innerHTML = '';
    edgesSvg.setAttribute('width', box.w);
    edgesSvg.setAttribute('height', box.h);
    edgesSvg.innerHTML = '';

    for (let i = 0; i < layout.visible.length; i++) {
      const node = layout.visible[i];
      node._rx = node._x - box.x;
      node._ry = node._y - box.y;
      createNodeEl(node);
    }
    drawEdges();
    selectNode(selectedId);
    document.getElementById('btn-undo').disabled = readOnly || !model.canUndo();
    document.getElementById('btn-redo').disabled = readOnly || !model.canRedo();
    syncBulkToggle();
    document.querySelectorAll('#layout-menu [data-action]').forEach(item => {
      const active = item.dataset.action === 'layout-' + layoutMode;
      item.classList.toggle('active', active);
      item.setAttribute('aria-checked', String(active));
      item.setAttribute('role', 'menuitemradio');
    });
    updateStatus();
    if (!fittedOnce) {
      fittedOnce = true;
      centerView(true);
    }
  }

  function createNodeEl(node) {
    const color = branchColors.get(node.id) || theme.rootFill;
    const isRoot = node === model.root;
    const el = document.createElement('div');
    el.className = 'mm-node' + (node._side === 'left' ? ' left' : '');
    el.dataset.id = node.id;
    el.style.left = node._rx + 'px';
    el.style.top = node._ry + 'px';
    el.style.width = node._w + 'px';
    el.style.height = node._h + 'px';
    el.style.minHeight = node._h + 'px';
    if (isRoot) {
      el.style.background = theme.rootFill;
      el.style.border = '1.5px solid ' + theme.rootFill;
      el.style.color = theme.rootText;
      el.style.fontWeight = '600';
      el.style.boxShadow = '0 2px 10px rgba(0,0,0,.12)';
    }
    const textStyle = textStyles.get(node.id);
    el.style.color = textStyle.textColor;
    el.style.fontWeight = String(textStyle.fontWeight);
    el.style.setProperty('--node-text', textStyle.textColor);
    el.style.setProperty('--text-weight', String(textStyle.fontWeight));
    el.style.setProperty('--branch-color', color);
    if (isRoot) { el.style.background = color; el.style.borderColor = color; }
    const span = document.createElement('div');
    span.className = 'mm-node-text';
    span.textContent = node.text || (isRoot ? '中心主题' : '输入文本');
    span.classList.toggle('placeholder', !node.text);
    el.setAttribute('aria-label', node.text || '输入文本');
    if (node.content && window.MindMapRich) {
      el.classList.add('rich-node');
      el.appendChild(window.MindMapRich.element(node));
    } else el.appendChild(span);

    if (node.children.length) {
      const btn = document.createElement('div');
      btn.className = 'mm-collapse ' + (node._side === 'left' && !isRoot ? 'left' : 'right');
      btn.textContent = node.collapsed ? '+' : '−';
      if (node.collapsed) btn.classList.add('collapsed');
      btn.title = node.collapsed ? '展开' : '折叠';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (editingId) commitEdit();
        model.toggleCollapse(node.id);
        render();
        scheduleSave();
      });
      el.appendChild(btn);
    }

    // 选中态右侧加号按钮：点击添加子主题
    {
      const addBtn = document.createElement('div');
      addBtn.className = 'mm-add-btn' + (node._side === 'left' ? ' left' : '');
      addBtn.textContent = '+';
      addBtn.title = '添加子主题';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (editingId) commitEdit();
        selectNode(node.id);
        const n = model.addChild(node.id, '');
        render();
        scheduleSave();
        if (n) startEdit(n.id);
      });
      el.appendChild(addBtn);
    }
    nodesLayer.appendChild(el);
  }

  function relationPaths() {
    const visible = new Map(layout.visible.map(node => [node.id, node]));
    return (model.data.relations || []).flatMap(link => {
      const a = visible.get(link.from), b = visible.get(link.to);
      if (!a || !b) return [];
      const ax = a._rx + a._w / 2, ay = a._ry + a._h / 2;
      const bx = b._rx + b._w / 2, by = b._ry + b._h / 2;
      const preview = relationDrag && relationDrag.id === link.id ? relationDrag : link;
      const c1 = preview.control1 || { x: (bx - ax) / 3, y: (by - ay) / 3 };
      const c2 = preview.control2 || { x: (ax - bx) / 3, y: (ay - by) / 3 };
      const p1 = { x: ax + c1.x, y: ay + c1.y }, p2 = { x: bx + c2.x, y: by + c2.y };
      const edge = (node, x, y, toward) => {
        let dx = toward.x - x, dy = toward.y - y;
        if (Math.abs(dx) + Math.abs(dy) < 0.01) { dx = bx - ax; dy = by - ay; }
        const t = Math.min(dx ? node._w / 2 / Math.abs(dx) : Infinity, dy ? node._h / 2 / Math.abs(dy) : Infinity);
        return { x: x + dx * t, y: y + dy * t };
      };
      const start = edge(a, ax, ay, p1), end = edge(b, bx, by, p2);
      return [{ id: link.id, arrow: link.arrow || 'none', color: branchColors.get(link.from), start, end, p1, p2, ax, ay, bx, by,
        d: 'M' + start.x + ',' + start.y + ' C' + p1.x + ',' + p1.y + ' ' + p2.x + ',' + p2.y + ' ' + end.x + ',' + end.y }];
    });
  }
  function specialTreePaths() { return C.treeEdges(model.root, layoutMode, branchColors); }

  function drawEdges() {
    const svg = specialTreePaths().map(path => '<path d="' + path.d + '" data-edge-role="' + path.role + '" fill="none" stroke="' + path.color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>').join('');
    edgesSvg.innerHTML = svg;
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = '<marker id="relation-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="context-stroke" stroke-width="1.5"/></marker>';
    edgesSvg.appendChild(defs);
    relationPaths().forEach(link => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', link.d);
      path.setAttribute('class', 'relation-line');
      path.setAttribute('stroke', link.color);
      path.setAttribute('stroke-dasharray', '6 5');
      path.setAttribute('stroke-width', selectedRelationId === link.id ? '3' : '2');
      path.setAttribute('fill', 'none');
      if (['forward', 'both'].includes(link.arrow)) path.setAttribute('marker-end', 'url(#relation-arrow)');
      if (['backward', 'both'].includes(link.arrow)) path.setAttribute('marker-start', 'url(#relation-arrow)');
      path.dataset.relationId = link.id;
      path.addEventListener('pointerdown', e => { e.stopPropagation(); });
      path.addEventListener('click', e => { e.stopPropagation(); selectedRelationId = link.id; drawEdges(); });
      path.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        selectedRelationId = link.id;
        drawEdges();
        showRelationMenu(link.id, e.clientX, e.clientY);
      });
      edgesSvg.appendChild(path);
      if (selectedRelationId === link.id) {
        for (const [key, point, origin] of [['control1', link.p1, { x: link.ax, y: link.ay }], ['control2', link.p2, { x: link.bx, y: link.by }]]) {
          const guide = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          guide.setAttribute('d', 'M' + origin.x + ',' + origin.y + ' L' + point.x + ',' + point.y);
          guide.setAttribute('class', 'relation-guide');
          edgesSvg.appendChild(guide);
          const handle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          handle.setAttribute('cx', point.x); handle.setAttribute('cy', point.y); handle.setAttribute('r', '6');
          handle.setAttribute('class', 'relation-handle');
          handle.dataset.control = key;
          handle.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            relationDrag = { id: link.id, key, control1: { x: link.p1.x - link.ax, y: link.p1.y - link.ay }, control2: { x: link.p2.x - link.bx, y: link.p2.y - link.by }, origin };
          });
          edgesSvg.appendChild(handle);
        }
      }
    });
    updateMinimap();
  }

  function updateStatus() {
    statusCount.textContent = model ? C.countNodes(model.root) + ' 个节点' : '';
  }

  /* ---------------- 编辑 ---------------- */
  function startEdit(id) {
    if (readOnly) return;
    const node = model.find(id);
    if (!node) return;
    if (editingId) commitEdit();
    selectNode(id);
    const el = nodesLayer.querySelector('.mm-node[data-id="' + escId(id) + '"]');
    if (!el) return;
    editingId = id;
    // 编辑时隐藏节点自身边框/背景，避免与编辑框叠加出"双边框"
    el.classList.add('editing');
    const ta = document.createElement('textarea');
    ta.className = 'mm-editor';
    ta.value = node.text;
    ta.placeholder = node === model.root ? '中心主题' : '输入文本';
    ta.setAttribute('aria-label', '编辑主题文本');
    ta.rows = 1;
    el.appendChild(ta);
    ta.focus();
    ta.select();
    // 输入时实时重新布局：临时更新文字 → layoutTree → 更新所有节点位置（不重建DOM，保持textarea） → 重绘连线
    ta.addEventListener('input', () => {
      const text = ta.value;
      const node = model.find(id);
      if (!node) return;
      const oldText = node.text;
      node.text = text; // 临时更新，仅用于布局计算
      try {
        let newLayout = C.layoutTree(model.root, measure, layoutMode);
        // Browser line wrapping is authoritative for the active textarea.
        el.style.width = node._w + 'px';
        ta.style.height = '0px';
        const editorHeight = ta.scrollHeight + 4;
        ta.style.height = '';
        if (editorHeight > node._h) {
          const editingMeasure = value => {
            const size = C.createMeasure(FONT, 540)(value);
            return value === text ? { width: size.width, height: Math.max(size.height, editorHeight - C.LAYOUT.PAD_Y * 2 - 4) } : size;
          };
          newLayout = C.layoutTree(model.root, editingMeasure, layoutMode);
        }
        const newBounds = newLayout.bounds;
        layout = newLayout;
        // 重新计算渲染坐标（与 render() 中 _rx/_ry 一致）
        const boxX = newBounds.minX - PAD;
        const boxY = newBounds.minY - PAD;
        newLayout.visible.forEach(function (n) {
          n._rx = n._x - boxX;
          n._ry = n._y - boxY;
        });
        // 同步更新容器尺寸，避免连线被裁剪
        const boxW = newBounds.maxX - newBounds.minX + PAD * 2;
        const boxH = newBounds.maxY - newBounds.minY + PAD * 2;
        world.style.width = boxW + 'px';
        world.style.height = boxH + 'px';
        edgesSvg.setAttribute('width', boxW);
        edgesSvg.setAttribute('height', boxH);
        // 更新所有节点 DOM 的位置和尺寸（不重建，保持编辑框不丢失）
        const nodeEls = nodesLayer.querySelectorAll('.mm-node');
        nodeEls.forEach(function (domEl) {
          const nid = domEl.dataset.id;
          const ln = newLayout.visible.find(function (n) { return n.id === nid; });
          if (ln) {
            domEl.style.left = ln._rx + 'px';
            domEl.style.top = ln._ry + 'px';
            domEl.style.width = ln._w + 'px';
            domEl.style.height = ln._h + 'px';
            domEl.style.minHeight = ln._h + 'px';
          }
        });
        drawEdges();
      } finally {
        node.text = oldText; // 恢复，commitEdit 时才真正写入 model
      }
    });
    ta.dispatchEvent(new Event('input'));
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        commitEdit();
        saveNow();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        commitEdit();
      } else if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        cancelEdit();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        // 编辑态下 Tab：提交当前编辑，添加子节点并进入编辑
        const curId = editingId;
        commitEdit();
        const n = model.addChild(curId, '');
        render();
        scheduleSave();
        if (n) startEdit(n.id);
      }
    });
    ta.addEventListener('blur', () => commitEdit());
  }

  function commitEdit() {
    if (!editingId) return;
    const id = editingId;
    const ta = nodesLayer.querySelector('.mm-editor');
    if (ta) {
      const text = ta.value;
      const node = model.find(id);
      if (node && text !== node.text) {
        model.setText(id, text);
        scheduleSave();
      }
      editingId = null;
      ta.remove();
    }
    editingId = null;
    render();
    selectNode(id);
  }

  function cancelEdit() {
    if (!editingId) return;
    const ta = nodesLayer.querySelector('.mm-editor');
    editingId = null;
    if (ta) ta.remove();
    render();
  }

  /* ---------------- 撤销 / 重做 ---------------- */
  function undo() {
    if (!model.canUndo()) return;
    const prev = selectedId;
    model.undo();
    render();
    if (prev && model.find(prev)) selectNode(prev);
    else selectNode(null);
    scheduleSave();
  }
  function redo() {
    if (!model.canRedo()) return;
    const prev = selectedId;
    model.redo();
    render();
    if (prev && model.find(prev)) selectNode(prev);
    else selectNode(null);
    scheduleSave();
  }

  /* ---------------- 键盘导航 ---------------- */
  function navigate(key) {
    if (!selectedId) {
      selectNode(model.root.id);
      return;
    }
    const order = layout.visible;
    const idx = order.findIndex((n) => n.id === selectedId);
    if (idx < 0) return;
    const sel = order[idx];
    if (key === 'ArrowDown' && idx < order.length - 1) { selectNode(order[idx + 1].id); }
    else if (key === 'ArrowUp' && idx > 0) { selectNode(order[idx - 1].id); }
    else if (key === (sel._side === 'left' ? 'ArrowLeft' : 'ArrowRight')) {
      if (sel.children.length) {
        if (sel.collapsed) {
          model.setCollapsed(sel.id, false);
          render();
          scheduleSave();
        } else {
          selectNode(sel.children[0].id);

        }
      }
    } else if (key === (sel._side === 'left' ? 'ArrowRight' : 'ArrowLeft')) {
      if (sel.children.length && !sel.collapsed) {
        model.setCollapsed(sel.id, true);
        render();
        scheduleSave();
      } else {
        const p = C.findParent(model.root, sel.id);
        if (p) { selectNode(p.id); }
      }
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && document.querySelector('.tb-menu.open')) {
      toggleMenu('', true); e.preventDefault(); return;
    }
    // 输入控件内的按键由控件自己处理，避免提交/换行事件冒泡触发全局快捷键
    const tag = e.target && e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') return;
    if (!model || e.isComposing || editingId || !contextMenu.hidden) return; // 等待文档初始化及输入完成
    const mod = e.ctrlKey || e.metaKey;
    if (readOnly && (['Tab','Enter','F2','Delete','Backspace'].includes(e.key) || (mod && ['z','y'].includes(e.key.toLowerCase())))) { e.preventDefault(); return; }

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveNow();
      return;
    }
    if (mod && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      const r = canvasWrap.getBoundingClientRect();
      zoomAt(r.width / 2, r.height / 2, 1.2);
      return;
    }
    if (mod && e.key === '-') {
      e.preventDefault();
      const r = canvasWrap.getBoundingClientRect();
      zoomAt(r.width / 2, r.height / 2, 1 / 1.2);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (!selectedId) {
        selectNode(model.root.id);
        return;
      }
      if (e.shiftKey) {
        model.promote(selectedId);
        render();
        scheduleSave();
      } else {
        const n = model.addChild(selectedId, '');
        render();
        scheduleSave();
        if (n) startEdit(n.id);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!selectedId) {
        selectNode(model.root.id);
        return;
      }
      const n = model.addSibling(selectedId, '', e.shiftKey);
      render();
      scheduleSave();
      if (n) startEdit(n.id);
      return;
    }
    if (e.key === 'F2') {
      e.preventDefault();
      if (selectedId) startEdit(selectedId);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedId && selectedId !== model.root.id) {
        e.preventDefault();
        model.removeNode(selectedId);
        selectNode(null);
        render();
        scheduleSave();
      } else if (selectedId === model.root.id) {
        e.preventDefault();
        toast('根节点不可删除');
      }
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      navigate(e.key);
      return;
    }
    if (e.key === 'Escape') {
      relationDrag = null;
      selectedRelationId = null;
      drawEdges();
      relationSource = null;
      canvasWrap.classList.remove('linking');
      if (dragState) {
        cancelDrag();
        return;
      }
      if (selectedId) {
        const sel = model.find(selectedId);
        if (sel && sel.children.length && !sel.collapsed) {
          model.setCollapsed(sel.id, true);
          render();
          scheduleSave();
        } else {
          const p = C.findParent(model.root, selectedId);
          if (p) selectNode(p.id);
        }
      }
      return;
    }
    if (e.key === ' ') {
      spaceHeld = true;
      e.preventDefault();
    }
  }

  function onKeyUp(e) {
    if (e.key === ' ') spaceHeld = false;
  }

  /* ---------------- 拖拽调整结构 ---------------- */
  function onNodePointerDown(e) {
    if (e.button !== 0 || spaceHeld) return;
    if (e.target.closest('.mm-editor, .mm-add-btn, .mm-collapse')) return;
    if (editingId) commitEdit();
    const el = e.target.closest('.mm-node');
    if (!el) return;
    if (e.target.closest('.mm-collapse')) return; // 折叠按钮自己处理
    const id = el.dataset.id;
    if (relationSource) {
      const source = relationSource;
      relationSource = null;
      canvasWrap.classList.remove('linking');
      if (model.addRelation(source, id)) { render(); scheduleSave(); toast('已添加虚线关联'); }
      else toast('请选择其他节点，已有的关联不会重复添加');
      return;
    }
    selectNode(id);
    if (readOnly) return;
    dragState = {
      id: id,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      isRoot: id === model.root.id,
    };
    e.preventDefault();
  }

  function onCanvasPointerDown(e) {
    if (e.button === 1 || spaceHeld) {
      startPan(e);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (e.target.closest('.mm-node') || e.target.closest('.mm-collapse')) return;
    selectNode(null);
    startPan(e);
  }

  function startPan(e) {
    panState = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
    canvasWrap.classList.add('panning');
  }

  function onPointerMove(e) {
    if (minimapDrag) { moveFromMinimap(e); return; }
    if (relationDrag) {
      const rect = canvasWrap.getBoundingClientRect();
      relationDrag[relationDrag.key] = { x: (e.clientX - rect.left - pan.x) / scale - relationDrag.origin.x, y: (e.clientY - rect.top - pan.y) / scale - relationDrag.origin.y };
      drawEdges();
      return;
    }
    if (dragState && dragState.moved) {
      updateDrag(e);
      return;
    }
    if (dragState && !dragState.moved) {
      if (Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY) > 4) {
        dragState.moved = true;
        beginDragVisual();
      } else {
        return;
      }
    }
    if (panState) {
      pan.x = panState.panX + (e.clientX - panState.startX);
      pan.y = panState.panY + (e.clientY - panState.startY);
      applyTransform();
    }
  }

  function beginDragVisual() {
    const node = model.find(dragState.id);
    ghost.textContent = node ? node.text : '';
    ghost.style.display = 'block';
    const el = nodesLayer.querySelector('.mm-node[data-id="' + escId(dragState.id) + '"]');
    if (el) el.classList.add('dragging');
    canvasWrap.classList.add('dragging');
    if (dragState.isRoot) toast('根节点不可移动');
  }

  function updateDrag(e) {
    ghost.style.left = e.clientX + 14 + 'px';
    ghost.style.top = e.clientY + 10 + 'px';
    if (dragState.isRoot) {
      hideIndicator();
      return;
    }
    dropTarget = hitTest(e.clientX, e.clientY);
    if (dropTarget) showIndicator(dropTarget);
    else hideIndicator();
  }

  function hitTest(x, y) {
    let best = null;
    for (let i = 0; i < layout.visible.length; i++) {
      const node = layout.visible[i];
      if (node.id === dragState.id) continue;
      if (C.isDescendant(model.root, dragState.id, node.id)) continue;
      const r = screenRect(node);
      const canvasRect = canvasWrap.getBoundingClientRect();
      r.left += canvasRect.left;
      r.top += canvasRect.top;
      if (x >= r.left && x <= r.left + r.w && y >= r.top && y <= r.top + r.h) {
        const area = r.w * r.h;
        if (!best || area < best.area) best = { id: node.id, rect: r, area: area };
      }
    }
    if (!best) return null;
    const r = best.rect;
    const dy = (y - r.top) / r.h;
    let where = 'child';
    if (dy < 0.3) where = 'before';
    else if (dy > 0.7) where = 'after';
    if (best.id === model.root.id && where !== 'child') where = 'child';
    return { id: best.id, where: where, rect: r };
  }

  function showIndicator(t) {
    indicator.style.display = 'block';
    if (t.where === 'child') {
      indicator.className = 'drop-child';
      indicator.style.left = (t.rect.left - canvasWrap.getBoundingClientRect().left) + 'px';
      indicator.style.top = (t.rect.top - canvasWrap.getBoundingClientRect().top) + 'px';
      indicator.style.width = t.rect.w + 'px';
      indicator.style.height = t.rect.h + 'px';
    } else {
      indicator.className = 'drop-line';
      indicator.style.left = (t.rect.left - canvasWrap.getBoundingClientRect().left) + 'px';
      indicator.style.width = t.rect.w + 'px';
      indicator.style.height = '3px';
      indicator.style.top = ((t.where === 'before' ? t.rect.top - 1 : t.rect.top + t.rect.h - 1) - canvasWrap.getBoundingClientRect().top) + 'px';
    }
  }

  function hideIndicator() {
    indicator.style.display = 'none';
  }

  function cancelDrag() {
    dragState = null;
    dropTarget = null;
    hideIndicator();
    ghost.style.display = 'none';
    canvasWrap.classList.remove('dragging');
    const els = nodesLayer.querySelectorAll('.mm-node.dragging');
    for (let i = 0; i < els.length; i++) els[i].classList.remove('dragging');
  }

  function onPointerUp() {
    if (minimapDrag) { minimapDrag = null; return; }
    if (relationDrag) {
      const drag = relationDrag;
      relationDrag = null;
      if (model.updateRelation(drag.id, { control1: drag.control1, control2: drag.control2 })) scheduleSave();
      drawEdges();
      return;
    }
    if (dragState && dragState.moved && !dragState.isRoot && dropTarget) {
      const id = dragState.id;
      const target = dropTarget;
      cancelDrag();
      if (model.moveNode(id, target.id, target.where)) {
        selectNode(id);
        render();
        scheduleSave();
      }
      return;
    }
    cancelDrag();
    if (panState) {
      panState = null;
      canvasWrap.classList.remove('panning');
    }
  }

  /* ---------------- 保存 ---------------- */
  function scheduleSave() {
    if (readOnly) { statusText.textContent = 'Markdown 只读预览'; return; }
    isDirty = true;
    statusText.textContent = '保存中…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 800);
  }
  function saveNow() {
    if (readOnly) return;
    clearTimeout(saveTimer);
    if (!isDirty || !model) return;
    isDirty = false;
    vscode.postMessage({ type: 'save', data: JSON.parse(C.serialize(model.data)) });
  }

  /* ---------------- 导出 ---------------- */
  function baseName() {
    const f = fileName.replace(/\.(mindmap|mindm|md|markdown)$/i, '');
    return f || '思络';
  }
  function exportMarkdown() {
    vscode.postMessage({
      type: 'export',
      format: 'markdown',
      content: C.markdownExport(model.data),
      defaultName: baseName(),
    });
  }
  function exportHtml() {
    vscode.postMessage({
      type: 'export',
      format: 'html',
      content: window.MindMapRich ? window.MindMapRich.html(world) : C.htmlExport(model.data),
      defaultName: baseName(),
    });
  }
  function exportPng() {
    if (window.MindMapRich && layout.visible.some(node => ['mermaid','image'].includes(node.content?.type))) {
      window.MindMapRich.prepareImages(layout.visible).then(sendPng).catch(err => toast('PNG 导出失败：' + err.message));
    } else sendPng();
  }
  function sendPng() {
    try {
      const dataUrl = renderPng();
      vscode.postMessage({
        type: 'export',
        format: 'png',
        pngBase64: dataUrl.split(',')[1],
        defaultName: baseName(),
      });
    } catch (err) {
      toast('PNG 导出失败：' + err.message);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function exportBounds() {
    const box = contentBox();
    // Include freely moved curve controls in the export canvas.
    const points = relationPaths().flatMap(link => [link.p1, link.p2]);
    const minX = Math.min(0, ...points.map(p => p.x - 30));
    const minY = Math.min(0, ...points.map(p => p.y - 30));
    box.w = Math.max(box.w, ...points.map(p => p.x + 30)) - minX;
    box.h = Math.max(box.h, ...points.map(p => p.y + 30)) - minY;
    return { box, minX, minY };
  }
  function renderPng() {
    const { box, minX, minY } = exportBounds();
    const size = C.pngExportSize(box.w, box.h);
    const s = size.scale;
    const W = size.width;
    const H = size.height;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('图片尺寸超出可用内存，请导出 SVG');
    ctx.fillStyle = canvasColor();
    ctx.fillRect(0, 0, W, H);
    ctx.translate(-minX * s, -minY * s);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.lineCap = 'round';

    ctx.save();
    ctx.scale(s, s);
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    specialTreePaths().forEach(path => { ctx.strokeStyle = path.color; ctx.stroke(new Path2D(path.d)); });
    ctx.setLineDash([6, 5]);
    relationPaths().forEach(link => { ctx.strokeStyle = link.color; ctx.stroke(new Path2D(link.d)); });
    ctx.setLineDash([]);
    const arrow = (tip, control) => {
      const angle = Math.atan2(tip.y - control.y, tip.x - control.x);
      ctx.beginPath();
      ctx.moveTo(tip.x - 10 * Math.cos(angle - 0.45), tip.y - 10 * Math.sin(angle - 0.45));
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(tip.x - 10 * Math.cos(angle + 0.45), tip.y - 10 * Math.sin(angle + 0.45));
      ctx.stroke();
    };
    relationPaths().forEach(link => {
      ctx.strokeStyle = link.color;
      if (['forward', 'both'].includes(link.arrow)) arrow(link.end, link.p2);
      if (['backward', 'both'].includes(link.arrow)) arrow(link.start, link.p1);
    });
    ctx.restore();

    // 节点
    const lh = 20;
    for (let i = 0; i < layout.visible.length; i++) {
      const node = layout.visible[i];
      const x = node._rx * s;
      const y = node._ry * s;
      const w = node._w * s;
      const h = node._h * s;
      const isRoot = node === model.root;
      const color = branchColors.get(node.id) || theme.rootFill;
      if (isRoot) {
        ctx.fillStyle = color;
        roundRect(ctx, x, y, w, h, 8 * s);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, s);
        ctx.stroke();
      }
      if (node.content && window.MindMapRich) {
        window.MindMapRich.draw(ctx, node, x, y, s);
        continue;
      }
      // 普通节点：无背景无边框，只绘制文字
      const textStyle = textStyles.get(node.id);
      ctx.fillStyle = textStyle.textColor;
      ctx.font = textStyle.fontWeight + ' ' + FONT.replace('14px', (14 * s) + 'px');
      ctx.textAlign = 'center';
      // 自动换行（与 createMeasure 的 maxWidth=360 一致，内容区域最大宽度）
      var maxW = 360 * s;
      var rawLines = String(node.text).split('\n');
      var lines = [];
      for (var ri = 0; ri < rawLines.length; ri++) {
        var rline = rawLines[ri];
        if (ctx.measureText(rline).width <= maxW || rline.length === 0) {
          lines.push(rline);
        } else {
          var cur = '';
          var curW = 0;
          for (var ci = 0; ci < rline.length; ci++) {
            var ch = rline[ci];
            var cw = ctx.measureText(ch).width;
            if (curW + cw > maxW && cur.length > 0) {
              lines.push(cur);
              cur = ch;
              curW = cw;
            } else {
              cur += ch;
              curW += cw;
            }
          }
          if (cur.length > 0) lines.push(cur);
        }
      }
      const startY = y + h / 2 - ((lines.length - 1) * lh * s) / 2;
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], x + w / 2, startY + li * lh * s);
      }

    }
    const png = canvas.toDataURL('image/png');
    if (!png.startsWith('data:image/png;')) throw new Error('图片过大，请改用 SVG 导出');
    return png;
  }

  /* ---------------- 工具栏 ---------------- */
  function buildThemeMenu() {
    const menu = document.getElementById('theme-menu');
    const keys = Object.keys(C.THEMES);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const item = document.createElement('div');
      item.className = 'tb-menu-item';
      item.textContent = C.THEMES[key].name;
      item.dataset.theme = key;
      item.addEventListener('click', () => {
        setTheme(key);
        toggleMenu('theme-menu', true);
      });
      menu.appendChild(item);
    }
  }
  function setTheme(key) {
    theme = C.THEMES[key] || C.THEMES.lightMap;
    applyTheme();
    render();
  }

  function toggleMenu(menuId, forceClose) {
    const menus = document.querySelectorAll('.tb-menu');
    for (let i = 0; i < menus.length; i++) {
      const m = menus[i];
      if (m.id === menuId && !forceClose) m.classList.toggle('open');
      else m.classList.remove('open');
      const trigger = m.parentElement.querySelector('.tb-tool');
      trigger?.setAttribute('aria-expanded', String(m.classList.contains('open')));
      if (m.classList.contains('open')) {
        hideToolTip();
        const rect = trigger.getBoundingClientRect();
        m.style.left = Math.min(rect.right + 16, Math.max(8, window.innerWidth - m.offsetWidth - 8)) + 'px';
        m.style.top = Math.max(8, Math.min(rect.top, window.innerHeight - m.offsetHeight - 32)) + 'px';
      }
    }
  }

  document.addEventListener('pointerdown', e => {
    if (!e.target.closest('.tb-dropdown')) toggleMenu('', true);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.querySelector('.tb-menu.open')) {
      hideToolTip(); toggleMenu('', true); e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);
  canvasWrap.addEventListener('wheel', () => toggleMenu('', true));

  async function onToolbarClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || !model) return;
    if (editingId) commitEdit();
    const action = btn.dataset.action;
    if (['export-svg','export-html','export-png'].includes(action) && layout.visible.some(n=>n.content?.type==='image')) await window.MindMapRich.prepareImages(layout.visible);
    if (readOnly && ['add-child','import-markdown','style-reset','canvas-reset','undo','redo'].includes(action)) return;
    switch (action) {
      case 'import-markdown':
        vscode.postMessage({ type: 'import-markdown' });
        break;
      case 'add-child': {
        const parentId = selectedId || model.root.id;
        const n = model.addChild(parentId, '');
        render();
        scheduleSave();
        if (n) startEdit(n.id);
        break;
      }
      case 'toggle-all-nodes': {
        const collapse = !model.hasCollapsedBranches();
        if (model.setAllCollapsed(collapse)) {
          if (collapse || !selectedId) selectedId = model.root.id;
          render();
          centerView(false);
          scheduleSave();
        } else syncBulkToggle();
        break;
      }
      case 'undo':
        undo();
        break;
      case 'redo':
        redo();
        break;
      case 'zoom-in': {
        const r = canvasWrap.getBoundingClientRect();
        zoomAt(r.width / 2, r.height / 2, 1.2);
        break;
      }
      case 'zoom-out': {
        const r = canvasWrap.getBoundingClientRect();
        zoomAt(r.width / 2, r.height / 2, 1 / 1.2);
        break;
      }
      case 'fit':
        fitView();
        break;
      case 'layout-toggle':
        toggleMenu('layout-menu');
        break;
      case 'layout-standard':
      case 'layout-right':
      case 'layout-left':
      case 'layout-compact':
      case 'layout-spacious':
      case 'layout-outline':
      case 'layout-org':
      case 'layout-up':
        layoutMode = action.slice('layout-'.length);
        render();
        centerView(true);
        toggleMenu('layout-menu', true);
        break;
      case 'zoom-reset': {
        const rect = canvasWrap.getBoundingClientRect();
        zoomAt(rect.width / 2, rect.height / 2, 1 / scale);
        break;
      }
      case 'style-toggle':
        if (!selectedId || !model.find(selectedId)) selectNode(model.root.id);
        toggleMenu('style-menu');
        break;
      case 'canvas-reset': changeCanvasColor(null); break;
      case 'style-reset': changeNodeStyle({ lineColor: null, textColor: null, fontWeight: null }); break;
      case 'theme-toggle':
        toggleMenu('theme-menu');
        break;
      case 'export-toggle':
        toggleMenu('export-menu');
        break;
      case 'export-markdown':
        exportMarkdown();
        toggleMenu('export-menu', true);
        break;
      case 'export-html':
        exportHtml();
        toggleMenu('export-menu', true);
        break;
      case 'export-svg': {
        const { box, minX, minY } = exportBounds();
        vscode.postMessage({ type: 'export', format: 'svg', content: window.MindMapRich.exportSvg(world, { x: minX, y: minY, width: box.w, height: box.h }, canvasColor()), defaultName: baseName() });
        toggleMenu('export-menu', true);
        break;
      }
      case 'export-png':
        exportPng();
        toggleMenu('export-menu', true);
        break;
      default:
        break;
    }
  }

  /* ---------------- 消息 ---------------- */
  function initDoc(msg) {
    window.MindMapRich?.resetImages?.();
    fileName = msg.fileName || '思络.mindmap';
    readOnly = !!msg.readOnly;
    document.body.classList.toggle('readonly-preview', readOnly);
    clearTimeout(saveTimer);
    editingId = null;
    selectedId = null;
    isDirty = false;
    fittedOnce = false;
    const data = typeof msg.markdown === 'string' && msg.markdown.trim() ? C.markdownImport(msg.markdown, fileName.replace(/\.(md|markdown)$/i,'')) : msg.data ? C.parse(JSON.stringify(msg.data)) : C.defaultData();
    if (readOnly && !data.root.text) data.root.text = fileName.replace(/\.(md|markdown)$/i,'');
    model = new C.MindMapModel(data);
    const measures = new Map([400, 600, 700].map(weight => [weight, C.createMeasure(weight + ' ' + FONT, 360)]));
    measure = (text, node) => node && node.content && node._richSize ? node._richSize : measures.get(textStyles.get(node?.id)?.fontWeight || 400)(text);
    if (msg.theme && C.THEMES[msg.theme]) theme = C.THEMES[msg.theme];
    applyTheme();
    render();
    statusText.textContent = readOnly ? 'Markdown 只读预览' : '就绪';
    if (msg.parseError) {
      toast('文件解析失败，已打开空白画布：' + msg.parseError);
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'image-resolved') {
      const request = imageRequests.get(msg.requestId);
      if (request) { clearTimeout(request.timer); imageRequests.delete(msg.requestId); if (msg.error) request.reject(new Error(msg.error)); else request.resolve(msg.dataUri); }
    } else if (msg.type === 'init') {
      try {
        initDoc(msg);
      } catch (err) {
        initDoc({ fileName: msg.fileName, theme: msg.theme, parseError: err.message });
      }
    } else if (msg.type === 'markdown-imported') {
      try {
        const imported = C.markdownImport(msg.content, msg.name);
        window.MindMapRich?.resetImages();
        if (editingId) commitEdit();
        model.commit();
        model.data = imported;
        selectedId = imported.root.id;
        selectedRelationId = null;
        relationSource = null;
        relationDrag = null;
        render();
        centerView(true);
        scheduleSave();
        toast('Markdown 已生成思维导图，可撤销恢复导入前内容');
      } catch (err) { toast('导入失败：' + err.message); }
    } else if (msg.type === 'saved') {
      statusText.textContent = '已保存';
    } else if (msg.type === 'request-save') {
      commitEdit();
      saveNow();
    } else if (msg.type === 'error') {
      statusText.textContent = '错误';
      toast(msg.message || '发生错误');
    }
  });

  /* ---------------- 提示 ---------------- */
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  const relationMenu = document.createElement('div');
  relationMenu.className = 'relation-context-menu';
  relationMenu.hidden = true;
  document.body.appendChild(relationMenu);
  function showRelationMenu(id, x, y) {
    relationMenu.replaceChildren();
    for (const [action, label] of [['forward', '指向目标 →'], ['backward', '指向起点 ←'], ['both', '双向箭头 ↔'], ['none', '无箭头'], ['reset', '恢复直线'], ['delete', '删除关联线']]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.dataset.relationAction = action;
      button.addEventListener('click', () => {
        relationMenu.hidden = true;
        const changed = action === 'delete' ? model.removeRelation(id) : model.updateRelation(id, action === 'reset' ? { control1: null, control2: null } : { arrow: action });
        if (changed) { render(); scheduleSave(); }
      });
      relationMenu.appendChild(button);
    }
    relationMenu.hidden = false;
    const rect = relationMenu.getBoundingClientRect();
    relationMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
    relationMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
  }
  document.addEventListener('pointerdown', e => {
    if (!relationMenu.contains(e.target)) relationMenu.hidden = true;
  });
  window.addEventListener('keydown', e => { if (e.key === 'Escape') relationMenu.hidden = true; });

  /* ---------------- 节点右键菜单 ---------------- */
  const contextMenu = document.createElement('div');
  contextMenu.className = 'node-context-menu';
  contextMenu.setAttribute('role', 'menu');
  contextMenu.hidden = true;
  document.body.appendChild(contextMenu);
  let contextNodeId = null;
  function closeContextMenu() {
    contextMenu.hidden = true;
    contextNodeId = null;
  }
  nodesLayer.addEventListener('contextmenu', e => {
    const el = e.target.closest('.mm-node');
    if (!el || !model || readOnly) return;
    e.preventDefault();
    const id = el.dataset.id;
    if (editingId) commitEdit();
    cancelDrag();
    selectNode(id);
    contextNodeId = id;
    contextMenu.replaceChildren();
    const parent = C.findParent(model.root, id);
    for (const [action, label, disabled] of [
      ['promote', '提升层级', !parent || parent === model.root],
      ['delete', '删除', !parent],
      ['add-child', '增加下一级', false],
      ['relation', '添加关联线', false],
    ]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.dataset.contextAction = action;
      button.disabled = disabled;
      button.setAttribute('role', 'menuitem');
      contextMenu.appendChild(button);
    }
    contextMenu.hidden = false;
    const rect = contextMenu.getBoundingClientRect();
    contextMenu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - rect.width - 4)) + 'px';
    contextMenu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - rect.height - 4)) + 'px';
    contextMenu.querySelector('button:not(:disabled)').focus();
  });
  contextMenu.addEventListener('click', e => {
    const button = e.target.closest('button');
    if (!button || button.disabled || !contextNodeId) return;
    const id = contextNodeId;
    closeContextMenu();
    let changed = false;
    let child = null;
    switch (button.dataset.contextAction) {
      case 'relation':
        relationSource = id;
        canvasWrap.classList.add('linking');
        toast('点击目标节点添加虚线关联，Esc 取消');
        break;
      case 'promote': changed = model.promote(id); break;
      case 'delete': {
        const parent = C.findParent(model.root, id);
        changed = model.removeNode(id);
        if (changed) selectedId = parent.id;
        break;
      }
      case 'add-child': child = model.addChild(id, ''); changed = !!child; break;
    }
    if (changed) {
      render();
      scheduleSave();
      if (child) startEdit(child.id);
    }
  });
  contextMenu.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const buttons = Array.from(contextMenu.querySelectorAll('button:not(:disabled)'));
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
    }
  });
  document.addEventListener('pointerdown', e => {
    if (!contextMenu.contains(e.target)) closeContextMenu();
  });
  window.addEventListener('blur', closeContextMenu);
  window.addEventListener('resize', closeContextMenu);
  canvasWrap.addEventListener('wheel', closeContextMenu);

  /* ---------------- 事件绑定 ---------------- */
  document.getElementById('toolbar').addEventListener('click', onToolbarClick);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    spaceHeld = false;
    minimapDrag = null;
  });

  nodesLayer.addEventListener('pointerdown', onNodePointerDown);
  canvasWrap.addEventListener('pointerdown', onCanvasPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', () => {
    minimapDrag = null;
    relationDrag = null;
    if (model) drawEdges();
    cancelDrag();
    panState = null;
    canvasWrap.classList.remove('panning');
  });

  nodesLayer.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.mm-node');
    if (!el) return;
    if (e.target.closest('.mm-collapse')) return;
    startEdit(el.dataset.id);
  });

  canvasWrap.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = canvasWrap.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        zoomAt(cx, cy, e.deltaY < 0 ? 1.1 : 1 / 1.1);
      } else {
        pan.x -= e.deltaX;
        pan.y -= e.deltaY;
        applyTransform();
      }
    },
    { passive: false }
  );

  // Small SVG previews keep every layout discoverable in the shape picker.
  document.querySelectorAll('#layout-menu [data-action]').forEach(item => {
    const label = item.textContent;
    const mode = item.dataset.action.slice(7);
    const previews = {
      standard: 'M35 25H18V10H5M18 25V40H5M35 25H52V10H65M52 25V40H65',
      right: 'M8 25H28V8H60M28 25H60M28 25V42H60',
      left: 'M62 25H42V8H10M42 25H10M42 25V42H10',
      compact: 'M8 25H24V15H55M24 25H55M24 25V35H55',
      spacious: 'M5 25H24V5H65M24 25H65M24 25V45H65',
      outline: 'M10 5V45M10 15H35M10 30H35M35 30V42H60',
      org: 'M35 5V22M10 40V22H60V40M35 22V40',
      up: 'M35 45V28M10 10V28H60V10M35 28V10',
    };
    item.textContent = '';
    item.title = label;
    item.setAttribute('aria-label', label);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 70 50');
    icon.innerHTML = '<path d="' + previews[mode] + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><rect x="28" y="20" width="14" height="9" rx="3" fill="currentColor"/>';
    item.appendChild(icon);
    const caption = document.createElement('span');
    caption.textContent = label;
    item.appendChild(caption);
  });

  document.querySelectorAll('[data-color-palette]').forEach(palette => {
    for (const color of ['#3370ff', '#00b96b', '#e5484d', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#1f2329', '#ffffff', '#64748b', '#0f766e', '#166534', '#9a3412', '#7e22ce', '#1d4ed8', '#000000']) {
      const button = document.createElement('button');
      button.className = 'color-swatch'; button.type = 'button';
      button.style.backgroundColor = color;
      button.dataset.colorTarget = palette.dataset.colorPalette;
      button.dataset.color = color;
      button.title = color; button.setAttribute('aria-label', color);
      button.addEventListener('click', () => {
        if (button.dataset.colorTarget === 'canvas-color') { changeCanvasColor(color); return; }
        const property = button.dataset.colorTarget === 'line-color' ? 'lineColor' : 'textColor';
        changeNodeStyle({ [property]: color });
      });
      palette.appendChild(button);
    }
  });

  for (const [id, property] of [['line-color', 'lineColor'], ['text-color', 'textColor'], ['font-weight', 'fontWeight']]) {
    document.getElementById(id)?.addEventListener('input', e => {
      const valid = property === 'fontWeight' || /^#[0-9a-f]{6}$/i.test(e.target.value);
      e.target.setAttribute('aria-invalid', String(!valid));
      if (valid) changeNodeStyle({ [property]: property === 'fontWeight' ? Number(e.target.value) : e.target.value });
    });
  }

  document.getElementById('canvas-color').addEventListener('input', e => {
    const valid = /^#[0-9a-f]{6}$/i.test(e.target.value);
    e.target.setAttribute('aria-invalid', String(!valid));
    if (valid) changeCanvasColor(e.target.value);
  });

  buildThemeMenu();
  applyTheme();
  window.mindSproutReady = true;
  vscode.postMessage({ type: 'ready' });
})();


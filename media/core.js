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
    V_GAP: 10, // 同级节点垂直间距
    PAD_X: 3, // 节点水平内边距（与 CSS .mm-node padding 一致）
    PAD_Y: 3, // 节点垂直内边距
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
        // +2px 余量：canvas measureText 与实际渲染有亚像素误差，避免文字被截断
        width: Math.max(Math.ceil(w) + 2, LAYOUT.MIN_W),
        height: Math.max(lines.length * LAYOUT.LINE_H, LAYOUT.MIN_H),
      };
    };
  }

  /** 计算每个节点的尺寸与子树包围盒高度（结果写入 node._w/_h/_subtreeHeight）。 */
  function calcSubtree(node, measure, settings) {
    const size = measure(node.text || '输入文本', node);
    node._w = Math.max(24, size.width + LAYOUT.PAD_X * 2 + 2);
    node._h = size.height + LAYOUT.PAD_Y * 2 + 2;
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
      mode === 'compact' ? { H_GAP: 64, V_GAP: 6 } :
      mode === 'spacious' ? { H_GAP: 120, V_GAP: 20 } : {});
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
      for (let depth = 1; depth < heights.length; depth++) rows[depth] = rows[depth - 1] + heights[depth - 1] + 44;
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

/* ============================================================
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
  function centerOnNode(node) {
    if (!node || !layout?.visible.includes(node)) return;
    const rect = canvasWrap.getBoundingClientRect();
    pan.x = rect.width / 2 - (node._rx + node._w / 2) * scale;
    pan.y = rect.height / 2 - (node._ry + node._h / 2) * scale;
    applyTransform();
  }
  function nodeInViewport(node, rect) {
    const r = screenRect(node);
    return r.left + r.w > 0 && r.top + r.h > 0 && r.left < rect.width && r.top < rect.height;
  }
  function zoomAt(cx, cy, factor) {
    const rect = canvasWrap.getBoundingClientRect();
    const visible = layout?.visible.filter(node => nodeInViewport(node, rect)) || [];
    const nearest = visible.sort((a,b) => {
      const distance = n => Math.hypot(n._rx * scale + pan.x + n._w * scale / 2 - cx, n._ry * scale + pan.y + n._h * scale / 2 - cy);
      return distance(a) - distance(b);
    })[0] || model?.find(selectedId) || model?.root;
    const ns = clamp(scale * factor, 0.2, 3);
    const k = ns / scale;
    pan.x = cx - (cx - pan.x) * k;
    pan.y = cy - (cy - pan.y) * k;
    scale = ns;
    if (layout && !layout.visible.some(node => nodeInViewport(node, rect))) centerOnNode(nearest);
    else applyTransform();
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
    const anchor = fittedOnce && layout ? layout.visible.find(n => n.id === selectedId) || model.root : null;
    const anchorPoint = anchor && Number.isFinite(anchor._rx) ? {x:pan.x + (anchor._rx + anchor._w / 2) * scale,y:pan.y + (anchor._ry + anchor._h / 2) * scale} : null;
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
    if (anchorPoint && layout.visible.includes(anchor)) {
      pan.x = anchorPoint.x - (anchor._rx + anchor._w / 2) * scale;
      pan.y = anchorPoint.y - (anchor._ry + anchor._h / 2) * scale;
    }
    applyTransform();
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
        const expanding = node.collapsed;
        selectedId = node.id;
        model.toggleCollapse(node.id);
        render();
        if (expanding) centerOnNode(node);
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
            return value === text ? { width: size.width, height: Math.max(size.height, editorHeight - C.LAYOUT.PAD_Y * 2 - 2) } : size;
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
          centerOnNode(sel);
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
          centerOnNode(model.root);
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


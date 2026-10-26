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

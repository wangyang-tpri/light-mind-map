(function () {
  'use strict';
  const host = acquireVsCodeApi();
  window.mindSproutHost = host;
  const status = () => document.getElementById('status-text');
  const report = message => { if (status()) status().textContent = '预览启动失败：' + message + '。请重新执行 Markdown: ThoughtWeave。'; };
  window.addEventListener('error', event => {
    if (!window.mindSproutReady) report(event.message || '页面资源加载失败');
  });
  window.addEventListener('unhandledrejection', event => {
    if (!window.mindSproutReady) report(event.reason?.message || '页面初始化失败');
  });
  if (status()) status().textContent = '正在加载思络预览…';
  setTimeout(() => { if (!window.mindSproutReady && !status()?.textContent.startsWith('预览启动失败')) report('应用脚本未完成加载'); }, 15000);
})();

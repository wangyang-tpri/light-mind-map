import * as vscode from 'vscode';
import { MindMapEditorProvider, MINDMAP_VIEW_TYPE } from './mindmapEditorProvider';

/**
 * 生成一份空的思维导图数据（仅含一个空根节点，无默认分支示例）。
 */
function defaultData(): Record<string, unknown> {
  const now = new Date().toISOString();
  const nid = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return {
    version: 1,
    meta: { createdBy: 'light-mind-map', createdAt: now },
    root: {
      id: nid,
      text: '',
      collapsed: false,
      children: [],
    },
  };
}

/**
 * 在当前文件夹（或用户选择的位置）创建一个新的 .mindmap 文件并用思维导图编辑器打开。
 */
async function createMindMapFile(targetFolder?: vscode.Uri): Promise<void> {
  let target: vscode.Uri | undefined;
  const folder = targetFolder ?? vscode.workspace.workspaceFolders?.[0]?.uri;

  if (folder) {
    let index = 1;
    let candidate: vscode.Uri;
    for (;;) {
      candidate = vscode.Uri.joinPath(folder, index === 1 ? '思维导图.mindmap' : `思维导图${index}.mindmap`);
      try {
        await vscode.workspace.fs.stat(candidate);
        index += 1;
      } catch {
        break; // 不存在，可用
      }
    }
    target = candidate;
  } else {
    target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('思维导图.mindmap'),
      filters: { '思维导图': ['mindmap'] },
      saveLabel: '创建',
    });
  }

  if (!target) {
    return;
  }

  const content = Buffer.from(JSON.stringify(defaultData(), null, 2), 'utf8');
  try {
    await vscode.workspace.fs.writeFile(target, content);
  } catch (err) {
    vscode.window.showErrorMessage(`创建思维导图失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', target, MINDMAP_VIEW_TYPE);
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MindMapEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(MINDMAP_VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('mindmap.new', () => createMindMapFile()),
    vscode.commands.registerCommand('mindmap.newInFolder', (uri?: vscode.Uri) => createMindMapFile(uri)),
    vscode.commands.registerCommand('mindmap.export', () => {
      vscode.window.showInformationMessage('请在思维导图编辑器中点击右上角「导出」按钮，或使用工具栏中的导出菜单。');
    })
  );
}

export function deactivate(): void {
  // nothing to do
}

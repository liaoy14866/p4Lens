import * as vscode from 'vscode';
import { P4CodeLensProvider } from './p4CodeLensProvider';

let provider: P4CodeLensProvider;
let pendingEditorForRefresh: vscode.TextEditor | undefined;
let refreshLoopRunning = false;
let lastRefreshCompletedAt = 0;
const REFRESH_COOLDOWN_MS = 150;

export function activate(context: vscode.ExtensionContext) {
  console.log('[P4Lens] Activating extension...');

  // Create provider (decorations only)
  provider = new P4CodeLensProvider();

  // Listen to active editor changes
  const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
    (editor) => {
      if (editor) {
        markRefreshRequested(editor);
      }
    }
  );
  context.subscriptions.push(editorChangeDisposable);

  const selectionChangeDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (event.textEditor.document.uri.scheme === 'file') {
      markRefreshRequested(event.textEditor);
    }
  });
  context.subscriptions.push(selectionChangeDisposable);

  const documentOpenDisposable = vscode.workspace.onDidOpenTextDocument((document) => {
    if (vscode.window.activeTextEditor?.document.uri.fsPath === document.uri.fsPath) {
      markRefreshRequested(vscode.window.activeTextEditor);
    }
  });
  context.subscriptions.push(documentOpenDisposable);

  const documentChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.scheme !== 'file') {
      return;
    }

    provider.clearCache(event.document.uri.fsPath);
    if (vscode.window.activeTextEditor?.document.uri.fsPath === event.document.uri.fsPath) {
      markRefreshRequested(vscode.window.activeTextEditor);
    }
  });
  context.subscriptions.push(documentChangeDisposable);

  const documentSaveDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
    if (document.uri.scheme !== 'file') {
      return;
    }

    provider.clearCache(document.uri.fsPath);
    if (vscode.window.activeTextEditor?.document.uri.fsPath === document.uri.fsPath) {
      markRefreshRequested(vscode.window.activeTextEditor);
    }
  });
  context.subscriptions.push(documentSaveDisposable);

  // Update selected-line decoration for current editor on activation
  if (vscode.window.activeTextEditor) {
    markRefreshRequested(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(provider);

  console.log('[P4Lens] Extension activated successfully');
}

export function deactivate() {
  pendingEditorForRefresh = undefined;
  console.log('[P4Lens] Extension deactivated');
}

function markRefreshRequested(editor: vscode.TextEditor): void {
  pendingEditorForRefresh = editor;
  void runRefreshLoop();
}

async function runRefreshLoop(): Promise<void> {
  if (refreshLoopRunning) {
    return;
  }

  refreshLoopRunning = true;
  try {
    while (pendingEditorForRefresh) {
      const editorToRefresh = pendingEditorForRefresh;
      pendingEditorForRefresh = undefined;

      const elapsed = Date.now() - lastRefreshCompletedAt;
      const waitMs = Math.max(0, REFRESH_COOLDOWN_MS - elapsed);
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      try {
        await provider.updateDecorationsForSelection(editorToRefresh);
      } catch (error) {
        console.error(`[P4Lens] Refresh failed: ${error}`);
      } finally {
        lastRefreshCompletedAt = Date.now();
      }
    }
  } finally {
    refreshLoopRunning = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

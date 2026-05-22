import * as vscode from 'vscode';
import { P4CodeLensProvider } from './p4CodeLensProvider';

let provider: P4CodeLensProvider;
let pendingEditorForRefresh: vscode.TextEditor | undefined;
let refreshLoopRunning = false;
let lastRefreshCompletedAt = 0;
let openStatePollRunning = false;
const REFRESH_COOLDOWN_MS = 150;
const DECORATION_RESTORE_DELAY_MS = 5000;
const OPEN_STATE_POLL_INTERVAL_SECONDS_CONFIG_KEY = 'openStatePollIntervalSeconds';
const DEFAULT_OPEN_STATE_POLL_INTERVAL_SECONDS = 10;
let showDecorationTimer: NodeJS.Timeout | undefined;
let openStatePollTimer: NodeJS.Timeout | undefined;

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

    if (event.contentChanges.length > 0) {
      hideDecorationWhileTyping();
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

  const configurationChangeDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(getOpenStatePollIntervalConfigurationPath())) {
      restartOpenStatePollTimer();
    }
  });
  context.subscriptions.push(configurationChangeDisposable);

  const manualCheckCommandDisposable = vscode.commands.registerCommand(
    'p4lenslite.checkOpenStateCache',
    async () => {
      await pollCachedFileOpenStates();
    }
  );
  context.subscriptions.push(manualCheckCommandDisposable);

  // Update selected-line decoration for current editor on activation
  if (vscode.window.activeTextEditor) {
    markRefreshRequested(vscode.window.activeTextEditor);
  }

  restartOpenStatePollTimer();

  context.subscriptions.push(provider);

  console.log('[P4Lens] Extension activated successfully');
}

export function deactivate() {
  pendingEditorForRefresh = undefined;
  clearShowDecorationTimer();
  clearOpenStatePollTimer();
  console.log('[P4Lens] Extension deactivated');
}

function hideDecorationWhileTyping(): void {
  provider.setShowDecoration(false, vscode.window.activeTextEditor);
  clearShowDecorationTimer();
  showDecorationTimer = setTimeout(() => {
    showDecorationTimer = undefined;
    provider.setShowDecoration(true);

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor?.document.uri.scheme === 'file') {
      markRefreshRequested(activeEditor);
    }
  }, DECORATION_RESTORE_DELAY_MS);
}

function clearShowDecorationTimer(): void {
  if (!showDecorationTimer) {
    return;
  }

  clearTimeout(showDecorationTimer);
  showDecorationTimer = undefined;
}

function clearOpenStatePollTimer(): void {
  if (!openStatePollTimer) {
    return;
  }

  clearInterval(openStatePollTimer);
  openStatePollTimer = undefined;
}

function restartOpenStatePollTimer(): void {
  clearOpenStatePollTimer();

  const pollIntervalMs = getOpenStatePollIntervalMs();
  if (pollIntervalMs === 0) {
    console.log('[P4Lens] Open state polling disabled');
    return;
  }

  openStatePollTimer = setInterval(() => {
    void pollCachedFileOpenStates();
  }, pollIntervalMs);

  console.log(`[P4Lens] Open state polling every ${pollIntervalMs}ms`);
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

async function pollCachedFileOpenStates(): Promise<void> {
  if (openStatePollRunning) {
    return;
  }

  openStatePollRunning = true;
  try {
    const changedFilePaths = await provider.clearChangedOpenStateCaches();
    if (changedFilePaths.length === 0) {
      return;
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || activeEditor.document.uri.scheme !== 'file') {
      return;
    }

    if (changedFilePaths.includes(activeEditor.document.uri.fsPath)) {
      markRefreshRequested(activeEditor);
    }
  } finally {
    openStatePollRunning = false;
  }
}

function getOpenStatePollIntervalMs(): number {
  const configuredSeconds = vscode.workspace
    .getConfiguration('p4LensLite')
    .get<number>(OPEN_STATE_POLL_INTERVAL_SECONDS_CONFIG_KEY, DEFAULT_OPEN_STATE_POLL_INTERVAL_SECONDS);

  if (!Number.isFinite(configuredSeconds) || configuredSeconds <= 0) {
    return 0;
  }

  return configuredSeconds * 1000;
}

function getOpenStatePollIntervalConfigurationPath(): string {
  return `p4LensLite.${OPEN_STATE_POLL_INTERVAL_SECONDS_CONFIG_KEY}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

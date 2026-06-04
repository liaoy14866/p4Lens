import * as vscode from 'vscode';
import { P4DecorationController } from './p4DecorationController';
import {
  COMMAND_CHECK_OPEN_STATE_CACHE,
  COMMAND_COPY_CHANGELIST_NUMBER,
  CONFIG_KEY_OPEN_STATE_POLL_INTERVAL_SECONDS,
  DESCRIPTION_TRACE_CONFIGURATION_PREFIX,
  TEXT_COPY_CLIPBOARD_MESSAGE,
} from './constDefine';
import {
  ENABLE_SYMBOL_CODELENS_CONFIG_KEY,
  P4SymbolDisplayService,
  SYMBOL_CODELENS_NOOP_COMMAND,
} from './p4SymbolCodeLens';
import { P4HoverProvider } from './p4HoverProvider';
import { P4LensDataService } from './p4LensDataService';
import { P4SymbolCodeLensProvider } from './p4SymbolCodeLensProvider';
import { buildExtensionConfigPath, buildLogMessage, formatString } from './stringUtils';

let dataService: P4LensDataService;
let decorationController: P4DecorationController;
let hoverProvider: P4HoverProvider;
let codeLensProvider: P4SymbolCodeLensProvider;
let pendingEditorForRefresh: vscode.TextEditor | undefined;
let refreshLoopRunning = false;
let lastRefreshCompletedAt = 0;
let openStatePollRunning = false;
const REFRESH_COOLDOWN_MS = 150;
const DECORATION_RESTORE_DELAY_MS = 5000;
const DEFAULT_OPEN_STATE_POLL_INTERVAL_SECONDS = 10;
let showDecorationTimer: NodeJS.Timeout | undefined;
let openStatePollTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log(buildLogMessage('Activating extension...'));

  dataService = new P4LensDataService();
  const symbolDisplayService = new P4SymbolDisplayService({
    getAnnotations: (document) => dataService.getAnnotations(document),
    getDisplayAnnotations: (document, annotations) => dataService.getDisplayAnnotations(document, annotations),
  });
  decorationController = new P4DecorationController(dataService);
  hoverProvider = new P4HoverProvider(dataService, decorationController, symbolDisplayService);
  codeLensProvider = new P4SymbolCodeLensProvider(symbolDisplayService);

  // Listen to active editor changes
  const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
    (editor) => {
      if (editor) {
        console.log(buildLogMessage('Active editor changed: {0}', editor.document.uri.fsPath));
        markRefreshRequested(editor);
      }
    }
  );
  context.subscriptions.push(editorChangeDisposable);

  const selectionChangeDisposable = vscode.window.onDidChangeTextEditorSelection((event) => {
    if (event.textEditor.document.uri.scheme === 'file') {
      console.log(buildLogMessage('Selection changed: {0}', event.textEditor.document.uri.fsPath));
      markRefreshRequested(event.textEditor);
    }
  });
  context.subscriptions.push(selectionChangeDisposable);

  const documentOpenDisposable = vscode.workspace.onDidOpenTextDocument((document) => {
    console.log(buildLogMessage('Document opened: {0}', document.uri.fsPath));
    if (vscode.window.activeTextEditor?.document.uri.fsPath === document.uri.fsPath) {
      markRefreshRequested(vscode.window.activeTextEditor);
    }
  });
  context.subscriptions.push(documentOpenDisposable);

  const documentChangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.scheme !== 'file') {
      return;
    }

    console.log(buildLogMessage('Document changed: {0}, changes={1}', event.document.uri.fsPath, event.contentChanges.length));

    if (event.contentChanges.length > 0) {
      hideDecorationWhileTyping();
    }

    dataService.clearCache(event.document.uri.fsPath);
    codeLensProvider.clearCache(event.document.uri.fsPath);
    codeLensProvider.refresh();
    if (vscode.window.activeTextEditor?.document.uri.fsPath === event.document.uri.fsPath) {
      markRefreshRequested(vscode.window.activeTextEditor);
    }
  });
  context.subscriptions.push(documentChangeDisposable);

  const documentSaveDisposable = vscode.workspace.onDidSaveTextDocument((document) => {
    if (document.uri.scheme !== 'file') {
      return;
    }

    console.log(buildLogMessage('Document saved: {0}', document.uri.fsPath));

    dataService.clearCache(document.uri.fsPath);
    codeLensProvider.clearCache(document.uri.fsPath);
    codeLensProvider.refresh();
    if (vscode.window.activeTextEditor?.document.uri.fsPath === document.uri.fsPath) {
      markRefreshRequested(vscode.window.activeTextEditor);
    }
  });
  context.subscriptions.push(documentSaveDisposable);

  const configurationChangeDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    console.log(buildLogMessage('Configuration changed'));

    if (event.affectsConfiguration(getOpenStatePollIntervalConfigurationPath())) {
      restartOpenStatePollTimer();
    }

    if (event.affectsConfiguration(getEnableSymbolCodeLensConfigurationPath())) {
      codeLensProvider.clearCache();
      codeLensProvider.refresh();
    }

    if (event.affectsConfiguration(DESCRIPTION_TRACE_CONFIGURATION_PREFIX)) {
      dataService.clearDescribeCache();
      codeLensProvider.clearCache();
      codeLensProvider.refresh();
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor?.document.uri.scheme === 'file') {
        markRefreshRequested(activeEditor);
      }
    }
  });
  context.subscriptions.push(configurationChangeDisposable);

  const manualCheckCommandDisposable = vscode.commands.registerCommand(
    COMMAND_CHECK_OPEN_STATE_CACHE,
    async () => {
      await pollCachedFileOpenStates();
    }
  );
  context.subscriptions.push(manualCheckCommandDisposable);

  const copyClCommandDisposable = vscode.commands.registerCommand(
    COMMAND_COPY_CHANGELIST_NUMBER,
    async (changeNum: string) => {
      await vscode.env.clipboard.writeText(changeNum);
      vscode.window.showInformationMessage(formatString(TEXT_COPY_CLIPBOARD_MESSAGE, changeNum));
    }
  );
  context.subscriptions.push(copyClCommandDisposable);

  const noopSymbolCodeLensDisposable = vscode.commands.registerCommand(
    SYMBOL_CODELENS_NOOP_COMMAND,
    () => undefined
  );
  context.subscriptions.push(noopSymbolCodeLensDisposable);

  const hoverProviderDisposable = vscode.languages.registerHoverProvider(
    { scheme: 'file' },
    hoverProvider
  );
  context.subscriptions.push(hoverProviderDisposable);

  const codeLensProviderDisposable = vscode.languages.registerCodeLensProvider(
    { scheme: 'file' },
    codeLensProvider
  );
  context.subscriptions.push(codeLensProviderDisposable);
  console.log(buildLogMessage('CodeLens provider registered'));

  // Update selected-line decoration for current editor on activation
  if (vscode.window.activeTextEditor) {
    markRefreshRequested(vscode.window.activeTextEditor);
  }

  restartOpenStatePollTimer();

  context.subscriptions.push(decorationController, codeLensProvider);

  console.log(buildLogMessage('Extension activated successfully'));
}

export function deactivate() {
  pendingEditorForRefresh = undefined;
  clearShowDecorationTimer();
  clearOpenStatePollTimer();
  console.log(buildLogMessage('Extension deactivated'));
}

function hideDecorationWhileTyping(): void {
  decorationController.setShowDecoration(false, vscode.window.activeTextEditor);
  clearShowDecorationTimer();
  showDecorationTimer = setTimeout(() => {
    showDecorationTimer = undefined;
    decorationController.setShowDecoration(true);

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
    console.log(buildLogMessage('Open state polling disabled'));
    return;
  }

  openStatePollTimer = setInterval(() => {
    void pollCachedFileOpenStates();
  }, pollIntervalMs);

  console.log(buildLogMessage('Open state polling every {0}ms', pollIntervalMs));
}

function markRefreshRequested(editor: vscode.TextEditor): void {
  console.log(buildLogMessage('Refresh requested: {0}', editor.document.uri.fsPath));
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
        console.log(buildLogMessage('Refreshing decoration: {0}', editorToRefresh.document.uri.fsPath));
        await decorationController.updateDecorationsForSelection(editorToRefresh);
      } catch (error) {
        console.error(buildLogMessage('Refresh failed: {0}', String(error)));
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
    const changedFilePaths = await dataService.clearChangedOpenStateCaches();
    for (const filePath of changedFilePaths) {
      codeLensProvider.clearCache(filePath);
    }

    if (codeLensProvider.hasPendingSymbolProviderRefresh()) {
      console.log(buildLogMessage('Poll detected pending symbol provider refresh'));
      codeLensProvider.refresh();
    }

    if (changedFilePaths.length === 0) {
      return;
    }

    codeLensProvider.refresh();

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
    .get<number>(CONFIG_KEY_OPEN_STATE_POLL_INTERVAL_SECONDS, DEFAULT_OPEN_STATE_POLL_INTERVAL_SECONDS);

  if (!Number.isFinite(configuredSeconds) || configuredSeconds <= 0) {
    return 0;
  }

  return configuredSeconds * 1000;
}

function getOpenStatePollIntervalConfigurationPath(): string {
  return buildExtensionConfigPath(CONFIG_KEY_OPEN_STATE_POLL_INTERVAL_SECONDS);
}

function getEnableSymbolCodeLensConfigurationPath(): string {
  return buildExtensionConfigPath(ENABLE_SYMBOL_CODELENS_CONFIG_KEY);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

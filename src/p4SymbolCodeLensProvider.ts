import * as vscode from 'vscode';
import {
  buildCodeLensTitle,
  buildCodeLensTooltip,
  createSymbolRangeKey,
  P4SymbolDisplayService,
  SYMBOL_CODELENS_NOOP_COMMAND,
} from './p4SymbolCodeLens';
import { buildLogMessage } from './stringUtils';

export class P4SymbolCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly codeLensChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.codeLensChangeEmitter.event;

  constructor(private readonly symbolDisplayService: P4SymbolDisplayService) {}

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const symbolData = await this.symbolDisplayService.getSymbolData(document);
    if (!symbolData) {
      return [];
    }

    const codeLenses: vscode.CodeLens[] = [];
    for (const symbol of symbolData.symbols) {
      const summary = symbolData.collaboratorSummaryByRangeKey.get(createSymbolRangeKey(symbol));
      const title = buildCodeLensTitle(summary);
      if (!title) {
        continue;
      }

      const anchorPosition = new vscode.Position(symbol.anchorLine - 1, 0);
      codeLenses.push(new vscode.CodeLens(
        new vscode.Range(anchorPosition, anchorPosition),
        {
          title,
          command: SYMBOL_CODELENS_NOOP_COMMAND,
          tooltip: buildCodeLensTooltip(summary),
        }
      ));
    }

    console.log(buildLogMessage('CodeLens generated {0} entries for {1}', codeLenses.length, document.uri.fsPath));
    return codeLenses;
  }

  refresh(): void {
    console.log(buildLogMessage('CodeLens refresh requested'));
    this.codeLensChangeEmitter.fire();
  }

  clearCache(filePath?: string): void {
    this.symbolDisplayService.clearCache(filePath);
  }

  hasPendingSymbolProviderRefresh(): boolean {
    return this.symbolDisplayService.hasPendingRefresh();
  }

  dispose(): void {
    this.codeLensChangeEmitter.dispose();
  }
}

import * as vscode from 'vscode';
import { LineAnnotation } from './p4Command';
import {
  COMMAND_NOOP_SYMBOL_CODELENS,
  CONFIG_KEY_ENABLE_SYMBOL_CODELENS,
  TEXT_CONTRIBUTORS,
  TEXT_LINE,
  TEXT_LINES,
  TEXT_SYMBOL_CLASS,
  TEXT_SYMBOL_FUNCTION,
  TEXT_SYMBOL_INTERFACE,
  TEXT_SYMBOL_STRUCT,
  TEXT_UNCOMMITTED_PARENS,
} from './constDefine';
import { buildLogMessage, formatString } from './stringUtils';

const MAX_VISIBLE_CONTRIBUTORS = 2;

export const ENABLE_SYMBOL_CODELENS_CONFIG_KEY = CONFIG_KEY_ENABLE_SYMBOL_CODELENS;
export const SYMBOL_CODELENS_NOOP_COMMAND = COMMAND_NOOP_SYMBOL_CODELENS;

export type SupportedSymbolKind = 'class' | 'interface' | 'struct' | 'function';

export interface SymbolDescriptor {
  kind: SupportedSymbolKind;
  name: string;
  startLine: number;
  endLine: number;
  anchorLine: number;
}

export interface SymbolContributor {
  user: string;
  sourceType: 'depot' | 'local';
  lineCount: number;
}

export interface SymbolCollaboratorSummary {
  contributors: SymbolContributor[];
  hasLocalChanges: boolean;
}

export interface CachedSymbolData {
  documentVersion: number;
  symbols: SymbolDescriptor[];
  collaboratorSummaryByRangeKey: Map<string, SymbolCollaboratorSummary>;
  hasSymbolProviderResult: boolean;
}

interface P4SymbolCodeLensFeatureDependencies {
  getAnnotations(document: vscode.TextDocument): Promise<Map<number, LineAnnotation> | undefined>;
  getDisplayAnnotations(
    document: vscode.TextDocument,
    annotations: Map<number, LineAnnotation>
  ): Promise<Map<number, LineAnnotation>>;
}

export class P4SymbolDisplayService {
  private cachedSymbolDataByFile: Map<string, CachedSymbolData> = new Map();
  private pendingSymbolProviderRefreshByFile: Map<string, number> = new Map();

  constructor(private readonly dependencies: P4SymbolCodeLensFeatureDependencies) {}

  async getSymbolData(document: vscode.TextDocument): Promise<CachedSymbolData | undefined> {
    console.log(buildLogMessage('Symbol data requested: {0}, version={1}', document.uri.fsPath, document.version));

    if (document.uri.scheme !== 'file' || !this.isSymbolCodeLensEnabled()) {
      console.log(buildLogMessage('Symbol data skipped: scheme={0}, enabled={1}', document.uri.scheme, this.isSymbolCodeLensEnabled()));
      return undefined;
    }

    const symbolData = await this.getOrBuildSymbolData(document);
    if (!symbolData) {
      console.log(buildLogMessage('Symbol data unavailable for {0}', document.uri.fsPath));
      return undefined;
    }

    return symbolData;
  }

  clearCache(filePath?: string): void {
    if (filePath) {
      this.cachedSymbolDataByFile.delete(filePath);
      this.pendingSymbolProviderRefreshByFile.delete(filePath);
      return;
    }

    this.cachedSymbolDataByFile.clear();
    this.pendingSymbolProviderRefreshByFile.clear();
  }

  hasPendingRefresh(): boolean {
    return this.pendingSymbolProviderRefreshByFile.size > 0;
  }

  private async getOrBuildSymbolData(document: vscode.TextDocument): Promise<CachedSymbolData | undefined> {
    const filePath = document.uri.fsPath;
    const cachedData = this.cachedSymbolDataByFile.get(filePath);
    if (cachedData && cachedData.documentVersion === document.version) {
      console.log(buildLogMessage(
        'CodeLens symbol cache hit: {0}, version={1}, symbols={2}, hasProviderResult={3}',
        filePath,
        document.version,
        cachedData.symbols.length,
        cachedData.hasSymbolProviderResult
      ));
      return cachedData;
    }

    const symbolLoadResult = await loadSupportedSymbols(document);
    if (!symbolLoadResult.hasProviderResult) {
      console.log(buildLogMessage('CodeLens symbol provider not ready for {0}', filePath));
      this.pendingSymbolProviderRefreshByFile.set(filePath, document.version);
      return undefined;
    }

    this.pendingSymbolProviderRefreshByFile.delete(filePath);

    if (symbolLoadResult.symbols.length === 0) {
      console.log(buildLogMessage('CodeLens symbol provider returned 0 supported symbols for {0}', filePath));
      const emptySymbolData: CachedSymbolData = {
        documentVersion: document.version,
        symbols: [],
        collaboratorSummaryByRangeKey: new Map(),
        hasSymbolProviderResult: true,
      };
      this.cachedSymbolDataByFile.set(filePath, emptySymbolData);
      return emptySymbolData;
    }

    const annotations = await this.dependencies.getAnnotations(document);
    if (!annotations) {
      console.log(buildLogMessage('CodeLens skipped: no annotations for {0}', filePath));
      return undefined;
    }

    const displayAnnotations = await this.dependencies.getDisplayAnnotations(document, annotations);
    const collaboratorSummaryByRangeKey = new Map<string, SymbolCollaboratorSummary>();
    for (const symbol of symbolLoadResult.symbols) {
      collaboratorSummaryByRangeKey.set(
        createSymbolRangeKey(symbol),
        buildSymbolCollaboratorSummary(symbol, displayAnnotations, document.lineCount)
      );
    }

    const symbolData: CachedSymbolData = {
      documentVersion: document.version,
      symbols: symbolLoadResult.symbols,
      collaboratorSummaryByRangeKey,
      hasSymbolProviderResult: true,
    };
    this.cachedSymbolDataByFile.set(filePath, symbolData);
    console.log(buildLogMessage('CodeLens symbol cache built: {0}, symbols={1}', filePath, symbolData.symbols.length));
    return symbolData;
  }

  private isSymbolCodeLensEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('p4LensLite')
      .get<boolean>(CONFIG_KEY_ENABLE_SYMBOL_CODELENS, true);
  }
}

export async function loadSupportedSymbols(document: vscode.TextDocument): Promise<{
  hasProviderResult: boolean;
  symbols: SymbolDescriptor[];
}> {
  try {
    const symbolResult = await vscode.commands.executeCommand<(vscode.DocumentSymbol[] | vscode.SymbolInformation[])>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );
    if (!symbolResult) {
      console.log(buildLogMessage('Symbol provider returned undefined for {0}', document.uri.fsPath));
      return {
        hasProviderResult: false,
        symbols: [],
      };
    }

    if (symbolResult.length === 0) {
      console.log(buildLogMessage('Symbol provider returned empty list for {0}', document.uri.fsPath));
      return {
        hasProviderResult: true,
        symbols: [],
      };
    }

    if (isDocumentSymbol(symbolResult[0])) {
      const flattenedSymbols = flattenDocumentSymbols(symbolResult as vscode.DocumentSymbol[]);
      console.log(buildLogMessage('Symbol provider returned {0} supported document symbols for {1}', flattenedSymbols.length, document.uri.fsPath));
      return {
        hasProviderResult: true,
        symbols: flattenedSymbols,
      };
    }

    const filteredSymbols = filterSymbolInformation(symbolResult as vscode.SymbolInformation[]);
    console.log(buildLogMessage('Symbol provider returned {0} supported flat symbols for {1}', filteredSymbols.length, document.uri.fsPath));
    return {
      hasProviderResult: true,
      symbols: filteredSymbols,
    };
  } catch (error) {
    console.log(buildLogMessage('Symbol provider unavailable for {0}: {1}', document.uri.fsPath, String(error)));
    return {
      hasProviderResult: false,
      symbols: [],
    };
  }
}

export function buildSymbolCollaboratorSummary(
  symbol: SymbolDescriptor,
  annotations: Map<number, LineAnnotation>,
  documentLineCount: number
): SymbolCollaboratorSummary {
  const contributorByUser = new Map<string, SymbolContributor>();
  const startLine = Math.max(1, symbol.startLine);
  const endLine = Math.min(documentLineCount, symbol.endLine);

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
    const annotation = annotations.get(lineNumber);
    if (!annotation) {
      continue;
    }

    const contributor = contributorByUser.get(annotation.user);
    if (contributor) {
      contributor.lineCount++;
      continue;
    }

    contributorByUser.set(annotation.user, {
      user: annotation.user,
      sourceType: annotation.sourceType,
      lineCount: 1,
    });
  }

  const contributors = Array.from(contributorByUser.values()).sort((left, right) => {
    if (right.lineCount !== left.lineCount) {
      return right.lineCount - left.lineCount;
    }

    return left.user.localeCompare(right.user);
  });

  return {
    contributors,
    hasLocalChanges: contributors.some((contributor) => contributor.sourceType === 'local'),
  };
}

export function buildCodeLensTitle(summary: SymbolCollaboratorSummary | undefined): string | undefined {
  if (!summary || summary.contributors.length === 0) {
    return undefined;
  }

  const localContributor = summary.contributors.find((contributor) => contributor.sourceType === 'local');
  const depotContributors = summary.contributors.filter((contributor) => contributor.sourceType === 'depot');
  if (!localContributor && depotContributors.length === 0) {
    return undefined;
  }

  const visibleDepotUsers = depotContributors
    .slice(0, MAX_VISIBLE_CONTRIBUTORS)
    .map((contributor) => contributor.user);
  const hiddenDepotCount = Math.max(0, depotContributors.length - visibleDepotUsers.length);

  const titleParts: string[] = [];
  if (localContributor) {
    titleParts.push(TEXT_UNCOMMITTED_PARENS);
  }
  titleParts.push(...visibleDepotUsers);

  let title = titleParts.join(', ');
  if (hiddenDepotCount > 0) {
    title = formatString('{0} +{1}', title, hiddenDepotCount);
  }

  return title;
}

export function buildCodeLensTooltip(summary: SymbolCollaboratorSummary | undefined): string | undefined {
  if (!summary || summary.contributors.length === 0) {
    return undefined;
  }

  const contributorLines = summary.contributors.map((contributor) => {
    if (contributor.sourceType === 'local') {
      return formatString('- {0}', TEXT_UNCOMMITTED_PARENS);
    }

    return formatString('- {0}', contributor.user);
  });

  return [TEXT_CONTRIBUTORS, ...contributorLines].join('\n');
}

export function buildSymbolCodeLensHoverMarkdown(
  symbol: SymbolDescriptor,
  summary: SymbolCollaboratorSummary,
  escapeMarkdown: (text: string) => string
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const escapedSymbolName = escapeMarkdown(symbol.name);
  md.appendMarkdown(formatString('**{0} {1}**\n\n', getSymbolLabel(symbol), escapedSymbolName));

  for (const contributor of summary.contributors) {
    const contributorLabel = contributor.sourceType === 'local'
      ? TEXT_UNCOMMITTED_PARENS
      : contributor.user;
    const escapedContributor = escapeMarkdown(contributorLabel);
    const lineLabel = contributor.lineCount === 1 ? TEXT_LINE : TEXT_LINES;
    md.appendMarkdown(formatString('- {0}: {1} {2}\n', escapedContributor, contributor.lineCount, lineLabel));
  }

  return md;
}

export function createSymbolRangeKey(symbol: SymbolDescriptor): string {
  return `${symbol.anchorLine}:${symbol.startLine}:${symbol.endLine}:${symbol.kind}:${symbol.name}`;
}

export function isPossibleCodeLensHoverPosition(document: vscode.TextDocument, position: vscode.Position): boolean {
  const line = document.lineAt(position.line);
  const hoverEndCharacter = Math.max(1, line.firstNonWhitespaceCharacterIndex + 1);
  return position.character <= hoverEndCharacter;
}

export function createSymbolCodeLensHoverRange(document: vscode.TextDocument, lineIndex: number): vscode.Range {
  const line = document.lineAt(lineIndex);
  const hoverEndCharacter = Math.max(1, line.firstNonWhitespaceCharacterIndex + 1);
  return new vscode.Range(lineIndex, 0, lineIndex, hoverEndCharacter);
}

function flattenDocumentSymbols(symbols: vscode.DocumentSymbol[]): SymbolDescriptor[] {
  const flattenedSymbols: SymbolDescriptor[] = [];

  for (const symbol of symbols) {
    const descriptor = createSymbolDescriptor(
      symbol.kind,
      symbol.name,
      symbol.range,
      symbol.selectionRange.start.line + 1
    );
    if (descriptor) {
      flattenedSymbols.push(descriptor);
    }

    flattenedSymbols.push(...flattenDocumentSymbols(symbol.children));
  }

  return flattenedSymbols;
}

function filterSymbolInformation(symbols: vscode.SymbolInformation[]): SymbolDescriptor[] {
  const descriptors: SymbolDescriptor[] = [];
  for (const symbol of symbols) {
    const descriptor = createSymbolDescriptor(
      symbol.kind,
      symbol.name,
      symbol.location.range,
      symbol.location.range.start.line + 1
    );
    if (descriptor) {
      descriptors.push(descriptor);
    }
  }

  return descriptors;
}

function createSymbolDescriptor(
  kind: vscode.SymbolKind,
  name: string,
  range: vscode.Range,
  anchorLine: number
): SymbolDescriptor | undefined {
  const symbolKind = mapSupportedSymbolKind(kind);
  if (!symbolKind) {
    return undefined;
  }

  return {
    kind: symbolKind,
    name,
    startLine: range.start.line + 1,
    endLine: range.end.line + 1,
    anchorLine,
  };
}

function mapSupportedSymbolKind(kind: vscode.SymbolKind): SupportedSymbolKind | undefined {
  if (kind === vscode.SymbolKind.Class) {
    return 'class';
  }

  if (kind === vscode.SymbolKind.Interface) {
    return 'interface';
  }

  if (kind === vscode.SymbolKind.Struct) {
    return 'struct';
  }

  if (
    kind === vscode.SymbolKind.Function ||
    kind === vscode.SymbolKind.Method ||
    kind === vscode.SymbolKind.Constructor
  ) {
    return 'function';
  }

  return undefined;
}

function getSymbolLabel(symbol: SymbolDescriptor): string {
  if (symbol.kind === 'class') {
    return TEXT_SYMBOL_CLASS;
  }

  if (symbol.kind === 'interface') {
    return TEXT_SYMBOL_INTERFACE;
  }

  if (symbol.kind === 'struct') {
    return TEXT_SYMBOL_STRUCT;
  }

  return TEXT_SYMBOL_FUNCTION;
}

function isDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation
): symbol is vscode.DocumentSymbol {
  return 'selectionRange' in symbol;
}

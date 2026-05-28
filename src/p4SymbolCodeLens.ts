import * as vscode from 'vscode';
import { LineAnnotation } from './p4Command';

const MAX_VISIBLE_CONTRIBUTORS = 2;

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
      console.log(`[P4Lens] Symbol provider returned undefined for ${document.uri.fsPath}`);
      return {
        hasProviderResult: false,
        symbols: [],
      };
    }

    if (symbolResult.length === 0) {
      console.log(`[P4Lens] Symbol provider returned empty list for ${document.uri.fsPath}`);
      return {
        hasProviderResult: true,
        symbols: [],
      };
    }

    if (isDocumentSymbol(symbolResult[0])) {
      const flattenedSymbols = flattenDocumentSymbols(symbolResult as vscode.DocumentSymbol[]);
      console.log(`[P4Lens] Symbol provider returned ${flattenedSymbols.length} supported document symbols for ${document.uri.fsPath}`);
      return {
        hasProviderResult: true,
        symbols: flattenedSymbols,
      };
    }

    const filteredSymbols = filterSymbolInformation(symbolResult as vscode.SymbolInformation[]);
    console.log(`[P4Lens] Symbol provider returned ${filteredSymbols.length} supported flat symbols for ${document.uri.fsPath}`);
    return {
      hasProviderResult: true,
      symbols: filteredSymbols,
    };
  } catch (error) {
    console.log(`[P4Lens] Symbol provider unavailable for ${document.uri.fsPath}: ${error}`);
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
    titleParts.push('(uncommitted)');
  }
  titleParts.push(...visibleDepotUsers);

  let title = `${titleParts.join(', ')}`;
  if (hiddenDepotCount > 0) {
    title += ` +${hiddenDepotCount}`;
  }

  return title;
}

export function buildCodeLensTooltip(summary: SymbolCollaboratorSummary | undefined): string | undefined {
  if (!summary || summary.contributors.length === 0) {
    return undefined;
  }

  const contributorLines = summary.contributors.map((contributor) => {
    if (contributor.sourceType === 'local') {
      return '- (uncommitted)';
    }

    return `- ${contributor.user}`;
  });

  return ['Contributors:', ...contributorLines].join('\n');
}

export function buildSymbolCodeLensHoverMarkdown(
  symbol: SymbolDescriptor,
  summary: SymbolCollaboratorSummary,
  escapeMarkdown: (text: string) => string
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const escapedSymbolName = escapeMarkdown(symbol.name);
  md.appendMarkdown(`**${getSymbolLabel(symbol)} ${escapedSymbolName}**\n\n`);

  for (const contributor of summary.contributors) {
    const contributorLabel = contributor.sourceType === 'local'
      ? '(uncommitted)'
      : contributor.user;
    const escapedContributor = escapeMarkdown(contributorLabel);
    const lineLabel = contributor.lineCount === 1 ? 'line' : 'lines';
    md.appendMarkdown(`- ${escapedContributor}: ${contributor.lineCount} ${lineLabel}\n`);
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
    return 'Class';
  }

  if (symbol.kind === 'interface') {
    return 'Interface';
  }

  if (symbol.kind === 'struct') {
    return 'Struct';
  }

  return 'Function';
}

function isDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation
): symbol is vscode.DocumentSymbol {
  return 'selectionRange' in symbol;
}

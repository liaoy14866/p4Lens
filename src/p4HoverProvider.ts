import * as vscode from 'vscode';
import { ChangelistDetails, ChangelistTraceByDescInfo } from './p4Command';
import {
  appendHoverSection,
  escapeMarkdown,
  P4LensDataService,
} from './p4LensDataService';
import { P4DecorationController } from './p4DecorationController';
import {
  buildCodeLensTitle,
  buildSymbolCodeLensHoverMarkdown,
  createSymbolCodeLensHoverRange,
  createSymbolRangeKey,
  isPossibleCodeLensHoverPosition,
  P4SymbolDisplayService,
} from './p4SymbolCodeLens';

export class P4HoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly dataService: P4LensDataService,
    private readonly decorationController: P4DecorationController,
    private readonly symbolDisplayService: P4SymbolDisplayService,
  ) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const symbolHover = await this.provideSymbolHover(document, position);
    if (symbolHover) {
      return symbolHover;
    }

    return this.provideDecorationHover(document, position);
  }

  private async provideSymbolHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    if (!isPossibleCodeLensHoverPosition(document, position)) {
      return undefined;
    }

    const symbolData = await this.symbolDisplayService.getSymbolData(document);
    if (!symbolData) {
      return undefined;
    }

    const hoveredLineNumber = position.line + 1;
    for (const symbol of symbolData.symbols) {
      if (symbol.anchorLine !== hoveredLineNumber) {
        continue;
      }

      const summary = symbolData.collaboratorSummaryByRangeKey.get(createSymbolRangeKey(symbol));
      if (!summary || summary.contributors.length === 0) {
        continue;
      }

      const title = buildCodeLensTitle(summary);
      if (!title) {
        continue;
      }

      return new vscode.Hover(
        buildSymbolCodeLensHoverMarkdown(symbol, summary, escapeMarkdown),
        createSymbolCodeLensHoverRange(document, position.line)
      );
    }

    return undefined;
  }

  private async provideDecorationHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const line = document.lineAt(position.line);
    if (position.character < line.range.end.character - 2) {
      return undefined;
    }

    const annotations = await this.dataService.getAnnotations(document);
    if (!annotations) {
      return undefined;
    }

    const annotation = annotations.get(position.line + 1);
    if (!annotation || annotation.sourceType === 'local') {
      return undefined;
    }

    const details = await this.dataService.getDetailsForChange(annotation.changeNum, document.uri.fsPath);
    if (!details) {
      return undefined;
    }

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    appendHoverSection(md, 'Current Version', details);
    this.appendTraceSections(md, details.traceByDescInfo, 1);

    const decorationText = this.renderDecorationText(annotation.changeNum, annotation.user, details);
    const decorationWidth = this.decorationController.calculateDecorationWidth(decorationText);
    const hoverRange = new vscode.Range(
      position.line,
      line.range.end.character,
      position.line,
      line.range.end.character + decorationWidth
    );
    return new vscode.Hover(md, hoverRange);
  }

  private appendTraceSections(
    md: vscode.MarkdownString,
    traceInfo: ChangelistTraceByDescInfo | null,
    depth: number
  ): void {
    if (!traceInfo) {
      return;
    }

    if (traceInfo.tracedChange) {
      appendHoverSection(md, `Traced Version ${depth} (From Description)`, traceInfo.tracedChange, traceInfo.sourceSnapshot);
      this.appendTraceSections(md, traceInfo.tracedChange.traceByDescInfo, depth + 1);
      return;
    }

    const unresolvedDetails: ChangelistDetails = {
      changeNum: traceInfo.sourceSnapshot.changelist || 'N/A',
      submittedBy: traceInfo.sourceSnapshot.user || 'unknown',
      dateSubmitted: 'N/A',
      description: traceInfo.sourceSnapshot.description || 'N/A',
      traceByDescInfo: null,
    };
    appendHoverSection(md, `Traced Version ${depth} (From Description)`, unresolvedDetails, traceInfo.sourceSnapshot, false);
  }

  private renderDecorationText(changeNum: string, fallbackUser: string, details: ChangelistDetails): string {
    const earliestInfo = this.dataService.getEarliestTraceInfo(details);
    const resolvedChangeNum = earliestInfo?.changeNum || details.changeNum || changeNum;
    const submittedBy = earliestInfo?.submittedBy || details.submittedBy || fallbackUser;
    const dateSubmitted = earliestInfo?.dateSubmitted || details.dateSubmitted || 'N/A';
    const description = earliestInfo?.description || details.description || 'N/A';
    const oneLineDescription = description.replace(/\s+/g, ' ').trim();

    return `${submittedBy}, #${resolvedChangeNum}, ${dateSubmitted}, ${oneLineDescription}`;
  }
}

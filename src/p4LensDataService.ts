import * as vscode from 'vscode';
import { findP4Config } from './p4Config';
import {
  runP4Annotate,
  runP4Describe,
  runP4Diff,
  runP4Opened,
  ChangelistDetails,
  LineAnnotation,
} from './p4Command';
import { mergeAnnotationsForCurrentDocument } from './p4AnnotationMerge';
import {
  DescriptionTraceSourceSnapshot,
  getDescriptionTraceConfig,
  parseDescriptionTraceSource,
} from './p4DescriptionTrace';

type ResolvedP4Config = NonNullable<Awaited<ReturnType<typeof findP4Config>>>;

export interface EarliestTraceInfo {
  changeNum: string;
  submittedBy: string;
  dateSubmitted: string;
  description: string;
}

export class P4LensDataService {
  private readonly annotations = new Map<string, Map<number, LineAnnotation>>();
  private readonly changeDetails = new Map<string, ChangelistDetails>();
  private readonly inFlightDescribe = new Map<string, Promise<ChangelistDetails | null>>();
  private readonly p4ConfigByFile = new Map<string, ResolvedP4Config>();
  private readonly fileOpenStateByPath = new Map<string, boolean>();

  async getAnnotations(document: vscode.TextDocument): Promise<Map<number, LineAnnotation> | undefined> {
    const filePath = document.uri.fsPath;
    const cachedAnnotations = this.annotations.get(filePath);
    if (cachedAnnotations) {
      return cachedAnnotations;
    }

    const fetchedAnnotations = await this.fetchAnnotations(document);
    if (!fetchedAnnotations) {
      return undefined;
    }

    this.annotations.set(filePath, fetchedAnnotations);
    return fetchedAnnotations;
  }

  async getDisplayAnnotations(
    document: vscode.TextDocument,
    annotations?: Map<number, LineAnnotation>
  ): Promise<Map<number, LineAnnotation>> {
    const resolvedAnnotations = annotations || await this.getAnnotations(document);
    if (!resolvedAnnotations) {
      return new Map();
    }

    const filePath = document.uri.fsPath;
    const depotAnnotations = Array.from(resolvedAnnotations.values()).filter((annotation) => annotation.sourceType === 'depot');
    const fallbackUserByChangeNum = new Map<string, string>();
    for (const annotation of depotAnnotations) {
      if (!fallbackUserByChangeNum.has(annotation.changeNum)) {
        fallbackUserByChangeNum.set(annotation.changeNum, annotation.user);
      }
    }

    const uniqueChangeNums = Array.from(fallbackUserByChangeNum.keys());
    if (uniqueChangeNums.length === 0) {
      return resolvedAnnotations;
    }

    const earliestUserByChangeNum = new Map<string, string>();
    await Promise.all(uniqueChangeNums.map(async (changeNum) => {
      const details = await this.getDetailsForChange(changeNum, filePath);
      const fallbackUser = fallbackUserByChangeNum.get(changeNum) || 'unknown';
      earliestUserByChangeNum.set(changeNum, this.getEarliestTraceInfo(details)?.submittedBy || fallbackUser);
    }));

    const displayAnnotations = new Map<number, LineAnnotation>();
    for (const [lineNumber, annotation] of resolvedAnnotations.entries()) {
      if (annotation.sourceType !== 'depot') {
        displayAnnotations.set(lineNumber, annotation);
        continue;
      }

      displayAnnotations.set(lineNumber, {
        ...annotation,
        user: earliestUserByChangeNum.get(annotation.changeNum) || annotation.user,
      });
    }

    return displayAnnotations;
  }

  async getDetailsForChange(changeNum: string, filePath: string): Promise<ChangelistDetails | null> {
    const config = this.p4ConfigByFile.get(filePath);
    if (!config) {
      return null;
    }

    return this.getOrFetchDescribe(changeNum, config, filePath);
  }

  getEarliestTraceInfo(details: ChangelistDetails | null | undefined): EarliestTraceInfo | undefined {
    if (!details) {
      return undefined;
    }

    let earliestInfo: EarliestTraceInfo = {
      changeNum: details.changeNum,
      submittedBy: details.submittedBy,
      dateSubmitted: details.dateSubmitted,
      description: details.description,
    };
    let currentTraceInfo = details.traceByDescInfo;

    while (currentTraceInfo) {
      if (!currentTraceInfo.tracedChange) {
        return {
          changeNum: currentTraceInfo.sourceSnapshot.changelist || earliestInfo.changeNum,
          submittedBy: currentTraceInfo.sourceSnapshot.user || earliestInfo.submittedBy,
          dateSubmitted: earliestInfo.dateSubmitted,
          description: currentTraceInfo.sourceSnapshot.description || earliestInfo.description,
        };
      }

      earliestInfo = {
        changeNum: currentTraceInfo.tracedChange.changeNum,
        submittedBy: currentTraceInfo.tracedChange.submittedBy,
        dateSubmitted: currentTraceInfo.tracedChange.dateSubmitted,
        description: currentTraceInfo.tracedChange.description,
      };
      currentTraceInfo = currentTraceInfo.tracedChange.traceByDescInfo;
    }

    return earliestInfo;
  }

  clearCache(filePath?: string): void {
    if (filePath) {
      this.annotations.delete(filePath);
      this.p4ConfigByFile.delete(filePath);
      this.fileOpenStateByPath.delete(filePath);
      return;
    }

    this.annotations.clear();
    this.p4ConfigByFile.clear();
    this.clearDescribeCache();
    this.fileOpenStateByPath.clear();
  }

  clearDescribeCache(): void {
    this.changeDetails.clear();
    this.inFlightDescribe.clear();
  }

  async clearChangedOpenStateCaches(): Promise<string[]> {
    const changedFilePaths: string[] = [];
    const cachedFilePaths = Array.from(this.annotations.keys());

    for (const filePath of cachedFilePaths) {
      const config = this.p4ConfigByFile.get(filePath);
      if (!config) {
        continue;
      }

      const isOpen = await runP4Opened(filePath, config);
      if (isOpen === null) {
        continue;
      }

      const previousIsOpen = this.fileOpenStateByPath.get(filePath);
      if (previousIsOpen === undefined) {
        this.fileOpenStateByPath.set(filePath, isOpen);
        continue;
      }

      if (previousIsOpen === isOpen) {
        continue;
      }

      console.log(`[P4Lens] Open state changed for ${filePath}: ${previousIsOpen} -> ${isOpen}`);
      changedFilePaths.push(filePath);
      this.clearCache(filePath);
    }

    return changedFilePaths;
  }

  private async fetchAnnotations(document: vscode.TextDocument): Promise<Map<number, LineAnnotation> | undefined> {
    try {
      const filePath = document.uri.fsPath;
      const config = await findP4Config(filePath);
      if (!config) {
        console.log(`[P4Lens] No P4 config found for ${filePath}`);
        return undefined;
      }

      this.p4ConfigByFile.set(filePath, config);

      const baseAnnotations = await runP4Annotate(filePath, config);
      if (!baseAnnotations) {
        return undefined;
      }

      const diffHunks = await runP4Diff(filePath, config);
      return mergeAnnotationsForCurrentDocument(baseAnnotations, diffHunks, document.lineCount);
    } catch (error) {
      console.error(`[P4Lens] Error fetching annotations: ${error}`);
      return undefined;
    }
  }

  private async getOrFetchDescribe(
    changeNum: string,
    config: ResolvedP4Config,
    filePath: string,
    visitedChangeNums: Set<string> = new Set(),
    depth = 0
  ): Promise<ChangelistDetails | null> {
    if (visitedChangeNums.has(changeNum)) {
      console.log(`[P4Lens] Description trace cycle detected at changelist ${changeNum}`);
      return null;
    }

    const cachedDetails = this.changeDetails.get(changeNum);
    if (cachedDetails) {
      console.log(`[P4Lens] Changelist cache hit: ${changeNum}`);
      return cachedDetails;
    }

    const existingRequest = this.inFlightDescribe.get(changeNum);
    if (existingRequest) {
      return existingRequest;
    }

    console.log(`[P4Lens] Changelist cache miss: ${changeNum}`);
    const request = runP4Describe(changeNum, config, filePath)
      .then(async (details) => {
        if (!details) {
          return null;
        }

        const tracedDetails = await this.buildDescribeWithTrace(details, config, filePath, visitedChangeNums, depth);
        this.changeDetails.set(changeNum, tracedDetails);
        return tracedDetails;
      })
      .finally(() => {
        this.inFlightDescribe.delete(changeNum);
      });
    this.inFlightDescribe.set(changeNum, request);
    return request;
  }

  private async buildDescribeWithTrace(
    baseDetails: ChangelistDetails,
    config: ResolvedP4Config,
    filePath: string,
    visitedChangeNums: Set<string>,
    depth: number
  ): Promise<ChangelistDetails> {
    const details: ChangelistDetails = {
      ...baseDetails,
      traceByDescInfo: null,
    };

    const traceConfig = getDescriptionTraceConfig();
    if (!traceConfig.enabled || depth >= traceConfig.maxDepth) {
      return details;
    }

    const parsedTraceSource = parseDescriptionTraceSource(details.description, traceConfig);
    if (!parsedTraceSource) {
      return details;
    }

    const nextVisitedChangeNums = new Set(visitedChangeNums);
    nextVisitedChangeNums.add(details.changeNum);
    const tracedChange = await this.getOrFetchDescribe(
      parsedTraceSource.sourceSnapshot.changelist!,
      config,
      filePath,
      nextVisitedChangeNums,
      depth + 1
    );

    details.traceByDescInfo = {
      marker: parsedTraceSource.marker,
      parser: parsedTraceSource.parser,
      rawPayload: parsedTraceSource.rawPayload,
      sourceSnapshot: parsedTraceSource.sourceSnapshot,
      tracedChange,
    };
    return details;
  }
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+!]/g, '\\$&');
}

export function formatDescription(description: string): string {
  const trimmedDescription = description.trim();
  if (!trimmedDescription) {
    return escapeMarkdown('N/A');
  }

  const escapedLines = trimmedDescription
    .split(/\r?\n/)
    .map((line) => escapeMarkdown(line))
    .filter((line, index, allLines) => line.length > 0 || (index > 0 && index < allLines.length - 1));

  return escapedLines.join('\n\n');
}

export function buildChangelistCopyMarkdown(changeNum: string): string {
  const copyArg = encodeURIComponent(JSON.stringify(changeNum));
  return `#\`${escapeMarkdown(changeNum)}\`\u00a0\u00a0[$(copy)](command:p4lenslite.copyChangelistNumber?${copyArg})`;
}

export function appendHoverSection(
  md: vscode.MarkdownString,
  sectionTitle: string,
  details: ChangelistDetails,
  sourceSnapshot?: DescriptionTraceSourceSnapshot,
  isResolved = true
): void {
  if (md.value.length > 0) {
    md.appendMarkdown('\n\n---\n\n');
  }

  md.appendMarkdown(
    `**${escapeMarkdown(details.submittedBy)}**, ${escapeMarkdown(details.dateSubmitted)}, ${escapeMarkdown(sectionTitle)}\n\n`
  );

  if (isResolved) {
    md.appendMarkdown(`${formatDescription(details.description)}\n\n`);
    md.appendMarkdown(buildChangelistCopyMarkdown(details.changeNum));
  }

  if (!sourceSnapshot) {
    return;
  }

  const metadataLines: string[] = [];
  if (sourceSnapshot.stream) {
    metadataLines.push(`Stream: ${escapeMarkdown(sourceSnapshot.stream)}`);
  }

  if (!isResolved) {
    metadataLines.push(`Source CL: #${escapeMarkdown(sourceSnapshot.changelist || 'N/A')}`);
    if (sourceSnapshot.user) {
      metadataLines.push(`Source User: ${escapeMarkdown(sourceSnapshot.user)}`);
    }
    if (sourceSnapshot.description) {
      metadataLines.push(`Source Description: ${escapeMarkdown(sourceSnapshot.description.replace(/\s+/g, ' ').trim())}`);
    }
    metadataLines.push('Unable to resolve the traced changelist.');
  }

  if (metadataLines.length > 0) {
    md.appendMarkdown(`\n\n${metadataLines.join('  \n')}`);
  }
}

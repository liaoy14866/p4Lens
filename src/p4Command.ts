import { execFileSync } from 'child_process';
import * as path from 'path';
import { P4Config } from './p4Config';

const P4_MAX_BUFFER = 10 * 1024 * 1024;

export interface LineAnnotation {
  lineNumber: number;
  changeNum: string;
  user: string;
  sourceType: 'depot' | 'local';
}

interface RawAnnotationLine {
  lineNumber: number;
  changeNum: string;
}

export interface P4DiffHunk {
  baseStart: number;
  baseCount: number;
  currentStart: number;
  currentCount: number;
  lines: string[];
}

export interface ChangelistDetails {
  changeNum: string;
  dateSubmitted: string;
  submittedBy: string;
  description: string;
}

enum Direction {
  TO,
  FROM,
}

interface FileLogIntegration {
  file: string;
  startRev?: string;
  endRev: string;
  operation: string;
  direction: Direction;
}

interface FileLogItem {
  file: string;
  description: string;
  revision: string;
  chnum: string;
  operation: string;
  date?: Date;
  user: string;
  client: string;
  integrations: FileLogIntegration[];
}

/**
 * Execute p4 annotate command and parse the output
 * @param filePath The path to the file to annotate
 * @param config The P4 configuration
 * @returns A map of line numbers to annotation info, or null if command fails
 */
export async function runP4Annotate(
  filePath: string,
  config: P4Config
): Promise<Map<number, LineAnnotation> | null> {
  try {
    const { env, cwd } = buildP4ExecOptions(config, filePath);

    console.log(`[P4Lens] Executing: p4 annotate -q -c -i "${filePath}"`);
    const annotateOutput = execFileSync('p4', ['annotate', '-q', '-c', '-i', filePath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
      maxBuffer: P4_MAX_BUFFER,
    });

    const rawAnnotations = parseP4AnnotateOutput(annotateOutput);
    if (rawAnnotations.length === 0) {
      console.log('[P4Lens] No annotate lines parsed');
      return new Map<number, LineAnnotation>();
    }

    console.log(`[P4Lens] Executing: p4 filelog -l -t -i "${filePath}"`);
    const fileLogOutput = execFileSync('p4', ['filelog', '-l', '-t', '-i', filePath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
      maxBuffer: P4_MAX_BUFFER,
    });

    const fileLog = parseP4FilelogOutput(fileLogOutput);
    const expandedLogs = await expandIntegratedFileLogs(filePath, config, new Set<string>(), fileLog);
    return buildIntegrationAwareAnnotations(rawAnnotations, [fileLog, ...expandedLogs]);
  } catch (err) {
    console.error(`[P4Lens] Error executing p4 annotate: ${err}`);
    return null;
  }
}

export async function runP4Diff(
  filePath: string,
  config: P4Config
): Promise<P4DiffHunk[]> {
  const { env, cwd } = buildP4ExecOptions(config, filePath);
  const diffEnv: NodeJS.ProcessEnv = { ...env };
  delete diffEnv.P4DIFF;
  delete diffEnv.P4DIFFUNICODE;

  console.log(`[P4Lens] Executing: p4 diff -du "${filePath}"`);

  try {
    const output = execFileSync('p4', ['diff', '-du', filePath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: diffEnv,
      maxBuffer: P4_MAX_BUFFER,
    });

    return parseP4DiffOutput(output);
  } catch (err) {
    const output = getCommandOutputFromError(err);
    if (output.trim()) {
      console.log('[P4Lens] p4 diff returned non-zero status; parsing captured output');
      return parseP4DiffOutput(output);
    }

    console.error(`[P4Lens] Error executing p4 diff: ${err}`);
    return [];
  }
}

export async function runP4Describe(
  changeNum: string,
  config: P4Config,
  filePath: string
): Promise<ChangelistDetails | null> {
  try {
    const { env, cwd } = buildP4ExecOptions(config, filePath);

    console.log(`[P4Lens] Executing: p4 change -o ${changeNum}`);
    const output = execFileSync('p4', ['change', '-o', changeNum], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
      maxBuffer: P4_MAX_BUFFER,
    });

    return parseP4ChangeOutput(output, changeNum);
  } catch (err) {
    console.error(`[P4Lens] Error executing p4 change: ${err}`);
    return null;
  }
}

export async function runP4Opened(
  filePath: string,
  config: P4Config
): Promise<boolean | null> {
  try {
    const { env, cwd } = buildP4ExecOptions(config, filePath);

    console.log(`[P4Lens] Executing: p4 opened "${filePath}"`);
    const output = execFileSync('p4', ['opened', filePath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
      maxBuffer: P4_MAX_BUFFER,
    });

    return output.trim().length > 0;
  } catch (err) {
    const stdout = getCommandOutputFromError(err, 'stdout');
    if (stdout.trim().length > 0) {
      return true;
    }

    const stderr = getCommandOutputFromError(err, 'stderr');
    if (/not opened on this client/i.test(stderr)) {
      return false;
    }

    console.error(`[P4Lens] Error executing p4 opened: ${err}`);
    return null;
  }
}

function buildP4ExecOptions(config: P4Config, filePath: string): { env: NodeJS.ProcessEnv; cwd: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    P4PORT: config.P4PORT || config.port || process.env.P4PORT,
    P4USER: config.P4USER || config.user || process.env.P4USER,
    P4CLIENT: config.P4CLIENT || config.client || process.env.P4CLIENT,
    P4IGNORE: config.P4IGNORE || process.env.P4IGNORE,
    P4CONFIG: process.env.P4CONFIG || 'p4config.txt',
  };

  const cwd = config.configPath ? path.dirname(config.configPath) : path.dirname(filePath);
  return { env, cwd };
}

function getCommandOutputFromError(err: unknown): string;
function getCommandOutputFromError(err: unknown, stream: 'stdout' | 'stderr'): string;
function getCommandOutputFromError(err: unknown, stream: 'stdout' | 'stderr' = 'stdout'): string {
  if (!err || typeof err !== 'object') {
    return '';
  }

  const errorWithOutput = err as { stdout?: string | Buffer; stderr?: string | Buffer };
  const output = errorWithOutput[stream];
  if (typeof output === 'string') {
    return output;
  }
  if (Buffer.isBuffer(output)) {
    return output.toString('utf-8');
  }

  return '';
}

function splitIntoLines(output: string): string[] {
  return output.split(/\r?\n/);
}

function sectionArrayBy<T>(items: T[], matcher: (item: T) => boolean): T[][] {
  const sections: T[][] = [];
  let currentSection: T[] | undefined;

  for (const item of items) {
    if (matcher(item)) {
      if (currentSection && currentSection.length > 0) {
        sections.push(currentSection);
      }
      currentSection = [item];
      continue;
    }

    if (currentSection) {
      currentSection.push(item);
    }
  }

  if (currentSection && currentSection.length > 0) {
    sections.push(currentSection);
  }

  return sections;
}

function isTruthy<T>(value: T | undefined | null): value is T {
  return value !== undefined && value !== null;
}

function parseDate(dateString: string): Date | undefined {
  const matches = /(\d{4})\/(\d{2})\/(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?/.exec(dateString.trim());
  if (!matches) {
    return undefined;
  }

  const [, year, month, day, hours, minutes, seconds] = matches;
  const hasTime = hours !== undefined && minutes !== undefined && seconds !== undefined;
  return new Date(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    hasTime ? Number.parseInt(hours, 10) : undefined,
    hasTime ? Number.parseInt(minutes, 10) : undefined,
    hasTime ? Number.parseInt(seconds, 10) : undefined,
  );
}

function dedupeByKey<T, K>(items: T[], keySelector: (item: T) => K): T[] {
  const seen = new Set<K>();
  return items.filter((item) => {
    const key = keySelector(item);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function addUniqueFiles(doneFiles: Set<string>, integrations: FileLogIntegration[]): FileLogIntegration[] {
  return integrations.filter((integration) => {
    if (doneFiles.has(integration.file)) {
      return false;
    }

    doneFiles.add(integration.file);
    return true;
  });
}

/**
 * Parse the output of p4 annotate command
 * @param output The raw output from p4 annotate
 * @returns Per-line changelist info
 */
function parseP4AnnotateOutput(output: string): RawAnnotationLine[] {
  const annotations: RawAnnotationLine[] = [];
  const lines = splitIntoLines(output);
  let unmatchedCount = 0;
  let sourceLineNumber = 1;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const matches = /^(\d+): (.*?)$/.exec(line);
    if (matches) {
      annotations.push({
        lineNumber: sourceLineNumber,
        changeNum: matches[1],
      });
      sourceLineNumber++;
    } else {
      unmatchedCount++;
      if (unmatchedCount <= 3) {
        console.log(`[P4Lens] Unmatched annotate line sample: ${line}`);
      }
    }
  }

  console.log(`[P4Lens] Parsed ${annotations.length} line annotations`);
  return annotations;
}

function parseP4FilelogOutput(output: string): FileLogItem[] {
  const lines = splitIntoLines(output);
  const fileSections = sectionArrayBy(lines, (line) => line.startsWith('//'));
  return fileSections.flatMap(parseP4FilelogFile);
}

function parseP4FilelogFile(lines: string[]): FileLogItem[] {
  if (lines.length === 0) {
    return [];
  }

  const file = lines[0];
  const historySections = sectionArrayBy(lines.slice(1), (line) => line.startsWith('... #'));
  return historySections.map((section) => parseP4FilelogItem(section, file)).filter(isTruthy);
}

function parseP4FilelogItem(lines: string[], file: string): FileLogItem | undefined {
  const [header, ...rest] = lines;
  if (!header) {
    return undefined;
  }

  const matches = /^\.\.\. #(\d+) change (\d+) (\S+) on (.*?) by (.*?)@(.*?) (.*?)$/.exec(header);
  if (!matches) {
    return undefined;
  }

  const [, revision, chnum, operation, dateString, user, client] = matches;
  const description = rest
    .filter((line) => line.startsWith('\t'))
    .map((line) => line.slice(1))
    .join('\n');
  const integrations = rest
    .filter((line) => line.startsWith('... ...'))
    .map(parseP4FilelogIntegration)
    .filter(isTruthy);

  return {
    file,
    description,
    revision,
    chnum,
    operation,
    date: parseDate(dateString),
    user,
    client,
    integrations,
  };
}

function parseP4FilelogIntegration(line: string): FileLogIntegration | undefined {
  const matches = /^\.\.\. \.\.\. (\S+) (into|from) (.*?)#(\d+)(?:,#(\d+))?$/.exec(line);
  if (!matches) {
    return undefined;
  }

  const [, operation, directionString, file, startRevString, endRevString] = matches;
  const direction = directionString === 'into' ? Direction.TO : Direction.FROM;
  const startRev = endRevString ? startRevString : undefined;
  const endRev = endRevString || startRevString;
  return {
    file,
    startRev,
    endRev,
    operation,
    direction,
  };
}

async function expandIntegratedFileLogs(
  filePath: string,
  config: P4Config,
  doneFiles: Set<string>,
  log: FileLogItem[]
): Promise<FileLogItem[][]> {
  const secondaryIntegrations = getSecondaryIntegrations(log);
  const newIntegrations = addUniqueFiles(doneFiles, secondaryIntegrations);
  if (newIntegrations.length === 0) {
    return [];
  }

  const nestedLogs = await Promise.all(newIntegrations.map((integration) => runP4Filelog(integration.file, config)));
  const expandedNestedLogs = await Promise.all(
    nestedLogs.map((nestedLog) => expandIntegratedFileLogs(filePath, config, doneFiles, nestedLog))
  );

  return nestedLogs.concat(...expandedNestedLogs);
}

async function runP4Filelog(fileSpec: string, config: P4Config): Promise<FileLogItem[]> {
  const { env, cwd } = buildP4ExecOptions(config, fileSpec);

  console.log(`[P4Lens] Executing: p4 filelog -l -t -i "${fileSpec}"`);
  const output = execFileSync('p4', ['filelog', '-l', '-t', '-i', fileSpec], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env,
    maxBuffer: P4_MAX_BUFFER,
  });

  const parsed = parseP4FilelogOutput(output);
  console.log(`[P4Lens] Parsed ${parsed.length} filelog items from ${fileSpec}`);
  return parsed;
}

function getSecondaryIntegrations(log: FileLogItem[]): FileLogIntegration[] {
  return log.flatMap((logItem) => {
    const fromIntegrations = logItem.integrations.filter((integration) => integration.direction === Direction.FROM);
    if (fromIntegrations.length > 1) {
      return fromIntegrations.filter((integration) => integration.operation === 'copy');
    }

    return [];
  });
}

function buildIntegrationAwareAnnotations(
  rawAnnotations: RawAnnotationLine[],
  allLogs: FileLogItem[][]
): Map<number, LineAnnotation> {
  const annotations = new Map<number, LineAnnotation>();
  const logsByChnum = createLogsByChnum(rawAnnotations, allLogs);

  for (const annotation of rawAnnotations) {
    const logInfo = logsByChnum.get(annotation.changeNum);
    annotations.set(annotation.lineNumber, {
      lineNumber: annotation.lineNumber,
      changeNum: annotation.changeNum,
      user: logInfo?.user || 'unknown',
      sourceType: 'depot',
    });
  }

  console.log(`[P4Lens] Built ${annotations.size} integration-aware annotations`);
  return annotations;
}

function createLogsByChnum(
  rawAnnotations: RawAnnotationLine[],
  allLogs: FileLogItem[][]
): Map<string, FileLogItem> {
  const requiredChanges = dedupeByKey(rawAnnotations, (annotation) => annotation.changeNum)
    .map((annotation) => annotation.changeNum)
    .sort((left, right) => Number.parseInt(right, 10) - Number.parseInt(left, 10));

  const logsByChnum = new Map<string, FileLogItem>();
  const missingChanges: string[] = [];

  for (const changeNum of requiredChanges) {
    const fileLog = findLogForChange(changeNum, allLogs);
    if (fileLog) {
      logsByChnum.set(changeNum, fileLog);
    } else {
      missingChanges.push(changeNum);
    }
  }

  if (missingChanges.length > 0) {
    console.log(`[P4Lens] Could not match filelog entries for changes: ${missingChanges.join(', ')}`);
  }

  return logsByChnum;
}

function findLogForChange(changeNum: string, allLogs: FileLogItem[][]): FileLogItem | undefined {
  for (const fileLogs of allLogs) {
    const match = fileLogs.find((fileLog) => fileLog.chnum === changeNum);
    if (match) {
      return match;
    }
  }

  return undefined;
}

function parseP4DiffOutput(output: string): P4DiffHunk[] {
  const hunks: P4DiffHunk[] = [];
  const lines = output.split('\n');
  let currentHunk: P4DiffHunk | null = null;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkMatch) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }

      currentHunk = {
        baseStart: Number.parseInt(hunkMatch[1], 10),
        baseCount: parseDiffRangeCount(hunkMatch[2]),
        currentStart: Number.parseInt(hunkMatch[3], 10),
        currentCount: parseDiffRangeCount(hunkMatch[4]),
        lines: [],
      };
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\')) {
      currentHunk.lines.push(line);
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  console.log(`[P4Lens] Parsed ${hunks.length} diff hunks`);
  return hunks;
}

function parseDiffRangeCount(rawCount: string | undefined): number {
  if (!rawCount) {
    return 1;
  }

  return Number.parseInt(rawCount, 10);
}

function parseP4ChangeOutput(output: string, fallbackChangeNum: string): ChangelistDetails {
  const lines = output.split('\n');
  let changeNum = fallbackChangeNum;
  let submittedBy = '';
  let dateSubmitted = '';
  const descriptionLines: string[] = [];
  let inDescription = false;

  for (const line of lines) {
    const changeMatch = line.match(/^\s*Change\s*:\s*(\d+)\s*$/i);
    if (changeMatch) {
      changeNum = changeMatch[1];
      continue;
    }

    const dateMatch = line.match(/^\s*Date\s*:\s*(.+?)\s*$/i);
    if (dateMatch) {
      dateSubmitted = dateMatch[1].trim();
      continue;
    }

    const userMatch = line.match(/^\s*User\s*:\s*(.+?)\s*$/i);
    if (userMatch) {
      submittedBy = userMatch[1].trim();
      continue;
    }

    if (/^\s*Description\s*:\s*$/i.test(line)) {
      inDescription = true;
      continue;
    }

    if (inDescription) {
      if (/^\s*[A-Z][A-Za-z]+\s*:\s*/.test(line)) {
        break;
      }

      const trimmed = line.replace(/^\t/, '').trim();
      if (trimmed.length > 0) {
        descriptionLines.push(trimmed);
      }
    }
  }

  const description = descriptionLines.join(' ').trim();
  return {
    changeNum,
    dateSubmitted,
    submittedBy,
    description,
  };
}

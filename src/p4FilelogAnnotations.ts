import { execFileSync } from 'child_process';
import { TEXT_UNKNOWN } from './constDefine';
import type { LineAnnotation } from './p4Command';
import { buildLogMessage, splitLines } from './stringUtils';

const P4_MAX_BUFFER = 10 * 1024 * 1024;

interface RawAnnotationLine {
  lineNumber: number;
  changeNum: string;
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

type BuildExecOptions = (fileSpec: string) => { env: NodeJS.ProcessEnv; cwd: string };

export async function loadIntegrationAwareAnnotations(
  filePath: string,
  rawAnnotations: RawAnnotationLine[],
  buildExecOptions: BuildExecOptions
): Promise<Map<number, LineAnnotation>> {
  console.log(buildLogMessage('Executing: p4 filelog -l -t -i "{0}"', filePath));
  const { env, cwd } = buildExecOptions(filePath);
  const fileLogOutput = execFileSync('p4', ['filelog', '-l', '-t', '-i', filePath], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env,
    maxBuffer: P4_MAX_BUFFER,
  });

  const fileLog = parseP4FilelogOutput(fileLogOutput);
  const expandedLogs = await expandIntegratedFileLogs(new Set<string>(), fileLog, buildExecOptions);
  return buildIntegrationAwareAnnotations(rawAnnotations, [fileLog, ...expandedLogs]);
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

function parseP4FilelogOutput(output: string): FileLogItem[] {
  const lines = splitLines(output);
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
  doneFiles: Set<string>,
  log: FileLogItem[],
  buildExecOptions: BuildExecOptions
): Promise<FileLogItem[][]> {
  const secondaryIntegrations = getSecondaryIntegrations(log);
  const newIntegrations = addUniqueFiles(doneFiles, secondaryIntegrations);
  if (newIntegrations.length === 0) {
    return [];
  }

  const nestedLogs = await Promise.all(newIntegrations.map((integration) => runP4Filelog(integration.file, buildExecOptions)));
  const expandedNestedLogs = await Promise.all(
    nestedLogs.map((nestedLog) => expandIntegratedFileLogs(doneFiles, nestedLog, buildExecOptions))
  );

  return nestedLogs.concat(...expandedNestedLogs);
}

async function runP4Filelog(fileSpec: string, buildExecOptions: BuildExecOptions): Promise<FileLogItem[]> {
  const { env, cwd } = buildExecOptions(fileSpec);

  console.log(buildLogMessage('Executing: p4 filelog -l -t -i "{0}"', fileSpec));
  const output = execFileSync('p4', ['filelog', '-l', '-t', '-i', fileSpec], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env,
    maxBuffer: P4_MAX_BUFFER,
  });

  const parsed = parseP4FilelogOutput(output);
  console.log(buildLogMessage('Parsed {0} filelog items from {1}', parsed.length, fileSpec));
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
      user: logInfo?.user || TEXT_UNKNOWN,
      sourceType: 'depot',
    });
  }

  console.log(buildLogMessage('Built {0} integration-aware annotations', annotations.size));
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
    console.log(buildLogMessage('Could not match filelog entries for changes: {0}', missingChanges.join(', ')));
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

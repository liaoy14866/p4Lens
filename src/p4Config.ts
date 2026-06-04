import * as fs from 'fs';
import * as path from 'path';
import { P4_CONFIG_FILE_NAME } from './constDefine';
import { buildLogMessage, splitLines } from './stringUtils';

export interface P4Config {
  port?: string;
  user?: string;
  client?: string;
  configPath?: string;
  [key: string]: string | undefined;
}

/**
 * Find and parse p4config.txt by recursively searching upwards from a given file path
 * @param filePath The path of the current file
 * @returns The parsed p4config or null if not found
 */
export async function findP4Config(filePath: string): Promise<P4Config | null> {
  let currentDir = path.dirname(filePath);
  const root = path.parse(currentDir).root;

  while (currentDir !== root) {
    const configPath = path.join(currentDir, P4_CONFIG_FILE_NAME);
    
    try {
      if (fs.existsSync(configPath)) {
        const config = parseP4ConfigFile(configPath);
        config.configPath = configPath;
        console.log(buildLogMessage('Found {0} at: {1}', P4_CONFIG_FILE_NAME, configPath));
        return config;
      }
    } catch (err) {
      console.error(buildLogMessage('Error reading {0}: {1}', P4_CONFIG_FILE_NAME, String(err)));
    }

    // Move up one directory
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break; // Reached filesystem root
    }
    currentDir = parentDir;
  }

  console.log(buildLogMessage('No {0} found for: {1}', P4_CONFIG_FILE_NAME, filePath));
  return null;
}

/**
 * Parse p4config.txt file content
 * @param configPath The path to p4config.txt
 * @returns The parsed configuration object
 */
function parseP4ConfigFile(configPath: string): P4Config {
  const content = fs.readFileSync(configPath, 'utf-8');
  const config: P4Config = {};

  const lines = splitLines(content);
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const [key, value] = trimmed.split('=');
    if (key && value) {
      config[key.trim()] = value.trim();
    }
  }

  return config;
}

import * as fs from 'fs';
import * as path from 'path';

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
    const configPath = path.join(currentDir, 'p4config.txt');
    
    try {
      if (fs.existsSync(configPath)) {
        const config = parseP4ConfigFile(configPath);
        config.configPath = configPath;
        console.log(`[P4Lens] Found p4config.txt at: ${configPath}`);
        return config;
      }
    } catch (err) {
      console.error(`[P4Lens] Error reading p4config.txt: ${err}`);
    }

    // Move up one directory
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break; // Reached filesystem root
    }
    currentDir = parentDir;
  }

  console.log(`[P4Lens] No p4config.txt found for: ${filePath}`);
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

  const lines = content.split('\n');
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

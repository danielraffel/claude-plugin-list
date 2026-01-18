import fs from "fs/promises";
import path from "path";
import { Marketplace, Plugin } from "../types";

const MARKETPLACES_FILE = path.join(process.cwd(), "lib/data/marketplaces.json");
const PLUGINS_FILE = path.join(process.cwd(), "lib/data/plugins.json");

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const fileContent = await fs.readFile(filePath, "utf-8");
    return JSON.parse(fileContent) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Error reading ${filePath}:`, error);
    }
    return fallback;
  }
}

async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await ensureDir(filePath);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Read marketplaces from local file
 */
export async function readMarketplaces(): Promise<Marketplace[]> {
  const data = await readJsonFile<Marketplace[]>(MARKETPLACES_FILE, []);
  if (data.length > 0) {
    console.log("Loaded marketplaces from local file");
  }
  return data;
}

/**
 * Write marketplaces to local file
 */
export async function writeMarketplaces(marketplaces: Marketplace[]): Promise<void> {
  await writeJsonFile(MARKETPLACES_FILE, marketplaces);
  console.log("Saved marketplaces to local file");
}

/**
 * Merge discovered marketplaces with existing ones
 * Removes marketplaces that were discovered but failed validation
 */
export async function mergeMarketplaces(
  discovered: Marketplace[],
  allDiscoveredRepos: Set<string>,
  removeUndiscovered: boolean = false
): Promise<{
  added: number;
  updated: number;
  removed: number;
  total: number;
}> {
  const existing = await readMarketplaces();
  const existingMap = new Map(existing.map((m) => [m.repo, m]));
  const discoveredRepos = new Set(discovered.map((marketplace) => marketplace.repo));

  let added = 0;
  let updated = 0;
  let removed = 0;

  // Update or add valid marketplaces
  for (const marketplace of discovered) {
    const existingMarketplace = existingMap.get(marketplace.repo);

    if (existingMarketplace) {
      // Update existing marketplace
      existingMarketplace.description = marketplace.description;
      existingMarketplace.pluginCount = marketplace.pluginCount;
      existingMarketplace.categories = marketplace.categories;
      existingMarketplace.pluginKeywords = marketplace.pluginKeywords;
      existingMarketplace.lastUpdated = new Date().toISOString();
      // Update stars if new data is available
      if (marketplace.stars !== undefined) {
        existingMarketplace.stars = marketplace.stars;
        existingMarketplace.starsFetchedAt = marketplace.starsFetchedAt;
      }
      // Keep original discoveredAt and source
      updated++;
    } else {
      // Add new marketplace
      existingMap.set(marketplace.repo, marketplace);
      added++;
    }
  }

  if (removeUndiscovered) {
    for (const [repo] of existingMap) {
      if (!allDiscoveredRepos.has(repo)) {
        existingMap.delete(repo);
        removed++;
      }
    }
  }

  // Remove marketplaces that were discovered but are now invalid
  for (const [repo] of existingMap) {
    if (allDiscoveredRepos.has(repo) && !discoveredRepos.has(repo)) {
      existingMap.delete(repo);
      removed++;
    }
  }

  const merged = Array.from(existingMap.values());
  await writeMarketplaces(merged);

  return {
    added,
    updated,
    removed,
    total: merged.length,
  };
}

/**
 * Read plugins from local file
 */
export async function readPlugins(): Promise<Plugin[]> {
  const data = await readJsonFile<Plugin[]>(PLUGINS_FILE, []);
  if (data.length > 0) {
    console.log("Loaded plugins from local file");
  }
  return data;
}

/**
 * Write plugins to local file
 */
export async function writePlugins(plugins: Plugin[]): Promise<void> {
  await writeJsonFile(PLUGINS_FILE, plugins);
  console.log("Saved plugins to local file");
}

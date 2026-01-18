#!/usr/bin/env bun
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";

const dataDir = path.join(process.cwd(), "lib/data");
const pluginsFile = path.join(dataDir, "plugins-with-metadata.json");
const marketplacesFile = path.join(dataDir, "marketplaces.json");
const metadataFile = path.join(dataDir, "metadata.json");
const statsFile = path.join(dataDir, "stats-history.json");

const args = new Set(process.argv.slice(2));
const skipSearch = args.has("--skip-search");

async function runCommand(command: string, commandArgs: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: "inherit" });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Failed to read ${filePath}:`, error);
    }
    return fallback;
  }
}

async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function resolveLatestEntry(
  history: Array<{ date: string }>,
  today: string
): { latest: number; previous: number } {
  if (history.length === 0) {
    return { latest: -1, previous: -1 };
  }
  const latestIndex = history.length - 1;
  if (history[latestIndex].date === today) {
    return {
      latest: latestIndex,
      previous: latestIndex > 0 ? latestIndex - 1 : -1,
    };
  }
  return { latest: -1, previous: latestIndex };
}

async function updateMetadata(): Promise<void> {
  const plugins = await readJsonFile<unknown[]>(pluginsFile, []);
  const marketplaces = await readJsonFile<unknown[]>(marketplacesFile, []);

  const pluginCount = Array.isArray(plugins) ? plugins.length : 0;
  const marketplaceCount = Array.isArray(marketplaces) ? marketplaces.length : 0;
  const lastUpdated = new Date().toISOString();

  const metadata = {
    lastUpdated,
    pluginCount,
    marketplaceCount,
    generatedBy: "scripts/update.ts",
  };

  await writeJsonFile(metadataFile, metadata);

  const history = await readJsonFile<
    Array<{
      date: string;
      pluginCount: number;
      marketplaceCount: number;
      newPlugins: number;
      newMarketplaces: number;
      updatedAt: string;
    }>
  >(statsFile, []);

  const today = lastUpdated.slice(0, 10);
  const { latest, previous } = resolveLatestEntry(history, today);
  const previousEntry = previous >= 0 ? history[previous] : null;
  const newPlugins = previousEntry ? pluginCount - previousEntry.pluginCount : 0;
  const newMarketplaces = previousEntry
    ? marketplaceCount - previousEntry.marketplaceCount
    : 0;

  const entry = {
    date: today,
    pluginCount,
    marketplaceCount,
    newPlugins,
    newMarketplaces,
    updatedAt: lastUpdated,
  };

  if (latest >= 0) {
    history[latest] = entry;
  } else {
    history.push(entry);
  }

  await writeJsonFile(statsFile, history);

  console.log(`Updated metadata (${pluginCount} plugins, ${marketplaceCount} marketplaces).`);
}

async function run(): Promise<void> {
  if (!skipSearch) {
    console.log("Running marketplace search...");
    await runCommand("bun", [
      "run",
      "scripts/search.ts",
      "--search-shards",
      "--refresh-search",
      "--refresh-files",
      "--refresh-stars",
      "--refresh-plugin-repos",
      "--min-stars",
      "0",
    ]);
  } else {
    console.log("Skipping search (using existing data files).");
  }

  await updateMetadata();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

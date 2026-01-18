#!/usr/bin/env bun
/**
 * Standalone search script for discovering and validating Claude Code marketplaces
 *
 * Usage:
 *   bun run scripts/search.ts                    # Run full search
 *   bun run scripts/search.ts --limit 10         # Test with first 10 repos
 *   bun run scripts/search.ts --dry-run          # Preview without saving
 *   bun run scripts/search.ts --verbose          # Show detailed logs
 *   bun run scripts/search.ts --no-resume        # Ignore existing state
 *   bun run scripts/search.ts --fresh            # Clear state and rerun
 */

import fs from "fs/promises";
import path from "path";
import {
  searchMarketplaceFiles,
  fetchMarketplaceFile,
  GitHubSearchResult,
} from "../lib/search/github-search";
import { validateMarketplaces, RepoValidationMeta } from "../lib/search/validator";
import { mergeMarketplaces, writePlugins } from "../lib/search/storage";
import { fetchRepoMetadata, RepoMetadata } from "../lib/search/github-stars";
import {
  extractPluginsFromMarketplaces,
  aggregatePluginKeywords,
} from "../lib/search/plugin-extractor";
import { RetryOptions } from "../lib/search/github-client";
import type { Marketplace, Plugin } from "../lib/types";

const SEARCH_QUERY = "filename:marketplace.json path:.claude-plugin";
const STATE_VERSION = 1;
const DEFAULT_STATE_FILE = path.join(process.cwd(), "lib/data/search-state.json");
const MANUAL_REPOS_FILE = path.join(process.cwd(), "lib/data/manual-marketplaces.json");
const PLUGINS_WITH_METADATA_FILE = path.join(
  process.cwd(),
  "lib/data/plugins-with-metadata.json"
);

interface CliArgs {
  limit?: number;
  dryRun: boolean;
  verbose: boolean;
  resume: boolean;
  fresh: boolean;
  stateFile: string;
  minDelayMs: number;
  concurrency: number;
  maxRetries: number;
  minStars: number;
  includeForks: boolean;
  searchShards: boolean;
  refreshShards: boolean;
  sizeMin: number;
  sizeMax: number;
  sizeMinStep: number;
  refreshStars: boolean;
  refreshFiles: boolean;
  refreshSearch: boolean;
  refreshPluginRepos: boolean;
  skipTopics: boolean;
}

interface SearchState {
  version: number;
  query: string;
  perPage: number;
  maxPages: number;
  createdAt: string;
  updatedAt: string;
  search: {
    totalCount?: number;
    lastPage: number;
    results: GitHubSearchResult[];
    complete: boolean;
    queries?: Record<string, { lastPage: number; complete: boolean; totalCount?: number }>;
    shards?: string[];
    shardsResolvedAt?: string;
    config?: {
      includeForks: boolean;
      searchShards: boolean;
      sizeMin: number;
      sizeMax: number;
      sizeMinStep: number;
    };
  };
  stars: Record<string, RepoMetadata>;
  files: Record<string, { content: string; fetchedAt: string }>;
  pluginRepos: Record<string, RepoMetadata>;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    dryRun: false,
    verbose: false,
    resume: true,
    fresh: false,
    stateFile: DEFAULT_STATE_FILE,
    minDelayMs: 250,
    concurrency: 2,
    maxRetries: 5,
    minStars: 5,
    includeForks: false,
    searchShards: false,
    refreshShards: false,
    sizeMin: 0,
    sizeMax: 10_000_000,
    sizeMinStep: 1000,
    refreshStars: false,
    refreshFiles: false,
    refreshSearch: false,
    refreshPluginRepos: false,
    skipTopics: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--limit" && i + 1 < args.length) {
      result.limit = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--verbose" || arg === "-v") {
      result.verbose = true;
    } else if (arg === "--no-resume") {
      result.resume = false;
    } else if (arg === "--fresh") {
      result.fresh = true;
      result.resume = false;
    } else if (arg === "--state-file" && i + 1 < args.length) {
      result.stateFile = args[i + 1];
      i++;
    } else if (arg === "--min-delay-ms" && i + 1 < args.length) {
      result.minDelayMs = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--concurrency" && i + 1 < args.length) {
      result.concurrency = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--max-retries" && i + 1 < args.length) {
      result.maxRetries = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--min-stars" && i + 1 < args.length) {
      result.minStars = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--no-quality-filter") {
      result.minStars = 0;
    } else if (arg === "--include-forks") {
      result.includeForks = true;
    } else if (arg === "--search-shards") {
      result.searchShards = true;
    } else if (arg === "--refresh-shards") {
      result.refreshShards = true;
    } else if (arg === "--size-min" && i + 1 < args.length) {
      result.sizeMin = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--size-max" && i + 1 < args.length) {
      result.sizeMax = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--size-step" && i + 1 < args.length) {
      result.sizeMinStep = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--refresh-stars") {
      result.refreshStars = true;
    } else if (arg === "--refresh-files") {
      result.refreshFiles = true;
    } else if (arg === "--refresh-search") {
      result.refreshSearch = true;
    } else if (arg === "--refresh-plugin-repos") {
      result.refreshPluginRepos = true;
    } else if (arg === "--skip-topics") {
      result.skipTopics = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
Usage: bun run scripts/search.ts [options]

Options:
  --limit N           Limit results to first N repositories
  --dry-run           Run validation without saving results
  --verbose, -v       Show detailed logging
  --no-resume         Ignore existing state cache
  --fresh             Clear state cache and start over
  --state-file PATH   Override state cache file location
  --min-delay-ms N    Minimum delay between GitHub requests (default: 250)
  --concurrency N     Concurrent GitHub requests (default: 2)
  --max-retries N     Retry attempts for GitHub requests (default: 5)
  --min-stars N       Minimum stars to keep marketplace (default: 5)
  --no-quality-filter Disable star filter (same as --min-stars 0)
  --include-forks     Include forked repos in search
  --search-shards     Split search by size ranges to bypass 1000-result cap
  --refresh-shards    Recompute search shards even if cached
  --size-min N        Minimum marketplace.json size in bytes for sharding
  --size-max N        Maximum marketplace.json size in bytes for sharding
  --size-step N       Minimum size range width before splitting stops
  --refresh-search    Re-run GitHub search even if cached
  --refresh-stars     Re-fetch repo metadata even if cached
  --refresh-files     Re-fetch marketplace files even if cached
  --refresh-plugin-repos  Re-fetch plugin repo metadata even if cached
  --skip-topics       Skip fetching repo topics when missing
  --help, -h          Show this help message

Examples:
  bun run scripts/search.ts                     # Full search
  bun run scripts/search.ts --limit 10          # Test with 10 repos
  bun run scripts/search.ts --dry-run           # Preview mode
  bun run scripts/search.ts --fresh --verbose   # Clear cache + verbose
  bun run scripts/search.ts --min-stars 0 --include-forks --search-shards
`);
      process.exit(0);
    }
  }

  return result;
}

// ANSI color codes for CLI output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
const TOTAL_STEPS = 9;

function log(message: string, color: string = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logStep(step: number, message: string) {
  log(`\n${colors.bright}[${step}/${TOTAL_STEPS}]${colors.reset} ${colors.cyan}${message}${colors.reset}`);
}

function logSuccess(message: string) {
  log(`  OK: ${message}`, colors.green);
}

function logWarning(message: string) {
  log(`  WARN: ${message}`, colors.yellow);
}

function logError(message: string) {
  log(`  ERROR: ${message}`, colors.red);
}

function logInfo(message: string) {
  log(`  ${message}`, colors.gray);
}

const REPO_SOURCE_RANK: Record<string, number> = {
  "plugin.repository": 4,
  "plugin.sourceRepo": 3,
  "plugin.homepage": 2,
  marketplace: 1,
  unknown: 0,
};

function normalizeDedupeValue(value: string | null | undefined): string {
  return value ? value.trim().toLowerCase() : "";
}

function buildPluginDedupeKey(
  plugin: Plugin,
  pluginRepoById: Map<string, { repo: string | null }>
): string | null {
  const name = normalizeDedupeValue(plugin.name);
  const repo = normalizeDedupeValue(pluginRepoById.get(plugin.id)?.repo ?? "");
  if (!name || !repo) {
    return null;
  }
  return `${name}::${repo}`;
}

function getPluginCandidateMeta(
  plugin: Plugin,
  pluginRepoById: Map<string, { repo: string | null; source: string }>,
  marketplaceBySlug: Map<string, Marketplace>
): {
  sameAsMarketplace: boolean;
  sourceRank: number;
  marketplaceStars: number;
  marketplaceSlug: string;
} {
  const repoInfo = pluginRepoById.get(plugin.id);
  const repo = repoInfo?.repo ?? null;
  const source = repoInfo?.source ?? "unknown";
  const marketplace = marketplaceBySlug.get(plugin.marketplace);
  const marketplaceRepo = marketplace?.repo ?? null;
  const sameAsMarketplace = repo !== null && marketplaceRepo === repo;
  const marketplaceStars = marketplace?.stars ?? -1;
  const marketplaceSlug = marketplace?.slug ?? plugin.marketplace ?? "";
  return {
    sameAsMarketplace,
    sourceRank: REPO_SOURCE_RANK[source] ?? 0,
    marketplaceStars,
    marketplaceSlug,
  };
}

function isPreferredPluginCandidate(
  candidate: Plugin,
  current: Plugin,
  pluginRepoById: Map<string, { repo: string | null; source: string }>,
  marketplaceBySlug: Map<string, Marketplace>
): boolean {
  const candidateMeta = getPluginCandidateMeta(candidate, pluginRepoById, marketplaceBySlug);
  const currentMeta = getPluginCandidateMeta(current, pluginRepoById, marketplaceBySlug);

  if (candidateMeta.sameAsMarketplace !== currentMeta.sameAsMarketplace) {
    return candidateMeta.sameAsMarketplace;
  }
  if (candidateMeta.sourceRank !== currentMeta.sourceRank) {
    return candidateMeta.sourceRank > currentMeta.sourceRank;
  }
  if (candidateMeta.marketplaceStars !== currentMeta.marketplaceStars) {
    return candidateMeta.marketplaceStars > currentMeta.marketplaceStars;
  }
  const slugCompare = candidateMeta.marketplaceSlug.localeCompare(currentMeta.marketplaceSlug);
  if (slugCompare !== 0) {
    return slugCompare < 0;
  }
  return candidate.id.localeCompare(current.id) < 0;
}

function dedupePluginsByNameAndRepo(
  plugins: Plugin[],
  pluginRepoById: Map<string, { repo: string | null; source: string }>,
  marketplaceBySlug: Map<string, Marketplace>
): { plugins: Plugin[]; removed: number; groups: number } {
  const bestByKey = new Map<string, Plugin>();
  const duplicateKeys = new Set<string>();

  for (const plugin of plugins) {
    const key = buildPluginDedupeKey(plugin, pluginRepoById);
    if (!key) {
      continue;
    }
    const existing = bestByKey.get(key);
    if (!existing) {
      bestByKey.set(key, plugin);
      continue;
    }
    duplicateKeys.add(key);
    if (isPreferredPluginCandidate(plugin, existing, pluginRepoById, marketplaceBySlug)) {
      bestByKey.set(key, plugin);
    }
  }

  const keptIds = new Set<string>();
  for (const [key, plugin] of bestByKey) {
    if (key) {
      keptIds.add(plugin.id);
    }
  }

  const deduped: Plugin[] = [];
  const seenKeys = new Set<string>();
  for (const plugin of plugins) {
    const key = buildPluginDedupeKey(plugin, pluginRepoById);
    if (!key) {
      deduped.push(plugin);
      continue;
    }
    if (seenKeys.has(key)) {
      continue;
    }
    if (keptIds.has(plugin.id)) {
      deduped.push(plugin);
      seenKeys.add(key);
    }
  }

  const removed = plugins.length - deduped.length;
  return {
    plugins: deduped,
    removed,
    groups: duplicateKeys.size,
  };
}

function createInitialState(): SearchState {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    query: SEARCH_QUERY,
    perPage: 100,
    maxPages: 10,
    createdAt: now,
    updatedAt: now,
    search: {
      totalCount: 0,
      lastPage: 0,
      results: [],
      complete: false,
      queries: {},
      shards: [],
      shardsResolvedAt: now,
      config: {
        includeForks: false,
        searchShards: false,
        sizeMin: 0,
        sizeMax: 10_000_000,
        sizeMinStep: 1000,
      },
    },
    stars: {},
    files: {},
    pluginRepos: {},
  };
}

async function loadManualRepos(): Promise<string[]> {
  try {
    const content = await fs.readFile(MANUAL_REPOS_FILE, "utf-8");
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => /^[\w-]+\/[\w-]+$/.test(value));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logWarning(`Failed to read manual repo list: ${MANUAL_REPOS_FILE}`);
    }
    return [];
  }
}

async function loadState(stateFile: string): Promise<SearchState | null> {
  try {
    const content = await fs.readFile(stateFile, "utf-8");
    const parsed = JSON.parse(content) as SearchState;
    if (parsed.version !== STATE_VERSION || parsed.query !== SEARCH_QUERY) {
      return null;
    }
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function removeState(stateFile: string): Promise<void> {
  try {
    await fs.unlink(stateFile);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}

let pendingStateWrite = Promise.resolve();
function queueStateWrite(stateFile: string, state: SearchState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  const payload = JSON.stringify(state, null, 2);
  const tempFile = `${stateFile}.tmp`;
  pendingStateWrite = pendingStateWrite.then(async () => {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(tempFile, payload, "utf-8");
    await fs.rename(tempFile, stateFile);
  });
  return pendingStateWrite;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  handler: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await handler(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

interface SizeRange {
  min: number;
  max: number;
}

function buildSearchQuery(
  baseQuery: string,
  sizeRange?: SizeRange
): string {
  const parts = [baseQuery];
  if (sizeRange) {
    parts.push(`size:${sizeRange.min}..${sizeRange.max}`);
  }
  return parts.join(" ");
}

async function resolveSearchShards(options: {
  baseQuery: string;
  sizeMin: number;
  sizeMax: number;
  sizeMinStep: number;
  retryOptions: RetryOptions;
  verbose: boolean;
}): Promise<string[]> {
  const ranges: SizeRange[] = [];
  const maxDepth = 30;

  const splitRange = async (range: SizeRange, depth: number) => {
    let totalCount = 0;
    const query = buildSearchQuery(options.baseQuery, range);

    await searchMarketplaceFiles({
      query,
      startPage: 1,
      maxPages: 1,
      existingResults: [],
      totalCount: 0,
      retryOptions: options.retryOptions,
      suppressLogs: !options.verbose,
      onPage: (info) => {
        totalCount = info.totalCount;
      },
    });

    const rangeWidth = range.max - range.min;
    if (totalCount > 1000 && rangeWidth > 0 && depth < maxDepth) {
      if (rangeWidth <= options.sizeMinStep) {
        logWarning(
          `Shard exceeds 1000 results; splitting below size step (${options.sizeMinStep}): ${query} (${totalCount} reported)`
        );
      }
      const mid = Math.floor((range.min + range.max) / 2);
      if (mid <= range.min) {
        logWarning(`Shard still exceeds 1000 results: ${query} (${totalCount} reported)`);
        ranges.push(range);
        return;
      }
      await splitRange({ min: range.min, max: mid }, depth + 1);
      await splitRange({ min: mid + 1, max: range.max }, depth + 1);
      return;
    }

    if (totalCount > 1000) {
      logWarning(`Shard still exceeds 1000 results: ${query} (${totalCount} reported)`);
    }

    ranges.push(range);
  };

  await splitRange({ min: options.sizeMin, max: options.sizeMax }, 0);

  return ranges.map((range) => buildSearchQuery(options.baseQuery, range));
}

function buildResultKey(result: GitHubSearchResult): string {
  return `${result.repo}::${result.path}`;
}

async function writePluginsWithMetadata(
  plugins: Array<Record<string, unknown>>,
  marketplaces: Array<{ slug: string } & Record<string, unknown>>,
  pluginRepoMetadata: Map<string, RepoMetadata>,
  pluginRepoById: Map<string, { repo: string | null; source: string }>
): Promise<void> {
  const marketplaceMap = new Map<string, Record<string, unknown>>(
    marketplaces.map((marketplace) => [marketplace.slug, marketplace])
  );

  const enriched = plugins.map((plugin) => {
    const marketplace = marketplaceMap.get(plugin.marketplace as string);
    const pluginRepoInfo = pluginRepoById.get(plugin.id as string);
    const pluginRepo = pluginRepoInfo?.repo ?? null;
    const pluginRepoMeta = pluginRepo ? pluginRepoMetadata.get(pluginRepo) : undefined;
    const pluginRepoUrl =
      pluginRepoMeta?.htmlUrl ??
      (pluginRepo ? `https://github.com/${pluginRepo}` : null);
    const sameAsMarketplace = pluginRepo !== null && pluginRepo === marketplace?.repo;
    return {
      ...plugin,
      marketplaceRepo: marketplace?.repo ?? null,
      marketplaceStars: marketplace?.stars ?? null,
      marketplaceDescription: marketplace?.description ?? null,
      marketplaceCategories: marketplace?.categories ?? null,
      marketplacePluginCount: marketplace?.pluginCount ?? null,
      marketplaceDiscoveredAt: marketplace?.discoveredAt ?? null,
      marketplaceLastUpdated: marketplace?.lastUpdated ?? null,
      marketplaceStarsFetchedAt: marketplace?.starsFetchedAt ?? null,
      pluginRepo,
      pluginRepoSource: pluginRepoInfo?.source ?? null,
      pluginRepoSameAsMarketplace: sameAsMarketplace,
      pluginRepoUrl,
      pluginRepoStars: pluginRepoMeta?.stars ?? null,
      pluginRepoDescription: pluginRepoMeta?.description ?? null,
      pluginRepoHomepage: pluginRepoMeta?.homepage ?? null,
      pluginRepoTopics: pluginRepoMeta?.topics ?? null,
      pluginRepoLanguage: pluginRepoMeta?.language ?? null,
      pluginRepoForks: pluginRepoMeta?.forksCount ?? null,
      pluginRepoArchived: pluginRepoMeta?.archived ?? null,
      pluginRepoDefaultBranch: pluginRepoMeta?.defaultBranch ?? null,
      pluginRepoLicense: pluginRepoMeta?.license ?? null,
      pluginRepoCreatedAt: pluginRepoMeta?.createdAt ?? null,
      pluginRepoUpdatedAt: pluginRepoMeta?.updatedAt ?? null,
      pluginRepoPushedAt: pluginRepoMeta?.pushedAt ?? null,
      pluginRepoOpenIssues: pluginRepoMeta?.openIssuesCount ?? null,
      pluginRepoWatchers: pluginRepoMeta?.watchersCount ?? null,
    };
  });

  await fs.writeFile(
    PLUGINS_WITH_METADATA_FILE,
    JSON.stringify(enriched, null, 2),
    "utf-8"
  );
}

async function runSearch() {
  const args = parseArgs();
  args.minStars = Math.max(0, args.minStars);
  args.sizeMin = Math.max(0, args.sizeMin);
  if (args.sizeMax < args.sizeMin) {
    args.sizeMax = args.sizeMin;
  }
  args.sizeMinStep = Math.max(1, args.sizeMinStep);
  const startTime = Date.now();
  const retryOptions: RetryOptions = {
    verbose: args.verbose,
    minDelayMs: args.minDelayMs,
    maxRetries: args.maxRetries,
  };
  const searchRetryOptions: RetryOptions = {
    ...retryOptions,
    minDelayMs: Math.max(args.minDelayMs, 1100),
  };

  // Banner
  log("-".repeat(60), colors.cyan);
  log("  Claude Code Marketplaces Search", colors.bright);
  log("-".repeat(60), colors.cyan);

  if (args.limit) {
    logWarning(`Running in test mode (limit: ${args.limit} repos)`);
  }
  if (args.dryRun) {
    logWarning("Running in DRY RUN mode (no data will be saved)");
  }
  if (args.verbose) {
    logInfo("Verbose logging enabled");
  }

  try {
    if (args.fresh) {
      await removeState(args.stateFile);
      logInfo(`Cleared state file: ${args.stateFile}`);
    }

    let state = args.resume ? await loadState(args.stateFile) : null;
    if (!state) {
      state = createInitialState();
    }
    state.stars ??= {};
    state.files ??= {};
    state.pluginRepos ??= {};
    state.search.queries ??= {};
    state.search.shards ??= [];

    const currentSearchConfig = {
      includeForks: args.includeForks,
      searchShards: args.searchShards,
      sizeMin: args.sizeMin,
      sizeMax: args.sizeMax,
      sizeMinStep: args.sizeMinStep,
    };

    if (state.search.config && JSON.stringify(state.search.config) !== JSON.stringify(currentSearchConfig)) {
      logWarning("Search configuration changed; resetting cached search results");
      state.search.results = [];
      state.search.complete = false;
      state.search.lastPage = 0;
      state.search.totalCount = 0;
      state.search.queries = {};
      state.search.shards = [];
      state.search.shardsResolvedAt = undefined;
    }

    state.search.config = currentSearchConfig;

    if (args.refreshSearch) {
      state.search.totalCount = 0;
      state.search.lastPage = 0;
      state.search.results = [];
      state.search.complete = false;
      state.search.queries = {};
      state.search.shards = [];
      state.search.shardsResolvedAt = undefined;
    }

    // Step 1: Search GitHub
    logStep(1, "Searching GitHub for marketplace files...");
    let searchResults: GitHubSearchResult[] = state.search.results ?? [];
    const seenResults = new Set(searchResults.map(buildResultKey));
    const baseQuery = buildSearchQuery(SEARCH_QUERY);
    let searchQueries: string[] = [];
    if (args.searchShards) {
      if (!state.search.shards?.length || args.refreshShards || args.refreshSearch) {
        logInfo("Resolving search shards...");
        const resolvedQueries: string[] = [];
        const shards = await resolveSearchShards({
          baseQuery: SEARCH_QUERY,
          sizeMin: args.sizeMin,
          sizeMax: args.sizeMax,
          sizeMinStep: args.sizeMinStep,
          retryOptions: searchRetryOptions,
          verbose: args.verbose,
        });
        resolvedQueries.push(...shards);
        searchQueries = resolvedQueries;
        state.search.shards = resolvedQueries;
        state.search.shardsResolvedAt = new Date().toISOString();
        await queueStateWrite(args.stateFile, state);
      } else {
        searchQueries = state.search.shards ?? [];
      }

      if (searchQueries.length === 0) {
        searchQueries = [baseQuery];
      }
    } else {
      searchQueries = [baseQuery];
    }

    for (const query of searchQueries) {
      const queryState = state.search.queries?.[query] ?? {
        lastPage: 0,
        complete: false,
        totalCount: 0,
      };

      if (queryState.complete && !args.refreshSearch) {
        continue;
      }

      const queryResults = await searchMarketplaceFiles({
        verbose: args.verbose,
        query,
        startPage: queryState.lastPage + 1,
        maxPages: state.maxPages,
        existingResults: [],
        totalCount: queryState.totalCount,
        retryOptions: searchRetryOptions,
        onPage: (info) => {
          queryState.lastPage = info.page;
          queryState.totalCount = info.totalCount;
          state.search.queries![query] = queryState;
          queueStateWrite(args.stateFile, state);
        },
      });

      queryState.complete = true;
      state.search.queries![query] = queryState;

      queryResults.forEach((result) => {
        const key = buildResultKey(result);
        if (!seenResults.has(key)) {
          seenResults.add(key);
          searchResults.push(result);
        }
      });
      await queueStateWrite(args.stateFile, state);
    }

    state.search.results = searchResults;
    state.search.complete = searchQueries.every((query) => state.search.queries?.[query]?.complete);
    await queueStateWrite(args.stateFile, state);

    const manualRepos = await loadManualRepos();
    if (manualRepos.length > 0) {
      let addedManual = 0;
      manualRepos.forEach((repo) => {
        const key = `${repo}::.claude-plugin/marketplace.json`;
        if (!seenResults.has(key)) {
          seenResults.add(key);
          searchResults.push({
            repo,
            path: ".claude-plugin/marketplace.json",
            url: `https://github.com/${repo}/blob/HEAD/.claude-plugin/marketplace.json`,
          });
          addedManual += 1;
        }
      });
      if (addedManual > 0) {
        logInfo(`Added ${addedManual} manual marketplace repos`);
      }
    }

    logSuccess(`Found ${searchResults.length} potential marketplaces`);

    if (searchResults.length === 0) {
      logWarning("No marketplaces found. Exiting.");
      return;
    }

    // Apply limit if specified
    const resultsToProcess = args.limit
      ? searchResults.slice(0, args.limit)
      : searchResults;

    if (args.limit && resultsToProcess.length < searchResults.length) {
      logInfo(`Processing first ${resultsToProcess.length} of ${searchResults.length} results`);
    }

    // Step 2: Fetch GitHub stars (BEFORE fetching files to filter early)
    logStep(2, "Fetching GitHub star counts...");
    const allRepos = resultsToProcess.map((r) => r.repo);
    const repoMetadataMap = new Map<string, RepoMetadata>();
    const reposToFetch = allRepos.filter((repo) => {
      const cached = state.stars[repo];
      if (cached && !args.refreshStars) {
        repoMetadataMap.set(repo, cached);
        return false;
      }
      return true;
    });

    if (reposToFetch.length > 0) {
      logInfo(`Fetching metadata for ${reposToFetch.length} repos (cached: ${allRepos.length - reposToFetch.length})`);
    }

    await mapWithConcurrency(reposToFetch, args.concurrency, async (repo) => {
      const meta = await fetchRepoMetadata(repo, {
        verbose: args.verbose,
        retryOptions,
        includeTopics: !args.skipTopics,
      });
      repoMetadataMap.set(repo, meta);
      state.stars[repo] = meta;
      await queueStateWrite(args.stateFile, state);
      return meta;
    });

    const starsFetched = Array.from(repoMetadataMap.values()).filter((s) => s.stars !== null).length;
    logSuccess(`Fetched stars for ${starsFetched}/${allRepos.length} repos`);

    const missingStars = allRepos.filter((repo) => {
      const meta = repoMetadataMap.get(repo);
      if (!meta) return true;
      return meta.accessible && meta.stars === null;
    });

    if (missingStars.length > 0) {
      logWarning(`Stars missing for ${missingStars.length} repos. Re-run to resume.`);
      process.exitCode = 1;
      return;
    }

    // Step 3: Apply fork + quality filters BEFORE fetching files
    const minStars = Math.max(0, args.minStars);
    const forkFiltered = args.includeForks
      ? resultsToProcess
      : resultsToProcess.filter((result) => {
          const isFork = repoMetadataMap.get(result.repo)?.fork;
          return isFork === false || isFork === null || isFork === undefined;
        });

    logStep(
      3,
      minStars > 0
        ? `Applying filters (forks excluded: ${!args.includeForks}, >=${minStars} stars)...`
        : `Applying fork filter (forks excluded: ${!args.includeForks})...`
    );

    const qualityRepos = minStars > 0
      ? forkFiltered.filter((result) => {
          const stars = repoMetadataMap.get(result.repo)?.stars ?? 0;
          return stars >= minStars;
        })
      : forkFiltered;

    const filteredOutCount = resultsToProcess.length - qualityRepos.length;

    if (minStars > 0) {
      logSuccess(`Kept ${qualityRepos.length}/${resultsToProcess.length} repos (>=${minStars} stars)`);
      if (filteredOutCount > 0) {
        logWarning(`Filtered out ${filteredOutCount} repos with <${minStars} stars (saved ${filteredOutCount} API calls)`);
      }
    } else {
      logWarning(`No star filter applied (keeping ${qualityRepos.length} repos)`);
    }

    if (qualityRepos.length === 0) {
      logWarning("No repos passed the quality filter. Exiting.");
      return;
    }

    // Step 4: Fetch marketplace.json files (ONLY for quality repos)
    logStep(4, "Fetching marketplace.json files (quality repos only)...");
    const filesMap = new Map<string, { repo: string; content: string }>();
    const reposMissingFiles: string[] = [];

    qualityRepos.forEach((result) => {
      const cached = state.files[result.repo];
      if (cached && !args.refreshFiles) {
        filesMap.set(result.repo, { repo: result.repo, content: cached.content });
      } else {
        reposMissingFiles.push(result.repo);
      }
    });

    if (reposMissingFiles.length > 0) {
      logInfo(`Fetching marketplace files for ${reposMissingFiles.length} repos (cached: ${qualityRepos.length - reposMissingFiles.length})`);
    }

    await mapWithConcurrency(reposMissingFiles, args.concurrency, async (repo) => {
      try {
        const content = await fetchMarketplaceFile(repo, "main", args.verbose, retryOptions);
        filesMap.set(repo, { repo, content });
        state.files[repo] = { content, fetchedAt: new Date().toISOString() };
        await queueStateWrite(args.stateFile, state);
      } catch (error) {
        logWarning(`Skipping ${repo}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    const validFiles = Array.from(filesMap.values());
    const failedFetches = qualityRepos.length - validFiles.length;
    logSuccess(`Fetched ${validFiles.length}/${qualityRepos.length} files`);
    if (failedFetches > 0) {
      logWarning(`${failedFetches} files failed to fetch`);
    }

    // Step 5: Validate marketplace files
    logStep(5, "Validating with Zod v4 schema...");
    const repoValidationMeta = new Map<string, RepoValidationMeta>();
    repoMetadataMap.forEach((meta, repo) => {
      repoValidationMeta.set(repo, {
        description: meta.description,
        accessible: meta.accessible,
      });
    });

    const validationResults = await validateMarketplaces(validFiles, {
      verbose: args.verbose,
      repoMetadata: repoValidationMeta,
    });

    const validMarketplaces = validationResults
      .filter((result) => result.valid && result.marketplace)
      .map((result) => result.marketplace!);

    const failedValidations = validationResults.filter((result) => !result.valid);

    logSuccess(`Valid: ${validMarketplaces.length}/${validFiles.length}`);
    if (failedValidations.length > 0) {
      logError(`Failed: ${failedValidations.length}`);

      if (args.verbose) {
        failedValidations.forEach((failed, index) => {
          const repo = validFiles[validationResults.indexOf(failed)]?.repo || "unknown";
          logError(`  ${index + 1}. ${repo}`);
          failed.errors.forEach((error) => {
            logInfo(`     - ${error}`);
          });
        });
      } else {
        logInfo("Run with --verbose to see validation errors");
      }
    }

    if (validMarketplaces.length === 0) {
      logWarning("No valid marketplaces found. Exiting.");
      return;
    }

    // Add stars to validated marketplaces
    const marketplacesWithStars = validMarketplaces.map((marketplace) => {
      const meta = repoMetadataMap.get(marketplace.repo);
      return {
        ...marketplace,
        stars: meta?.stars ?? marketplace.stars,
        starsFetchedAt: meta?.stars !== null ? meta?.fetchedAt : marketplace.starsFetchedAt,
      };
    });

    // Step 6: Preview results
    logStep(6, "Marketplace Summary");

    // Show top 10 by stars
    const sorted = [...marketplacesWithStars].sort((a, b) => (b.stars || 0) - (a.stars || 0));
    const topTen = sorted.slice(0, 10);

    topTen.forEach((marketplace, index) => {
      const stars = marketplace.stars !== undefined ? `* ${marketplace.stars}` : "* N/A";
      logInfo(`${index + 1}. ${marketplace.repo} - ${marketplace.pluginCount} plugins - ${stars}`);
    });

    if (sorted.length > 10) {
      logInfo(`... and ${sorted.length - 10} more`);
    }

    // Step 7: Extract plugins from marketplaces
    logStep(7, "Extracting plugins from marketplaces...");
    const allPlugins = extractPluginsFromMarketplaces(marketplacesWithStars, validFiles);
    logSuccess(`Extracted ${allPlugins.length} plugins from ${marketplacesWithStars.length} marketplaces`);

    if (args.verbose && allPlugins.length > 0) {
      // Show sample plugins
      const sampleSize = Math.min(5, allPlugins.length);
      logInfo(`Sample plugins (showing ${sampleSize} of ${allPlugins.length}):`);
      allPlugins.slice(0, sampleSize).forEach((plugin, index) => {
        logInfo(`  ${index + 1}. ${plugin.name} (${plugin.marketplace})`);
      });
    }

    // Step 7.5: Aggregate plugin keywords into marketplaces
    logStep(7.5, "Aggregating plugin keywords for searchability...");
    const marketplacesWithKeywords = marketplacesWithStars.map((marketplace) => {
      // Filter plugins for this marketplace
      const marketplacePlugins = allPlugins.filter((p) => p.marketplace === marketplace.slug);
      // Aggregate keywords from all plugins
      const pluginKeywords = aggregatePluginKeywords(marketplacePlugins);

      return {
        ...marketplace,
        pluginKeywords,
      };
    });

    const avgKeywords = Math.round(
      marketplacesWithKeywords.reduce((sum, m) => sum + (m.pluginKeywords?.length || 0), 0) /
      marketplacesWithKeywords.length
    );
    logSuccess(
      `Aggregated keywords for ${marketplacesWithKeywords.length} marketplaces (avg: ${avgKeywords} keywords/marketplace)`
    );

    // Step 8: Enrich plugin repositories
    logStep(8, "Fetching plugin repository metadata...");
    const marketplaceBySlug = new Map(
      marketplacesWithKeywords.map((marketplace) => [marketplace.slug, marketplace])
    );

    const pluginRepoById = new Map<string, { repo: string | null; source: string }>();
    const pluginRepoSet = new Set<string>();
    let repoFromMarketplaceCount = 0;
    let repoFromPluginCount = 0;

    const extractGitHubRepoSlug = (value: string | undefined): string | null => {
      if (!value) return null;
      const simpleMatch = value.match(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
      if (simpleMatch) {
        return value.replace(/\.git$/i, "");
      }
      const githubMatch = value.match(/github\.com[:/]+([^/]+)\/([^/#?]+)(?:[/?#].*)?$/i);
      if (githubMatch) {
        const owner = githubMatch[1];
        const repo = githubMatch[2].replace(/\.git$/i, "");
        return `${owner}/${repo}`;
      }
      return null;
    };

    const resolvePluginRepo = (plugin: Record<string, unknown>, marketplaceRepo: string | undefined) => {
      const repository = plugin.repository as string | undefined;
      const sourceRepo = plugin.sourceRepo as string | undefined;
      const homepage = plugin.homepage as string | undefined;

      const fromRepository = extractGitHubRepoSlug(repository);
      if (fromRepository) {
        return { repo: fromRepository, source: "plugin.repository" };
      }

      const fromSource = extractGitHubRepoSlug(sourceRepo);
      if (fromSource) {
        return { repo: fromSource, source: "plugin.sourceRepo" };
      }

      const fromHomepage = extractGitHubRepoSlug(homepage);
      if (fromHomepage) {
        return { repo: fromHomepage, source: "plugin.homepage" };
      }

      if (marketplaceRepo) {
        return { repo: marketplaceRepo, source: "marketplace" };
      }

      return { repo: null, source: "unknown" };
    };

    allPlugins.forEach((plugin) => {
      const marketplace = marketplaceBySlug.get(plugin.marketplace);
      const resolved = resolvePluginRepo(plugin as Record<string, unknown>, marketplace?.repo);
      pluginRepoById.set(plugin.id, resolved);
      if (resolved.repo) {
        pluginRepoSet.add(resolved.repo);
        if (resolved.source === "marketplace") {
          repoFromMarketplaceCount += 1;
        } else {
          repoFromPluginCount += 1;
        }
      }
    });

    const pluginRepoMetadataMap = new Map<string, RepoMetadata>();
    const pluginReposToFetch: string[] = [];

    pluginRepoSet.forEach((repo) => {
      const cached = state.pluginRepos[repo];
      if (cached && !args.refreshPluginRepos) {
        pluginRepoMetadataMap.set(repo, cached);
        return;
      }

      const marketplaceMeta = repoMetadataMap.get(repo);
      if (marketplaceMeta) {
        pluginRepoMetadataMap.set(repo, marketplaceMeta);
        state.pluginRepos[repo] = marketplaceMeta;
        return;
      }

      pluginReposToFetch.push(repo);
    });

    if (pluginReposToFetch.length > 0) {
      logInfo(
        `Fetching ${pluginReposToFetch.length} plugin repos (cached: ${pluginRepoSet.size - pluginReposToFetch.length})`
      );
    }

    await mapWithConcurrency(pluginReposToFetch, args.concurrency, async (repo) => {
      const meta = await fetchRepoMetadata(repo, {
        verbose: args.verbose,
        retryOptions,
        includeTopics: !args.skipTopics,
      });
      pluginRepoMetadataMap.set(repo, meta);
      state.pluginRepos[repo] = meta;
      await queueStateWrite(args.stateFile, state);
      return meta;
    });

    logSuccess(
      `Plugin repos: ${pluginRepoSet.size} unique (marketplace fallback: ${repoFromMarketplaceCount}, plugin-provided: ${repoFromPluginCount})`
    );

    const missingPluginRepos = Array.from(pluginRepoSet).filter((repo) => {
      const meta = pluginRepoMetadataMap.get(repo);
      return !meta || (meta.accessible && meta.stars === null);
    });

    if (missingPluginRepos.length > 0) {
      logWarning(`Missing metadata for ${missingPluginRepos.length} plugin repos. Re-run to resume.`);
      process.exitCode = 1;
      return;
    }

    const dedupeResult = dedupePluginsByNameAndRepo(
      allPlugins,
      pluginRepoById,
      marketplaceBySlug
    );
    const pluginsToSave = dedupeResult.plugins;

    if (dedupeResult.removed > 0) {
      logSuccess(
        `Plugins - Deduped ${dedupeResult.removed} entries (${dedupeResult.groups} duplicate groups) by name+repo`
      );
    } else {
      logInfo("Plugins - No name+repo duplicates detected");
    }

    // Step 9: Save results
    if (args.dryRun) {
      logStep(9, "Skipping save (dry run mode)");
      logWarning("Results not saved due to --dry-run flag");
    } else {
      logStep(9, "Saving to database...");

      // Save marketplaces (with plugin keywords)
      const allDiscoveredRepos = new Set(resultsToProcess.map((r) => r.repo));
      const mergeResult = await mergeMarketplaces(marketplacesWithKeywords, allDiscoveredRepos);

      logSuccess(`Marketplaces - Added: ${mergeResult.added}, Updated: ${mergeResult.updated}`);
      if (mergeResult.removed > 0) {
        logWarning(`Marketplaces - Removed: ${mergeResult.removed} invalid entries`);
      }
      logSuccess(`Marketplaces - Total: ${mergeResult.total}`);

      // Save plugins
      await writePlugins(pluginsToSave);
      logSuccess(`Plugins - Saved: ${pluginsToSave.length} plugins`);

      // Save enriched plugins for integration use
      await writePluginsWithMetadata(
        pluginsToSave,
        marketplacesWithKeywords,
        pluginRepoMetadataMap,
        pluginRepoById
      );
      logSuccess(`Plugins - Metadata saved to ${PLUGINS_WITH_METADATA_FILE}`);
    }

    // Summary
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    const apiCallsSaved = filteredOutCount;

    log("\n" + "-".repeat(60), colors.cyan);
    log("  Search Complete!", colors.bright);
    log("-".repeat(60), colors.cyan);
    log(`  Time: ${duration}s`, colors.gray);
    log(`  Success Rate: ${((validMarketplaces.length / validFiles.length) * 100).toFixed(1)}%`, colors.gray);
    log(`  API Calls Saved: ${apiCallsSaved} (quality filter before fetch)`, colors.gray);

    if (!args.dryRun) {
      log(`  SAVED Marketplaces saved to lib/data/marketplaces.json`, colors.green);
      log(`  SAVED Plugins saved to lib/data/plugins.json`, colors.green);
      log(`  SAVED Enriched plugins saved to lib/data/plugins-with-metadata.json`, colors.green);
    }

    log("-".repeat(60) + "\n", colors.cyan);
  } catch (error) {
    logError(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
    if (args.verbose && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    await pendingStateWrite;
  }
}

// Run the search
runSearch();

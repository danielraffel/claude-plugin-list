import { createOctokit, requestWithRetry, RetryOptions } from "./github-client";

export interface GitHubSearchResult {
  repo: string;
  path: string;
  url: string;
}

/**
 * Search GitHub for .claude-plugin/marketplace.json files
 * Uses GitHub Code Search API with pagination to get all results
 */
export interface SearchOptions {
  verbose?: boolean;
  startPage?: number;
  maxPages?: number;
  existingResults?: GitHubSearchResult[];
  totalCount?: number;
  query?: string;
  suppressLogs?: boolean;
  onPage?: (info: { page: number; totalCount: number; results: GitHubSearchResult[] }) => void;
  retryOptions?: RetryOptions;
}

export async function searchMarketplaceFiles(
  verboseOrOptions: boolean | SearchOptions = false
): Promise<GitHubSearchResult[]> {
  const options = typeof verboseOrOptions === "boolean"
    ? { verbose: verboseOrOptions }
    : verboseOrOptions;
  const verbose = options.verbose ?? false;
  const startPage = options.startPage ?? 1;
  const maxPages = options.maxPages ?? 10;
  const existingResults = options.existingResults ?? [];
  const onPage = options.onPage;
  const retryOptions = options.retryOptions;
  const suppressLogs = options.suppressLogs ?? false;
  try {
    const octokit = createOctokit(verbose);

    // Search for marketplace.json files in the .claude-plugin directory
    const query = options.query ?? "filename:marketplace.json path:.claude-plugin";
    const perPage = 100; // Max results per page
    const log = (...args: unknown[]) => {
      if (!suppressLogs) {
        console.log(...args);
      }
    };

    const allResults: GitHubSearchResult[] = [...existingResults];
    let page = startPage;
    let totalCount = options.totalCount ?? 0;

    // Fetch all pages
    while (page <= maxPages) {
      const response = await requestWithRetry(
        () =>
          octokit.rest.search.code({
            q: query,
            per_page: perPage,
            page: page,
          }),
        retryOptions
      );

      // Store total count from first page
      if (page === startPage || totalCount === 0) {
        totalCount = response.data.total_count;
        log(`GitHub reports ${totalCount} total marketplace files`);
      }

      // Convert and add results
      const pageResults: GitHubSearchResult[] = response.data.items.map(
        (item) => ({
          repo: item.repository.full_name,
          path: item.path,
          url: item.html_url,
        })
      );

      allResults.push(...pageResults);
      onPage?.({ page, totalCount, results: [...allResults] });

      // Stop if we've fetched all available results
      if (response.data.items.length < perPage) {
        log(`Fetched all ${allResults.length} results (${page} pages)`);
        break;
      }

      // Stop if we've reached the total count
      if (totalCount > 0 && allResults.length >= totalCount) {
        log(
          `Fetched all ${allResults.length} results (total: ${totalCount})`
        );
        break;
      }

      page++;
    }

    log(`Found ${allResults.length} marketplace files on GitHub`);

    return allResults;
  } catch (error) {
    if (error instanceof Error) {
      console.error("GitHub search failed:", error.message);

      // Handle rate limiting
      if ("status" in error && error.status === 403) {
        throw new Error("GitHub API rate limit exceeded. Try again later.");
      }
    }
    throw error;
  }
}

/**
 * Fetch raw content of marketplace.json file from GitHub
 */
export async function fetchMarketplaceFile(
  repo: string,
  branch: string = "main",
  verbose: boolean = false,
  retryOptions?: RetryOptions
): Promise<string> {
  try {
    const octokit = createOctokit(verbose);
    const [owner, repoName] = repo.split("/");

    const response = await requestWithRetry(
      () =>
        octokit.rest.repos.getContent({
          owner,
          repo: repoName,
          path: ".claude-plugin/marketplace.json",
          ref: branch,
        }),
      retryOptions
    );

    // Handle the response which can be a file, directory, or symlink
    if ("content" in response.data && response.data.type === "file") {
      // Content is base64 encoded
      const content = Buffer.from(response.data.content, "base64").toString(
        "utf-8"
      );
      return content;
    }

    throw new Error("marketplace.json is not a file");
  } catch (error) {
    // Try 'master' branch if 'main' fails
    if (branch === "main") {
      try {
        return await fetchMarketplaceFile(repo, "master", verbose, retryOptions);
      } catch (masterError) {
        // Show warning for failed fetches (repo may be deleted, private, or file removed)
        if (verbose) {
          console.warn(`WARN: Skipping ${repo}: marketplace.json not accessible`, masterError);
        }
        throw new Error(`Could not fetch marketplace.json from ${repo}`);
      }
    }
    throw error;
  }
}

/**
 * Check if a GitHub repository is publicly accessible
 */
export async function isRepoAccessible(repo: string, verbose: boolean = false): Promise<boolean> {
  try {
    const octokit = createOctokit(verbose);
    const [owner, repoName] = repo.split("/");

    await requestWithRetry(
      () =>
        octokit.rest.repos.get({
          owner,
          repo: repoName,
        }),
      { verbose }
    );

    return true;
  } catch (error) {
    if (verbose) {
      console.warn(`WARN: Repo ${repo} is not accessible`, error);
    }
    return false;
  }
}

/**
 * Get repository description from GitHub
 */
export async function getRepoDescription(repo: string, verbose: boolean = false): Promise<string> {
  try {
    const octokit = createOctokit(verbose);
    const [owner, repoName] = repo.split("/");

    const response = await requestWithRetry(
      () =>
        octokit.rest.repos.get({
          owner,
          repo: repoName,
        }),
      { verbose }
    );

    return response.data.description || "";
  } catch (error) {
    if (verbose) {
      console.warn(`WARN: Could not get description for ${repo}`, error);
    }
    return "";
  }
}

import { createOctokit, requestWithRetry, RetryOptions } from "./github-client";

export interface RepoMetadata {
  repo: string;
  stars: number | null;
  description: string | null;
  htmlUrl: string | null;
  homepage: string | null;
  topics: string[];
  language: string | null;
  fork: boolean | null;
  archived: boolean | null;
  defaultBranch: string | null;
  license: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  pushedAt: string | null;
  forksCount: number | null;
  openIssuesCount: number | null;
  watchersCount: number | null;
  accessible: boolean;
  fetchedAt: string;
}

export interface BatchOptions {
  verbose?: boolean;
  concurrency?: number;
  retryOptions?: RetryOptions;
  includeTopics?: boolean;
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

/**
 * Fetch GitHub star count for a repository
 * @param repo - Repository in format "owner/name"
 * @returns Star count or null if failed
 */
export async function fetchRepoStars(repo: string, verbose: boolean = false): Promise<number | null> {
  const metadata = await fetchRepoMetadata(repo, { verbose });
  return metadata.stars;
}

export async function fetchRepoMetadata(
  repo: string,
  options: BatchOptions = {}
): Promise<RepoMetadata> {
  const verbose = options.verbose ?? false;
  try {
    const octokit = createOctokit(verbose);
    const [owner, repoName] = repo.split("/");

    const response = await requestWithRetry(
      () =>
        octokit.rest.repos.get({
          owner,
          repo: repoName,
        }),
      options.retryOptions
    );

    let topics = Array.isArray(response.data.topics) ? response.data.topics : [];
    if (options.includeTopics && topics.length === 0) {
      try {
        const topicsResponse = await requestWithRetry(
          () =>
            octokit.request("GET /repos/{owner}/{repo}/topics", {
              owner,
              repo: repoName,
              headers: {
                accept: "application/vnd.github+json",
              },
            }),
          options.retryOptions
        );
        topics = Array.isArray(topicsResponse.data?.names)
          ? topicsResponse.data.names
          : topics;
      } catch (error) {
        if (verbose) {
          console.warn(`WARN: Could not fetch topics for ${repo}`, error);
        }
      }
    }

    return {
      repo,
      stars: response.data.stargazers_count ?? null,
      description: response.data.description ?? null,
      htmlUrl: response.data.html_url ?? null,
      homepage: response.data.homepage ?? null,
      topics,
      language: response.data.language ?? null,
      fork: response.data.fork ?? null,
      archived: response.data.archived ?? null,
      defaultBranch: response.data.default_branch ?? null,
      license: response.data.license?.spdx_id ?? response.data.license?.key ?? null,
      createdAt: response.data.created_at ?? null,
      updatedAt: response.data.updated_at ?? null,
      pushedAt: response.data.pushed_at ?? null,
      forksCount: response.data.forks_count ?? null,
      openIssuesCount: response.data.open_issues_count ?? null,
      watchersCount: response.data.watchers_count ?? null,
      accessible: true,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (verbose) {
      console.warn(`WARN: Could not fetch metadata for ${repo}`, error);
    }
    return {
      repo,
      stars: null,
      description: null,
      htmlUrl: null,
      homepage: null,
      topics: [],
      language: null,
      fork: null,
      archived: null,
      defaultBranch: null,
      license: null,
      createdAt: null,
      updatedAt: null,
      pushedAt: null,
      forksCount: null,
      openIssuesCount: null,
      watchersCount: null,
      accessible: status !== 404,
      fetchedAt: new Date().toISOString(),
    };
  }
}

/**
 * Batch fetch stars for multiple repositories
 * @param repos - Array of repository names in format "owner/name"
 * @returns Map of repo -> star count (null if failed)
 */
export async function batchFetchRepoMetadata(
  repos: string[],
  options: BatchOptions = {}
): Promise<Map<string, RepoMetadata>> {
  const verbose = options.verbose ?? false;
  const concurrency = options.concurrency ?? 4;
  const retryOptions = options.retryOptions;
  const includeTopics = options.includeTopics ?? false;

  const results = await mapWithConcurrency(repos, concurrency, async (repo) => {
    return fetchRepoMetadata(repo, { verbose, retryOptions, includeTopics });
  });

  const metadataMap = new Map<string, RepoMetadata>();
  results.forEach((result) => {
    metadataMap.set(result.repo, result);
  });

  return metadataMap;
}

export async function batchFetchStars(
  repos: string[],
  verboseOrOptions: boolean | BatchOptions = false
): Promise<Map<string, number | null>> {
  const options = typeof verboseOrOptions === "boolean"
    ? { verbose: verboseOrOptions }
    : verboseOrOptions;
  const metadataMap = await batchFetchRepoMetadata(repos, options);
  const starMap = new Map<string, number | null>();
  metadataMap.forEach((meta, repo) => {
    starMap.set(repo, meta.stars);
  });
  return starMap;
}

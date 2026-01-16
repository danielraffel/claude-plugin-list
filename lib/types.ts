export interface Plugin {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: {
    name: string;
    email?: string;
    url?: string;
  };
  homepage?: string;
  repository?: string;
  source: string;
  sourceType?: string;
  sourceRepo?: string;
  sourcePath?: string;
  marketplace: string;
  marketplaceUrl: string;
  category: string;
  license?: string;
  keywords?: string[];
  tags?: string[];
  strict?: boolean;
  commands?: string[];
  agents?: string[];
  hooks?: string[];
  hooksRaw?: Record<string, unknown>;
  mcpServers?: string[];
  mcpServersRaw?: Record<string, unknown>;
  installCommand: string;
}

export interface Marketplace {
  repo: string;
  slug: string;
  description: string;
  pluginCount: number;
  categories: string[];
  pluginKeywords?: string[]; // Aggregated keywords from all plugins for searchability
  discoveredAt?: string;
  lastUpdated?: string;
  source?: 'manual' | 'auto';
  stars?: number;
  starsFetchedAt?: string;
}

export interface Author {
  name: string;
  image: string;
}

export interface Video {
  url: string; // YouTube embed URL
  title: string;
  description: string;
  author: Author;
}

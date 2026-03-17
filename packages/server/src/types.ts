export interface FeedRecord {
  id: string;
  url: string;
  title: string;
  siteUrl?: string;
  description?: string;
  faviconUrl?: string;
  groupId?: string;
  status: "idle" | "ok" | "error";
  errorMessage?: string;
  lastFetchedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArticleRecord {
  id: string;
  feedId: string;
  title: string;
  link: string;
  author?: string;
  publishedAt: string;
  snippet?: string;
  contentHtml?: string;
  imageUrl?: string;
  isRead: boolean;
  isReadLater: boolean;
  fetchedAt: string;
  updatedAt: string;
}

export interface FeedGroupRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServerSettings {
  refreshIntervalMinutes: number;
}

export interface ServerState {
  feeds: FeedRecord[];
  groups: FeedGroupRecord[];
  articles: ArticleRecord[];
  settings: ServerSettings;
}

export interface ArticleListFilters {
  feedId?: string;
  groupId?: string;
  readOnly?: boolean;
  unreadOnly?: boolean;
  readLaterOnly?: boolean;
  query?: string;
  offset?: number;
  limit?: number;
}

export interface PaginatedArticlesResult {
  articles: ArticleRecord[];
  total: number;
}

export interface OpmlImportResult {
  importedCount: number;
  duplicateCount: number;
  skippedCount: number;
}

export interface BulkReadResult {
  updatedCount: number;
}

export const DEFAULT_STATE: ServerState = {
  feeds: [],
  groups: [],
  articles: [],
  settings: {
    refreshIntervalMinutes: 30
  }
};

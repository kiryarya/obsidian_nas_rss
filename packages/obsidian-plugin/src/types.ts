export interface FeedDto {
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

export interface FeedGroupDto {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArticleDto {
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

export interface NasRssPluginSettings {
  serverBaseUrl: string;
  autoRefreshMinutes: number;
  unreadOnlyDefault: boolean;
  itemsPerPage: number;
  highlightKeywords: string[];
  saveFolderPath: string;
  saveTemplate: string;
}

export interface OpmlImportResult {
  importedCount: number;
  duplicateCount: number;
  skippedCount: number;
}

export interface RefreshJobDto {
  id: string;
  status: "idle" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  targetFeedId?: string;
}

export interface BulkReadResult {
  updatedCount: number;
}

export const DEFAULT_SETTINGS: NasRssPluginSettings = {
  serverBaseUrl: "http://127.0.0.1:43112",
  autoRefreshMinutes: 5,
  unreadOnlyDefault: true,
  itemsPerPage: 50,
  highlightKeywords: [],
  saveFolderPath: "RSS",
  saveTemplate: `---
title: "{{title}}"
date: {{date}}
source: "{{link}}"
feed: "{{feed}}"
tags: [rss_clipped]
---

# {{title}}

[Source Link]({{link}})

{{content}}`
};

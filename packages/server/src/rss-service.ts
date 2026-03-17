import { createHash } from "node:crypto";
import Parser from "rss-parser";
import type { StateStore } from "./store.js";
import type {
  BulkReadResult,
  ArticleListFilters,
  ArticleRecord,
  FeedGroupRecord,
  FeedRecord,
  OpmlImportResult,
  PaginatedArticlesResult
} from "./types.js";

type MediaEntry = { $?: { url?: string; type?: string; medium?: string } };

type ParsedItem = {
  title?: string;
  link?: string;
  creator?: string;
  content?: string;
  contentSnippet?: string;
  pubDate?: string;
  enclosure?: { url?: string; type?: string };
  "content:encoded"?: string;
  "media:content"?: MediaEntry | MediaEntry[];
  "media:thumbnail"?: MediaEntry | MediaEntry[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeUrl(url: string): string {
  return url.trim();
}

function createId(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

function buildFaviconUrl(siteUrl?: string): string | undefined {
  if (!siteUrl) {
    return undefined;
  }

  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(siteUrl).hostname}&sz=32`;
  } catch {
    return undefined;
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function readAttribute(outlineTag: string, attributeName: string): string | undefined {
  const match = outlineTag.match(new RegExp(`${attributeName}="([^"]*)"`, "i"));
  return match?.[1] ? decodeXmlEntities(match[1].trim()) : undefined;
}

function extractImageUrl(item: ParsedItem): string | undefined {
  if (item.enclosure?.url && item.enclosure.type?.startsWith("image")) {
    return item.enclosure.url;
  }

  const mediaContent = item["media:content"];
  if (Array.isArray(mediaContent)) {
    const first = mediaContent.find((entry) => entry.$?.url);
    if (first?.$?.url) {
      return first.$.url;
    }
  } else if (mediaContent?.$?.url) {
    return mediaContent.$.url;
  }

  const mediaThumbnail = item["media:thumbnail"];
  if (Array.isArray(mediaThumbnail)) {
    const first = mediaThumbnail.find((entry) => entry.$?.url);
    if (first?.$?.url) {
      return first.$.url;
    }
  } else if (mediaThumbnail?.$?.url) {
    return mediaThumbnail.$.url;
  }

  const html = item["content:encoded"] ?? item.content;
  if (!html) {
    return undefined;
  }

  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match?.[1];
}

export class RssService {
  private lastCleanupAt = 0;
  private readonly parser = new Parser({
    customFields: {
      item: [
        ["media:content", "media:content"],
        ["media:thumbnail", "media:thumbnail"],
        ["enclosure", "enclosure"],
        ["content:encoded", "content:encoded"]
      ]
    }
  });

  constructor(
    private readonly store: StateStore,
    private readonly refreshIntervalMinutes: number,
    private readonly readRetentionDays: number
  ) {}

  async listGroups(): Promise<FeedGroupRecord[]> {
    const state = await this.store.read();
    return state.groups.slice().sort((left, right) => left.name.localeCompare(right.name, "ja"));
  }

  async listFeeds(): Promise<FeedRecord[]> {
    const state = await this.store.read();
    return state.feeds.slice().sort((left, right) => left.title.localeCompare(right.title, "ja"));
  }

  async listArticles(filters: ArticleListFilters = {}): Promise<PaginatedArticlesResult> {
    await this.maybeCleanupReadArticles();
    const state = await this.store.read();
    const normalizedQuery = filters.query?.trim().toLowerCase();
    const feedIdsInGroup = filters.groupId
      ? new Set(
        state.feeds
          .filter((feed) => feed.groupId === filters.groupId)
          .map((feed) => feed.id)
      )
      : undefined;

    const articles = state.articles
      .filter((article) => (filters.feedId ? article.feedId === filters.feedId : true))
      .filter((article) => (feedIdsInGroup ? feedIdsInGroup.has(article.feedId) : true))
      .filter((article) => (filters.unreadOnly ? !article.isRead : true))
      .filter((article) => (filters.readLaterOnly ? article.isReadLater : true))
      .filter((article) => {
        if (!normalizedQuery) {
          return true;
        }

        const searchable = [
          article.title,
          article.author,
          article.snippet,
          article.contentHtml
        ]
          .filter((value): value is string => Boolean(value))
          .join(" ")
          .toLowerCase();

        return searchable.includes(normalizedQuery);
      })
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));

    const offset = Math.max(0, filters.offset ?? 0);
    const paged = typeof filters.limit === "number"
      ? articles.slice(offset, offset + filters.limit)
      : articles.slice(offset);

    return {
      articles: paged,
      total: articles.length
    };
  }

  async getArticle(articleId: string): Promise<ArticleRecord | undefined> {
    const state = await this.store.read();
    return state.articles.find((article) => article.id === articleId);
  }

  async exportOpml(): Promise<string> {
    const feeds = await this.listFeeds();
    const lines = [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<opml version=\"1.0\">",
      "  <head>",
      "    <title>NAS RSS Feed Export</title>",
      "  </head>",
      "  <body>"
    ];

    for (const feed of feeds) {
      const title = feed.title.replace(/"/g, "&quot;");
      const url = feed.url.replace(/"/g, "&quot;");
      const htmlUrl = feed.siteUrl ? ` htmlUrl="${feed.siteUrl.replace(/"/g, "&quot;")}"` : "";
      lines.push(`    <outline text="${title}" title="${title}" type="rss" xmlUrl="${url}"${htmlUrl} />`);
    }

    lines.push("  </body>");
    lines.push("</opml>");

    return lines.join("\n");
  }

  async createGroup(name: string): Promise<FeedGroupRecord> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error("グループ名を入力してください。");
    }

    const createdAt = nowIso();
    const groupId = createId(`group:${trimmedName}:${createdAt}`);

    await this.store.mutate((state) => {
      if (state.groups.some((group) => group.name.toLocaleLowerCase("ja") === trimmedName.toLocaleLowerCase("ja"))) {
        throw new Error("同名のグループがすでに存在します。");
      }

      state.groups.push({
        id: groupId,
        name: trimmedName,
        createdAt,
        updatedAt: createdAt
      });
    });

    return (await this.listGroups()).find((group) => group.id === groupId)!;
  }

  async renameGroup(groupId: string, name: string): Promise<FeedGroupRecord> {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error("グループ名を入力してください。");
    }

    let updated: FeedGroupRecord | undefined;

    await this.store.mutate((state) => {
      const group = state.groups.find((entry) => entry.id === groupId);
      if (!group) {
        throw new Error("グループが見つかりません。");
      }

      if (state.groups.some((entry) => entry.id !== groupId && entry.name.toLocaleLowerCase("ja") === trimmedName.toLocaleLowerCase("ja"))) {
        throw new Error("同名のグループがすでに存在します。");
      }

      group.name = trimmedName;
      group.updatedAt = nowIso();
      updated = { ...group };
    });

    return updated!;
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.store.mutate((state) => {
      const exists = state.groups.some((group) => group.id === groupId);
      if (!exists) {
        throw new Error("グループが見つかりません。");
      }

      state.groups = state.groups.filter((group) => group.id !== groupId);
      for (const feed of state.feeds) {
        if (feed.groupId === groupId) {
          feed.groupId = undefined;
          feed.updatedAt = nowIso();
        }
      }
    });
  }

  async addFeed(url: string, title?: string): Promise<FeedRecord> {
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
      throw new Error("フィード URL が空です。");
    }

    const createdAt = nowIso();
    const newFeed: FeedRecord = {
      id: createId(`feed:${normalizedUrl}`),
      url: normalizedUrl,
      title: title?.trim() || normalizedUrl,
      status: "idle",
      createdAt,
      updatedAt: createdAt
    };

    await this.store.mutate((state) => {
      if (state.feeds.some((feed) => feed.url === normalizedUrl)) {
        throw new Error("同じ URL のフィードは既に存在します。");
      }

      state.feeds.push(newFeed);
    });

    await this.refreshFeeds(newFeed.id);

    return (await this.listFeeds()).find((feed) => feed.id === newFeed.id)!;
  }

  async importOpml(opmlContent: string): Promise<OpmlImportResult> {
    const outlineTags = opmlContent.match(/<outline\b[^>]*\/?>/gi) ?? [];
    const state = await this.store.read();
    const existingUrls = new Set(state.feeds.map((feed) => feed.url));

    let importedCount = 0;
    let duplicateCount = 0;
    let skippedCount = 0;
    const feedIdsToRefresh: string[] = [];

    await this.store.mutate((mutableState) => {
      for (const outlineTag of outlineTags) {
        const url = readAttribute(outlineTag, "xmlUrl");
        if (!url) {
          skippedCount += 1;
          continue;
        }

        const normalizedUrl = normalizeUrl(url);
        if (!normalizedUrl) {
          skippedCount += 1;
          continue;
        }

        if (existingUrls.has(normalizedUrl)) {
          duplicateCount += 1;
          continue;
        }

        const title =
          readAttribute(outlineTag, "title") ??
          readAttribute(outlineTag, "text") ??
          normalizedUrl;

        const createdAt = nowIso();
        const feedId = createId(`feed:${normalizedUrl}`);

        mutableState.feeds.push({
          id: feedId,
          url: normalizedUrl,
          title,
          faviconUrl: undefined,
          status: "idle",
          createdAt,
          updatedAt: createdAt
        });

        existingUrls.add(normalizedUrl);
        feedIdsToRefresh.push(feedId);
        importedCount += 1;
      }
    });

    for (const feedId of feedIdsToRefresh) {
      await this.refreshSingleFeed(feedId);
    }

    return {
      importedCount,
      duplicateCount,
      skippedCount
    };
  }

  async removeFeed(feedId: string): Promise<void> {
    await this.store.mutate((state) => {
      state.feeds = state.feeds.filter((feed) => feed.id !== feedId);
      state.articles = state.articles.filter((article) => article.feedId !== feedId);
    });
  }

  async assignFeedToGroup(feedId: string, groupId?: string): Promise<FeedRecord> {
    let updated: FeedRecord | undefined;

    await this.store.mutate((state) => {
      const feed = state.feeds.find((entry) => entry.id === feedId);
      if (!feed) {
        throw new Error("フィードが見つかりません。");
      }

      if (groupId && !state.groups.some((group) => group.id === groupId)) {
        throw new Error("指定したグループが見つかりません。");
      }

      feed.groupId = groupId;
      feed.updatedAt = nowIso();
      updated = { ...feed };
    });

    return updated!;
  }

  async markArticleRead(articleId: string, isRead: boolean): Promise<ArticleRecord> {
    let updated: ArticleRecord | undefined;

    await this.store.mutate((state) => {
      const article = state.articles.find((entry) => entry.id === articleId);
      if (!article) {
        throw new Error("記事が見つかりません。");
      }

      article.isRead = isRead;
      article.updatedAt = nowIso();
      updated = { ...article };
    });

    return updated!;
  }

  async markArticlesRead(articleIds: string[], isRead: boolean): Promise<BulkReadResult> {
    const uniqueIds = new Set(articleIds);
    let updatedCount = 0;

    await this.store.mutate((state) => {
      for (const article of state.articles) {
        if (!uniqueIds.has(article.id)) {
          continue;
        }
        if (article.isRead === isRead) {
          continue;
        }

        article.isRead = isRead;
        article.updatedAt = nowIso();
        updatedCount += 1;
      }
    });

    return { updatedCount };
  }

  async markArticleReadLater(articleId: string, isReadLater: boolean): Promise<ArticleRecord> {
    let updated: ArticleRecord | undefined;

    await this.store.mutate((state) => {
      const article = state.articles.find((entry) => entry.id === articleId);
      if (!article) {
        throw new Error("記事が見つかりません。");
      }

      article.isReadLater = isReadLater;
      article.updatedAt = nowIso();
      updated = { ...article };
    });

    return updated!;
  }

  async refreshFeeds(feedId?: string): Promise<FeedRecord[]> {
    await this.maybeCleanupReadArticles();
    const state = await this.store.read();
    const targetFeeds = feedId
      ? state.feeds.filter((feed) => feed.id === feedId)
      : state.feeds;

    for (const feed of targetFeeds) {
      await this.refreshSingleFeed(feed.id);
    }

    return this.listFeeds();
  }

  createAutoRefreshTask(): () => void {
    if (this.refreshIntervalMinutes <= 0) {
      return () => undefined;
    }

    const interval = setInterval(() => {
      void this.refreshFeeds().catch((error) => {
        console.error("[rss-server] 自動更新に失敗しました。", error);
      });
    }, this.refreshIntervalMinutes * 60 * 1000);

    return () => clearInterval(interval);
  }

  private async maybeCleanupReadArticles(force = false): Promise<void> {
    if (this.readRetentionDays <= 0) {
      return;
    }

    const now = Date.now();
    const cleanupIntervalMs = 6 * 60 * 60 * 1000;
    if (!force && now - this.lastCleanupAt < cleanupIntervalMs) {
      return;
    }

    const cutoffTime = now - this.readRetentionDays * 24 * 60 * 60 * 1000;
    await this.store.mutate((state) => {
      state.articles = state.articles.filter((article) => {
        if (!article.isRead) {
          return true;
        }

        return new Date(article.updatedAt).getTime() >= cutoffTime;
      });
    });
    this.lastCleanupAt = now;
  }

  private async refreshSingleFeed(feedId: string): Promise<void> {
    const state = await this.store.read();
    const feed = state.feeds.find((entry) => entry.id === feedId);
    if (!feed) {
      return;
    }

    try {
      const response = await fetch(feed.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const xml = await response.text();
      const parsed = await this.parser.parseString(xml);
      const fetchedAt = nowIso();

      await this.store.mutate((mutableState) => {
        const mutableFeed = mutableState.feeds.find((entry) => entry.id === feedId);
        if (!mutableFeed) {
          return;
        }

        mutableFeed.title = parsed.title || mutableFeed.title;
        mutableFeed.siteUrl = parsed.link || mutableFeed.siteUrl;
        mutableFeed.faviconUrl = buildFaviconUrl(parsed.link || mutableFeed.siteUrl);
        mutableFeed.description = parsed.description || mutableFeed.description;
        mutableFeed.status = "ok";
        mutableFeed.errorMessage = undefined;
        mutableFeed.lastFetchedAt = fetchedAt;
        mutableFeed.updatedAt = fetchedAt;

        for (const rawItem of parsed.items ?? []) {
          const item = rawItem as ParsedItem;
          const link = typeof item.link === "string" ? normalizeUrl(item.link) : "";
          const title = typeof item.title === "string" ? item.title.trim() : "";

          if (!link || !title) {
            continue;
          }

          const articleId = createId(`article:${feedId}:${link}`);
          const existing = mutableState.articles.find((article) => article.id === articleId);
          const imageUrl = extractImageUrl(item);
          const publishedAt = item.pubDate ? new Date(item.pubDate).toISOString() : fetchedAt;

          if (existing) {
            existing.title = title;
            existing.author = item.creator ?? existing.author;
            existing.publishedAt = publishedAt;
            existing.snippet = item.contentSnippet ?? existing.snippet;
            existing.contentHtml = item["content:encoded"] ?? item.content ?? existing.contentHtml;
            existing.imageUrl = imageUrl ?? existing.imageUrl;
            existing.updatedAt = fetchedAt;
            continue;
          }

          mutableState.articles.push({
            id: articleId,
            feedId,
            title,
            link,
            author: item.creator,
            publishedAt,
            snippet: item.contentSnippet,
            contentHtml: item["content:encoded"] ?? item.content,
            imageUrl,
            isRead: false,
            isReadLater: false,
            fetchedAt,
            updatedAt: fetchedAt
          });
        }
      });
    } catch (error) {
      await this.store.mutate((mutableState) => {
        const mutableFeed = mutableState.feeds.find((entry) => entry.id === feedId);
        if (!mutableFeed) {
          return;
        }

        mutableFeed.status = "error";
        mutableFeed.errorMessage = error instanceof Error ? error.message : String(error);
        mutableFeed.updatedAt = nowIso();
      });
    }
  }
}

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Parser from "rss-parser";
import type { StateStore } from "./store.js";
import type {
  BulkReadResult,
  FilteredReadRequest,
  ArticleListFilters,
  ArticleRecord,
  FeedGroupRecord,
  FeedRecord,
  OpmlImportResult,
  PaginatedArticlesResult
} from "./types.js";

type MediaEntry = {
  $?: { url?: string; type?: string; medium?: string };
  url?: string;
  type?: string;
  medium?: string;
};

type MediaValue = MediaEntry | MediaEntry[] | string;

type ParsedItem = {
  title?: string;
  link?: string;
  creator?: string;
  content?: string;
  contentSnippet?: string;
  pubDate?: string;
  enclosure?: { url?: string; type?: string };
  image?: string;
  mediaContent?: MediaValue;
  mediaThumbnail?: MediaValue;
  "content:encoded"?: string;
  "media:content"?: MediaValue;
  "media:thumbnail"?: MediaValue;
};

const execFileAsync = promisify(execFile);

const FEED_REQUEST_HEADERS = {
  "user-agent": "Mozilla/5.0 (compatible; ObsidianNasRss/1.0; +https://github.com/kiryarya/obsidian_nas_rss)",
  accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
  "accept-language": "ja,en-US;q=0.9,en;q=0.8",
  pragma: "no-cache",
  "cache-control": "no-cache"
} as const;

const HTML_REQUEST_HEADERS = {
  "user-agent": FEED_REQUEST_HEADERS["user-agent"],
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": FEED_REQUEST_HEADERS["accept-language"]
} as const;

function nowIso(): string {
  return new Date().toISOString();
}

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeUrl(url: unknown): string {
  return toTrimmedString(url) ?? "";
}

function ensureHttpProtocol(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  return `https://${url}`;
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

function normalizeImageUrl(url: unknown, baseUrl?: string): string | undefined {
  const trimmedUrl = toTrimmedString(url);
  if (!trimmedUrl) {
    return undefined;
  }

  let normalized = trimmedUrl;
  if (normalized.startsWith("//")) {
    normalized = `https:${normalized}`;
  }

  try {
    normalized = baseUrl ? new URL(normalized, baseUrl).toString() : new URL(normalized).toString();
  } catch {
    return normalized.startsWith("http:") ? normalized.replace(/^http:/i, "https:") : normalized;
  }

  return normalized.startsWith("http:") ? normalized.replace(/^http:/i, "https:") : normalized;
}

function pickMediaUrl(value: MediaValue | undefined, baseUrl?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    return normalizeImageUrl(value, baseUrl);
  }

  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    const rawUrl = entry.$?.url ?? entry.url;
    if (!rawUrl) {
      continue;
    }

    const mediaType = entry.$?.type ?? entry.type;
    const mediaKind = entry.$?.medium ?? entry.medium;
    if (mediaType && !mediaType.startsWith("image") && mediaKind !== "image") {
      continue;
    }

    return normalizeImageUrl(rawUrl, baseUrl);
  }

  return undefined;
}

function extractHtmlImageUrl(html: string | undefined, baseUrl?: string): string | undefined {
  if (!html) {
    return undefined;
  }

  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return normalizeImageUrl(match?.[1], baseUrl);
}

function looksLikeHtml(content: string, contentType: string): boolean {
  const normalizedType = contentType.toLowerCase();
  if (normalizedType.includes("text/html")) {
    return true;
  }

  const normalizedBody = content.trim().toLowerCase();
  if (!normalizedBody) {
    return false;
  }

  return normalizedBody.startsWith("<!doctype html") || normalizedBody.startsWith("<html") || normalizedBody.includes("<html");
}

function parseMetaImageUrl(html: string, pageUrl: string): string | undefined {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const attributeEntries = Array.from(tag.matchAll(/([^\s=/>]+)\s*=\s*["']([^"']*)["']/gi));
    const attributes = new Map(
      attributeEntries.map(([, key, value]) => [key.toLowerCase(), decodeXmlEntities(value)])
    );
    const propertyName = attributes.get("property") ?? attributes.get("name") ?? "";
    const normalizedPropertyName = propertyName.toLowerCase();
    const isTarget = [
      "og:image",
      "og:image:secure_url",
      "twitter:image",
      "twitter:image:src",
      "thumbnail"
    ].includes(normalizedPropertyName);
    if (!isTarget) {
      continue;
    }

    const content = attributes.get("content");
    if (content) {
      return normalizeImageUrl(content, pageUrl);
    }
  }

  return undefined;
}

function toIsoDate(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function extractImageUrl(item: ParsedItem, articleUrl?: string): string | undefined {
  if (item.enclosure?.url && item.enclosure.type?.startsWith("image")) {
    return normalizeImageUrl(item.enclosure.url, articleUrl);
  }

  const fromMediaContent = pickMediaUrl(item.mediaContent, articleUrl) ?? pickMediaUrl(item["media:content"], articleUrl);
  if (fromMediaContent) {
    return fromMediaContent;
  }

  const fromMediaThumbnail = pickMediaUrl(item.mediaThumbnail, articleUrl) ?? pickMediaUrl(item["media:thumbnail"], articleUrl);
  if (fromMediaThumbnail) {
    return fromMediaThumbnail;
  }

  const fromItemImage = normalizeImageUrl(item.image, articleUrl);
  if (fromItemImage) {
    return fromItemImage;
  }

  const fromHtml = extractHtmlImageUrl(item["content:encoded"] ?? item.content, articleUrl);
  if (fromHtml) {
    return fromHtml;
  }

  const snippetImage = extractHtmlImageUrl(item.contentSnippet, articleUrl);
  if (snippetImage) {
    return snippetImage;
  }

  return undefined;
}

type OgImageCandidate = {
  articleId: string;
  articleUrl: string;
};

async function runInChunks<T>(values: T[], size: number, task: (value: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < values.length; index += size) {
    const chunk = values.slice(index, index + size);
    await Promise.all(chunk.map((value) => task(value)));
  }
}

async function fetchText(
  url: string,
  headers: HeadersInit,
  timeoutMs: number,
  attempts = 1
): Promise<{ body: string; contentType: string }> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return {
        body: await response.text(),
        contentType: response.headers.get("content-type") ?? ""
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchWithSystemTool(url: string): Promise<string> {
  const acceptHeader = FEED_REQUEST_HEADERS.accept;
  const userAgent = FEED_REQUEST_HEADERS["user-agent"];
  const commands: Array<{ command: string; args: string[] }> = [
    {
      command: "wget",
      args: [
        "-qO-",
        "--timeout=10",
        "--tries=1",
        `--user-agent=${userAgent}`,
        `--header=Accept: ${acceptHeader}`,
        url
      ]
    },
    {
      command: "curl",
      args: [
        "-fsSL",
        "--max-time",
        "10",
        "-A",
        userAgent,
        "-H",
        `Accept: ${acceptHeader}`,
        url
      ]
    }
  ];

  let lastError: unknown;
  for (const entry of commands) {
    try {
      const { stdout } = await execFileAsync(entry.command, entry.args, {
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 8
      });
      if (stdout.trim()) {
        return stdout;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("feed fetch fallback failed");
}

async function fetchFeedXml(url: string): Promise<string> {
  const { body, contentType } = await fetchText(url, FEED_REQUEST_HEADERS, 7000, 1);
  if (looksLikeHtml(body, contentType)) {
    throw new Error("RSS/XML ではなく HTML が返されました");
  }

  return body;
}

async function fetchFeedXmlWithFallback(url: string): Promise<string> {
  try {
    return await fetchFeedXml(url);
  } catch (primaryError) {
    let fallbackBody: string | undefined;
    let fallbackError: unknown;
    try {
      fallbackBody = await fetchWithSystemTool(url);
    } catch (error) {
      fallbackError = error;
    }
    if (!fallbackBody) {
      throw fallbackError instanceof Error ? fallbackError : primaryError;
    }

    if (looksLikeHtml(fallbackBody, "application/xml")) {
      throw new Error("RSS/XML ではなく HTML が返されました");
    }

    return fallbackBody;
  }
}

async function fetchOpenGraphImage(url: string): Promise<string | undefined> {
  try {
    const { body } = await fetchText(url, HTML_REQUEST_HEADERS, 4000, 1);
    return parseMetaImageUrl(body, url);
  } catch {
    return undefined;
  }
}

function extractDiscoveredFeedUrls(html: string, pageUrl: string): string[] {
  const feedUrls: string[] = [];
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const relMatch = tag.match(/\brel=["']([^"']+)["']/i);
    const typeMatch = tag.match(/\btype=["']([^"']+)["']/i);
    const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
    const rel = relMatch?.[1]?.toLowerCase() ?? "";
    const type = typeMatch?.[1]?.toLowerCase() ?? "";
    const href = hrefMatch?.[1];

    if (!rel.includes("alternate") || !href) {
      continue;
    }

    if (!type.includes("rss") && !type.includes("atom") && !type.includes("xml") && !type.includes("json")) {
      continue;
    }

    const normalized = normalizeImageUrl(href, pageUrl);
    if (normalized) {
      feedUrls.push(normalized);
    }
  }

  return feedUrls;
}

function buildCommonFeedUrls(pageUrl: string): string[] {
  const candidates = new Set<string>();

  try {
    const url = new URL(pageUrl);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const bases = new Set<string>(["/"]);

    if (pathSegments.length > 0) {
      for (let count = pathSegments.length; count >= 1; count -= 1) {
        bases.add(`/${pathSegments.slice(0, count).join("/")}`);
      }
    }

    for (const base of bases) {
      for (const suffix of ["/rss.xml", "/feed", "/feed.xml", "/atom.xml", "/index.xml"]) {
        const pathname = base === "/" ? suffix : `${base}${suffix}`;
        candidates.add(new URL(pathname, url.origin).toString());
      }
    }
  } catch {
    return [];
  }

  return Array.from(candidates);
}

function isLikelyFeedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase().replace(/\/+$/, "");
    return (
      /\.(xml|rss|atom|json)$/i.test(pathname) ||
      pathname.endsWith("/feed") ||
      pathname.endsWith("/rss") ||
      pathname.endsWith("/atom")
    );
  } catch {
    return /\.(xml|rss|atom|json)(\?.*)?$/i.test(url) || /\/(feed|rss|atom)(\?.*)?$/i.test(url);
  }
}

async function resolveFeedUrl(inputUrl: unknown): Promise<string> {
  const normalizedInputUrl = ensureHttpProtocol(normalizeUrl(inputUrl));
  if (!normalizedInputUrl) {
    throw new Error("FEED URL を入力してください");
  }

  let initialFetchError: unknown;
  try {
    await fetchFeedXmlWithFallback(normalizedInputUrl);
    return normalizedInputUrl;
  } catch (error) {
    initialFetchError = error;
    if (isLikelyFeedUrl(normalizedInputUrl)) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  const candidateUrls = new Set(buildCommonFeedUrls(normalizedInputUrl));

  try {
    const { body, contentType } = await fetchText(normalizedInputUrl, HTML_REQUEST_HEADERS, 4000, 1);
    if (looksLikeHtml(body, contentType)) {
      for (const discoveredUrl of extractDiscoveredFeedUrls(body, normalizedInputUrl)) {
        candidateUrls.add(discoveredUrl);
      }
    }
  } catch {
    // HTML discovery is best-effort only.
  }

  for (const candidateUrl of Array.from(candidateUrls).slice(0, 6)) {
    try {
      await fetchFeedXmlWithFallback(candidateUrl);
      return candidateUrl;
    } catch {
      // Keep trying.
    }
  }

  if (initialFetchError instanceof Error && initialFetchError.message) {
    throw initialFetchError;
  }

  throw new Error("指定した URL から有効な FEED を見つけられませんでした");
}

export class RssService {
  private lastCleanupAt = 0;
  private readonly parser = new Parser({
    headers: FEED_REQUEST_HEADERS,
    timeout: 10000,
    maxRedirects: 5,
    customFields: {
      item: [
        ["media:content", "media:content"],
        ["media:content", "mediaContent"],
        ["media:thumbnail", "media:thumbnail"],
        ["media:thumbnail", "mediaThumbnail"],
        ["enclosure", "enclosure"],
        ["content:encoded", "content:encoded"],
        ["image", "image"]
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
      .filter((article) => (filters.readOnly ? article.isRead : true))
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
      .sort((left, right) => new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime());

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
    const normalizedUrl = ensureHttpProtocol(normalizeUrl(url));
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

    void this.refreshSingleFeed(newFeed.id);

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

  async markFilteredArticlesRead(filters: FilteredReadRequest, isRead: boolean): Promise<BulkReadResult> {
    const result = await this.listArticles({
      ...filters
    });
    return this.markArticlesRead(
      result.articles.map((article) => article.id),
      isRead
    );
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

    await runInChunks(targetFeeds, 4, async (feed) => {
      await this.refreshSingleFeed(feed.id);
    });

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
      let workingUrl = feed.url;
      let parsed: Awaited<ReturnType<Parser["parseString"]>>;
      try {
        const xml = await fetchFeedXmlWithFallback(workingUrl);
        parsed = await this.parser.parseString(xml);
      } catch {
        try {
          parsed = await this.parser.parseURL(workingUrl);
        } catch {
          const resolvedUrl = await resolveFeedUrl(feed.url);
          workingUrl = resolvedUrl;

          try {
            const xml = await fetchFeedXmlWithFallback(workingUrl);
            parsed = await this.parser.parseString(xml);
          } catch {
            parsed = await this.parser.parseURL(workingUrl);
          }
        }
      }
      const fetchedAt = nowIso();
      const ogImageCandidates: OgImageCandidate[] = [];

      await this.store.mutate((mutableState) => {
        const mutableFeed = mutableState.feeds.find((entry) => entry.id === feedId);
        if (!mutableFeed) {
          return;
        }

        mutableFeed.url = workingUrl;
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
          const imageUrl = extractImageUrl(item, link);
          const publishedAt = toIsoDate(item.pubDate, fetchedAt);

          if (existing) {
            existing.title = title;
            existing.author = item.creator ?? existing.author;
            existing.publishedAt = publishedAt;
            existing.snippet = item.contentSnippet ?? existing.snippet;
            existing.contentHtml = item["content:encoded"] ?? item.content ?? existing.contentHtml;
            existing.imageUrl = imageUrl ?? existing.imageUrl;
            existing.updatedAt = fetchedAt;
            if (!existing.imageUrl && !existing.isRead) {
              ogImageCandidates.push({
                articleId: existing.id,
                articleUrl: existing.link
              });
            }
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

          if (!imageUrl) {
            ogImageCandidates.push({
              articleId,
              articleUrl: link
            });
          }
        }
      });

      const uniqueCandidates = Array.from(
        new Map(
          ogImageCandidates
            .filter((candidate) => candidate.articleUrl)
            .map((candidate) => [candidate.articleId, candidate])
        ).values()
      ).slice(0, 30);

      if (uniqueCandidates.length > 0) {
        const resolvedImages = new Map<string, string>();
        await runInChunks(uniqueCandidates, 4, async (candidate) => {
          const ogImageUrl = await fetchOpenGraphImage(candidate.articleUrl);
          if (ogImageUrl) {
            resolvedImages.set(candidate.articleId, ogImageUrl);
          }
        });

        if (resolvedImages.size > 0) {
          await this.store.mutate((mutableState) => {
            for (const article of mutableState.articles) {
              const ogImageUrl = resolvedImages.get(article.id);
              if (!ogImageUrl || article.imageUrl) {
                continue;
              }

              article.imageUrl = ogImageUrl;
              article.updatedAt = fetchedAt;
            }
          });
        }
      }
    } catch (error) {
      console.error("[rss-server] feed refresh failed", {
        feedId,
        feedUrl: feed.url,
        message: error instanceof Error ? error.message : String(error)
      });

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

import { requestUrl } from "obsidian";
import type {
  ArticlePageDto,
  ArticleDto,
  BulkReadResult,
  FeedDto,
  FeedGroupDto,
  OpmlImportResult,
  RefreshJobDto
} from "./types";

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

export class NasRssApiClient {
  constructor(private readonly getBaseUrl: () => string) {}

  async getFeeds(): Promise<FeedDto[]> {
    const response = await this.requestJson<{ feeds: FeedDto[] }>({
      path: "/api/feeds"
    });
    return response.feeds;
  }

  async addFeed(url: string, title?: string): Promise<FeedDto> {
    const response = await this.requestJson<{ feed: FeedDto }>({
      method: "POST",
      path: "/api/feeds",
      body: { url, title }
    });
    return response.feed;
  }

  async getGroups(): Promise<FeedGroupDto[]> {
    const response = await this.requestJson<{ groups: FeedGroupDto[] }>({
      path: "/api/groups"
    });
    return response.groups;
  }

  async createGroup(name: string): Promise<FeedGroupDto> {
    const response = await this.requestJson<{ group: FeedGroupDto }>({
      method: "POST",
      path: "/api/groups",
      body: { name }
    });
    return response.group;
  }

  async renameGroup(groupId: string, name: string): Promise<FeedGroupDto> {
    const response = await this.requestJson<{ group: FeedGroupDto }>({
      method: "PATCH",
      path: `/api/groups/${encodeURIComponent(groupId)}`,
      body: { name }
    });
    return response.group;
  }

  async deleteGroup(groupId: string): Promise<void> {
    await this.requestJson({
      method: "DELETE",
      path: `/api/groups/${encodeURIComponent(groupId)}`
    });
  }

  async deleteFeed(feedId: string): Promise<void> {
    await this.requestJson({
      method: "DELETE",
      path: `/api/feeds/${encodeURIComponent(feedId)}`
    });
  }

  async assignFeedToGroup(feedId: string, groupId?: string): Promise<FeedDto> {
    const response = await this.requestJson<{ feed: FeedDto }>({
      method: "POST",
      path: `/api/feeds/${encodeURIComponent(feedId)}/group`,
      body: groupId ? { groupId } : {}
    });
    return response.feed;
  }

  async startRefresh(feedId?: string): Promise<RefreshJobDto> {
    const response = await this.requestJson<{ job: RefreshJobDto }>({
      method: "POST",
      path: "/api/feeds/refresh",
      body: feedId ? { feedId } : {}
    });
    return response.job;
  }

  async getRefreshStatus(): Promise<RefreshJobDto> {
    const response = await this.requestJson<{ job: RefreshJobDto }>({
      path: "/api/feeds/refresh-status"
    });
    return response.job;
  }

  async importOpml(content: string): Promise<OpmlImportResult> {
    const response = await this.requestJson<{ result: OpmlImportResult }>({
      method: "POST",
      path: "/api/feeds/import-opml",
      body: { content }
    });
    return response.result;
  }

  async getArticles(options: {
    feedId?: string;
    groupId?: string;
    readOnly?: boolean;
    unreadOnly?: boolean;
    readLaterOnly?: boolean;
    query?: string;
    offset?: number;
    limit?: number;
  }): Promise<ArticlePageDto> {
    const params = new URLSearchParams();

    if (options.feedId) {
      params.set("feedId", options.feedId);
    }
    if (options.groupId) {
      params.set("groupId", options.groupId);
    }
    if (typeof options.unreadOnly === "boolean") {
      params.set("unreadOnly", String(options.unreadOnly));
    }
    if (typeof options.readOnly === "boolean") {
      params.set("readOnly", String(options.readOnly));
    }
    if (typeof options.readLaterOnly === "boolean") {
      params.set("readLaterOnly", String(options.readLaterOnly));
    }
    if (options.query) {
      params.set("query", options.query);
    }
    if (typeof options.offset === "number") {
      params.set("offset", String(options.offset));
    }
    if (typeof options.limit === "number") {
      params.set("limit", String(options.limit));
    }

    const response = await this.requestJson<ArticlePageDto>({
      path: `/api/articles${params.size > 0 ? `?${params.toString()}` : ""}`
    });
    return response;
  }

  async getArticle(articleId: string): Promise<ArticleDto> {
    const response = await this.requestJson<{ article: ArticleDto }>({
      path: `/api/articles/${encodeURIComponent(articleId)}`
    });
    return response.article;
  }

  async setRead(articleId: string, isRead: boolean): Promise<ArticleDto> {
    const response = await this.requestJson<{ article: ArticleDto }>({
      method: "POST",
      path: `/api/articles/${encodeURIComponent(articleId)}/read`,
      body: { isRead }
    });
    return response.article;
  }

  async setReadLater(articleId: string, isReadLater: boolean): Promise<ArticleDto> {
    const response = await this.requestJson<{ article: ArticleDto }>({
      method: "POST",
      path: `/api/articles/${encodeURIComponent(articleId)}/read-later`,
      body: { isReadLater }
    });
    return response.article;
  }

  async setReadBulk(articleIds: string[], isRead: boolean): Promise<BulkReadResult> {
    const response = await this.requestJson<{ result: BulkReadResult }>({
      method: "POST",
      path: "/api/articles/read-bulk",
      body: { articleIds, isRead }
    });
    return response.result;
  }

  async setReadFiltered(options: {
    isRead: boolean;
    feedId?: string;
    groupId?: string;
    readOnly?: boolean;
    unreadOnly?: boolean;
    readLaterOnly?: boolean;
    query?: string;
  }): Promise<BulkReadResult> {
    const response = await this.requestJson<{ result: BulkReadResult }>({
      method: "POST",
      path: "/api/articles/read-filtered",
      body: options
    });
    return response.result;
  }

  async exportOpml(): Promise<string> {
    const baseUrl = this.getBaseUrl().replace(/\/$/, "");
    const response = await requestUrl({
      url: `${baseUrl}/api/feeds/export-opml`,
      method: "GET"
    });

    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.text;
  }

  private async requestJson<T>(options: RequestOptions): Promise<T> {
    const baseUrl = this.getBaseUrl().replace(/\/$/, "");
    const response = await requestUrl({
      url: `${baseUrl}${options.path}`,
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (response.status >= 400) {
      let payload: { message?: string } | undefined;
      if (response.text) {
        try {
          payload = JSON.parse(response.text) as { message?: string };
        } catch {
          payload = undefined;
        }
      }
      throw new Error(payload?.message ?? `HTTP ${response.status}`);
    }

    if (!response.text) {
      return undefined as T;
    }

    return JSON.parse(response.text) as T;
  }
}

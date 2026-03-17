import { ItemView, Menu, Notice, WorkspaceLeaf } from "obsidian";
import { NoteManager } from "../NoteManager";
import type NasRssViewerPlugin from "../main";
import type { ArticleDto, ArticlePageDto, FeedDto, FeedGroupDto, RefreshJobDto } from "../types";

export const NAS_RSS_VIEW_TYPE = "nas-rss-view";

type SourceFilter = "all" | "read" | "unread" | "read-later" | `feed:${string}` | `group:${string}`;

interface ViewStateModel {
  feeds: FeedDto[];
  groups: FeedGroupDto[];
  articles: ArticleDto[];
  totalArticles: number;
  selectedSource: SourceFilter;
  searchQuery: string;
  currentPage: number;
  collapsedGroupIds: Set<string>;
  loading: boolean;
  refreshJob?: RefreshJobDto;
  error?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripHtml(value?: string): string {
  if (!value) {
    return "";
  }

  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("ja-JP");
}

async function openInDefaultBrowser(url: string): Promise<void> {
  const electronRequire = (window as Window & {
    require?: (moduleName: string) => { shell?: { openExternal?: (targetUrl: string) => Promise<void> | void } };
  }).require;

  const openExternal = electronRequire?.("electron")?.shell?.openExternal;
  if (openExternal) {
    await openExternal(url);
    return;
  }

  window.open(url, "_blank", "noopener");
}

export class NasRssView extends ItemView {
  private readonly noteManager: NoteManager;
  private state: ViewStateModel;
  private refreshPollTimer: number | null = null;
  private readonly readInFlightIds = new Set<string>();
  private readonly savedArticleIds = new Set<string>();
  private articleScrollTop = 0;
  private unreadSessionKey = "";
  private unreadSessionTotal = 0;
  private readonly unreadSessionPages = new Map<number, ArticleDto[]>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: NasRssViewerPlugin
  ) {
    super(leaf);
    this.noteManager = new NoteManager(plugin.app);
    this.state = {
      feeds: [],
      groups: [],
      articles: [],
      totalArticles: 0,
      selectedSource: plugin.settings.unreadOnlyDefault ? "unread" : "all",
      searchQuery: "",
      currentPage: 1,
      collapsedGroupIds: new Set<string>(),
      loading: false
    };
  }

  getViewType(): string {
    return NAS_RSS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "NAS RSS";
  }

  getIcon(): string {
    return "rss";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.stopRefreshPolling();
  }

  async refresh(): Promise<void> {
    this.state.loading = true;
    this.state.error = undefined;
    this.render();

    try {
      const [feeds, articlePage, groups, refreshJob] = await Promise.all([
        this.plugin.apiClient.getFeeds(),
        this.loadArticlesForSelection(),
        this.loadGroupsSafely(),
        this.loadRefreshStatusSafely()
      ]);

      const existingCollapsed = new Set(this.state.collapsedGroupIds);
      this.state.feeds = feeds;
      this.state.groups = groups;
      this.state.articles = articlePage.articles;
      this.state.totalArticles = articlePage.total;
      this.state.refreshJob = refreshJob;
      this.state.collapsedGroupIds = new Set(
        groups
          .filter((group) => existingCollapsed.has(group.id))
          .map((group) => group.id)
      );

      if (refreshJob.status === "running") {
        this.startRefreshPolling();
      } else {
        this.stopRefreshPolling();
      }

      this.ensureSelectedSourceStillExists();
      const normalizedPage = this.normalizePage(this.state.currentPage, this.state.totalArticles);
      if (normalizedPage !== this.state.currentPage && this.state.totalArticles > 0) {
        this.state.currentPage = normalizedPage;
        const correctedPage = await this.loadArticlesForSelection();
        this.state.articles = correctedPage.articles;
        this.state.totalArticles = correctedPage.total;
      } else {
        this.state.currentPage = normalizedPage;
      }
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.state.loading = false;
      this.render();
    }
  }

  private async loadArticlesForSelection(): Promise<ArticlePageDto> {
    const selectedFeedId = this.getSelectedFeedId();
    const selectedGroupId = this.getSelectedGroupId();
    const limit = this.getItemsPerPage();
    const query = this.state.searchQuery.trim() || undefined;

    if (this.state.selectedSource === "unread") {
      return this.loadUnreadSessionPage(query, limit);
    }

    const offset = (this.normalizePage(this.state.currentPage, this.state.totalArticles || limit) - 1) * limit;

    if (this.state.selectedSource === "read") {
      return this.plugin.apiClient.getArticles({
        readOnly: true,
        query,
        offset,
        limit
      });
    }

    if (this.state.selectedSource === "read-later") {
      return this.plugin.apiClient.getArticles({
        readLaterOnly: true,
        query,
        offset,
        limit
      });
    }

    if (selectedFeedId) {
      return this.plugin.apiClient.getArticles({
        feedId: selectedFeedId,
        query,
        offset,
        limit
      });
    }

    if (selectedGroupId) {
      return this.plugin.apiClient.getArticles({
        groupId: selectedGroupId,
        query,
        offset,
        limit
      });
    }

    return this.plugin.apiClient.getArticles({
      query,
      offset,
      limit
    });
  }

  private async loadGroupsSafely(): Promise<FeedGroupDto[]> {
    try {
      return await this.plugin.apiClient.getGroups();
    } catch {
      return [];
    }
  }

  private async loadRefreshStatusSafely(): Promise<RefreshJobDto> {
    try {
      return await this.plugin.apiClient.getRefreshStatus();
    } catch {
      return {
        id: "legacy-server",
        status: "idle"
      };
    }
  }

  private getUnreadSessionKey(query?: string): string {
    return `${this.state.selectedSource}::${query ?? ""}::${this.getItemsPerPage()}`;
  }

  private resetUnreadSession(): void {
    this.unreadSessionKey = "";
    this.unreadSessionTotal = 0;
    this.unreadSessionPages.clear();
  }

  private async loadUnreadSessionPage(query: string | undefined, limit: number): Promise<ArticlePageDto> {
    const sessionKey = this.getUnreadSessionKey(query);
    if (this.unreadSessionKey !== sessionKey) {
      this.resetUnreadSession();
      this.unreadSessionKey = sessionKey;
    }

    const page = Math.max(1, this.state.currentPage);
    const cached = this.unreadSessionPages.get(page);
    if (cached) {
      return {
        articles: cached,
        total: this.unreadSessionTotal
      };
    }

    const result = await this.plugin.apiClient.getArticles({
      unreadOnly: true,
      query,
      offset: (page - 1) * limit,
      limit
    });

    this.unreadSessionPages.set(page, result.articles);
    this.unreadSessionTotal = result.total;
    return result;
  }

  private ensureSelectedSourceStillExists(): void {
    const feedId = this.getSelectedFeedId();
    if (feedId && !this.state.feeds.some((feed) => feed.id === feedId)) {
      this.state.selectedSource = "all";
      return;
    }

    const groupId = this.getSelectedGroupId();
    if (groupId && !this.state.groups.some((group) => group.id === groupId)) {
      this.state.selectedSource = "all";
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("nas-rss-view");
    contentEl.style.setProperty(
      "--nas-rss-card-width",
      `${Math.max(220, this.plugin.settings.cardMinWidth)}px`
    );

    const layout = contentEl.createDiv({ cls: "nas-rss-layout" });
    const sidebar = layout.createDiv({ cls: "nas-rss-sidebar" });
    const main = layout.createDiv({ cls: "nas-rss-main" });

    this.renderSidebar(sidebar);
    this.renderMain(main);
  }

  private renderSidebar(sidebarEl: HTMLDivElement): void {
    const headerEl = sidebarEl.createDiv({ cls: "nas-rss-sidebar-header" });
    headerEl.createDiv({ cls: "nas-rss-sidebar-title", text: "RSS FEED" });

    const headerActionsEl = headerEl.createDiv({ cls: "nas-rss-sidebar-actions" });
    const addFeedButton = headerActionsEl.createEl("button", {
      cls: "nas-rss-secondary-button",
      text: "FEED追加"
    });
    addFeedButton.onclick = () => {
      void this.handleAddFeed();
    };

    const addGroupButton = headerActionsEl.createEl("button", {
      cls: "nas-rss-secondary-button",
      text: "グループ追加"
    });
    addGroupButton.onclick = () => {
      void this.handleAddGroup();
    };

    const sidebarBodyEl = sidebarEl.createDiv({ cls: "nas-rss-sidebar-body" });
    this.renderSidebarFilters(sidebarBodyEl);

    const groupedFeedIds = new Set(
      this.state.feeds
        .filter((feed) => Boolean(feed.groupId))
        .map((feed) => feed.id)
    );

    for (const group of this.state.groups) {
      const groupFeeds = this.state.feeds.filter((feed) => feed.groupId === group.id);
      const sectionEl = sidebarBodyEl.createDiv({ cls: "nas-rss-group-section" });
      const headerRowEl = sectionEl.createDiv({
        cls: `nas-rss-group-header ${this.isGroupSelected(group.id) ? "is-active" : ""}`
      });

      const leftEl = headerRowEl.createDiv({ cls: "nas-rss-group-header-left" });
      const toggleButton = leftEl.createEl("button", {
        cls: "nas-rss-icon-button",
        text: this.state.collapsedGroupIds.has(group.id) ? "▶" : "▼"
      });
      toggleButton.onclick = (event) => {
        event.stopPropagation();
        this.toggleGroupCollapse(group.id);
      };

      const labelButton = leftEl.createEl("button", {
        cls: "nas-rss-group-label",
        text: `${group.name} (${groupFeeds.length})`
      });
      labelButton.onclick = () => {
        this.articleScrollTop = 0;
        this.state.currentPage = 1;
        this.state.selectedSource = `group:${group.id}`;
        this.resetUnreadSession();
        void this.refresh();
      };

      const actionsButton = headerRowEl.createEl("button", {
        cls: "nas-rss-icon-button",
        text: "..."
      });
      actionsButton.onclick = (event) => {
        event.stopPropagation();
        this.openGroupMenu(group, event);
      };

      if (!this.state.collapsedGroupIds.has(group.id)) {
        const feedsEl = sectionEl.createDiv({ cls: "nas-rss-group-feeds" });
        for (const feed of groupFeeds) {
          this.renderFeedItem(feedsEl, feed);
        }
      }
    }

    const ungroupedFeeds = this.state.feeds.filter((feed) => !groupedFeedIds.has(feed.id));
    if (ungroupedFeeds.length > 0) {
      const sectionEl = sidebarBodyEl.createDiv({ cls: "nas-rss-group-section" });
      sectionEl.createDiv({ cls: "nas-rss-ungrouped-label", text: "未分類" });
      const feedsEl = sectionEl.createDiv({ cls: "nas-rss-group-feeds" });
      for (const feed of ungroupedFeeds) {
        this.renderFeedItem(feedsEl, feed);
      }
    }
  }

  private renderSidebarFilters(parentEl: HTMLDivElement): void {
    const sectionEl = parentEl.createDiv({ cls: "nas-rss-sidebar-filters" });
    this.renderSidebarFilterItem(sectionEl, "all", "すべて");
    this.renderSidebarFilterItem(sectionEl, "read", "既読");
    this.renderSidebarFilterItem(sectionEl, "read-later", "後で読む");
    this.renderSidebarFilterItem(sectionEl, "unread", "未読");
  }

  private renderSidebarFilterItem(
    parentEl: HTMLDivElement,
    source: SourceFilter,
    label: string
  ): void {
    const button = parentEl.createEl("button", {
      cls: `nas-rss-sidebar-item nas-rss-filter-chip ${this.state.selectedSource === source ? "is-active" : ""}`,
      text: label
    });
    button.onclick = () => {
      this.articleScrollTop = 0;
      this.state.currentPage = 1;
      this.state.selectedSource = source;
      this.resetUnreadSession();
      void this.refresh();
    };
  }

  private renderFeedItem(parentEl: HTMLDivElement, feed: FeedDto): void {
    const feedEl = parentEl.createDiv({
      cls: `nas-rss-feed-item ${this.isFeedSelected(feed.id) ? "is-active" : ""}`
    });
    feedEl.onclick = () => {
      this.articleScrollTop = 0;
      this.state.currentPage = 1;
      this.state.selectedSource = `feed:${feed.id}`;
      this.resetUnreadSession();
      void this.refresh();
    };

    const infoEl = feedEl.createDiv({ cls: "nas-rss-feed-info" });
    const titleRowEl = infoEl.createDiv({ cls: "nas-rss-feed-title-row" });

    if (feed.faviconUrl) {
      const faviconEl = titleRowEl.createEl("img", {
        cls: "nas-rss-feed-favicon"
      });
      faviconEl.src = feed.faviconUrl;
      faviconEl.alt = "";
      faviconEl.onerror = () => {
        faviconEl.remove();
      };
    }

    titleRowEl.createSpan({
      cls: `nas-rss-feed-title ${feed.status === "error" ? "is-error" : ""}`,
      text: feed.title
    });

    if (feed.status === "error") {
      titleRowEl.createSpan({ cls: "nas-rss-feed-error", text: "!" });
    }

    infoEl.createDiv({
      cls: "nas-rss-feed-url",
      text: feed.url
    });

    const actionsButton = feedEl.createEl("button", {
      cls: "nas-rss-icon-button nas-rss-feed-actions",
      text: "..."
    });
    actionsButton.onclick = (event) => {
      event.stopPropagation();
      this.openFeedMenu(feed, event);
    };
  }

  private renderMain(mainEl: HTMLDivElement): void {
    const toolbarEl = mainEl.createDiv({ cls: "nas-rss-toolbar" });
    const headingEl = toolbarEl.createDiv({ cls: "nas-rss-toolbar-heading" });
    headingEl.createDiv({
      cls: "nas-rss-toolbar-title",
      text: this.getSelectedSourceLabel()
    });

    const visibleArticles = this.getVisibleArticles();
    const totalPages = this.getDisplayTotalPages();
    this.state.currentPage = this.normalizePage(this.state.currentPage, this.state.totalArticles);
    headingEl.createDiv({
      cls: "nas-rss-toolbar-subtitle",
      text: `${this.state.totalArticles} 件 / ${this.state.currentPage} / ${totalPages} ページ`
    });

    const searchWrapEl = toolbarEl.createDiv({ cls: "nas-rss-search-wrap" });
    const searchInput = searchWrapEl.createEl("input", {
      cls: "nas-rss-search-input",
      type: "search",
      placeholder: "記事を検索"
    });
    searchInput.value = this.state.searchQuery;
    searchInput.oninput = () => {
      this.state.searchQuery = searchInput.value;
      this.state.currentPage = 1;
      this.articleScrollTop = 0;
      this.resetUnreadSession();
      void this.refresh();
    };

    const actionsEl = mainEl.createDiv({ cls: "nas-rss-toolbar-actions" });
    const refreshButton = actionsEl.createEl("button", {
      cls: "nas-rss-primary-button",
      text: this.state.refreshJob?.status === "running" ? "サーバ更新中..." : "サーバ更新"
    });
    refreshButton.disabled = this.state.refreshJob?.status === "running";
    refreshButton.onclick = async () => {
      await this.handleServerRefresh();
    };

    const markAllReadButton = actionsEl.createEl("button", {
      cls: "nas-rss-secondary-button",
      text: "表示中を既読"
    });
    markAllReadButton.onclick = async () => {
      await this.handleMarkDisplayedRead();
    };

    if (this.state.selectedSource === "unread") {
      const markUnreadAllReadButton = actionsEl.createEl("button", {
        cls: "nas-rss-secondary-button",
        text: "未読をすべて既読"
      });
      markUnreadAllReadButton.onclick = async () => {
        await this.handleMarkAllUnreadRead();
      };
    }

    const importButton = actionsEl.createEl("button", {
      cls: "nas-rss-secondary-button",
      text: "OPML取込"
    });
    importButton.onclick = async () => {
      await this.handleImportOpml();
    };

    const exportButton = actionsEl.createEl("button", {
      cls: "nas-rss-secondary-button",
      text: "OPML書出"
    });
    exportButton.onclick = async () => {
      await this.handleExportOpml();
    };

    if (this.state.refreshJob?.status === "running") {
      const statusEl = mainEl.createDiv({ cls: "nas-rss-status-banner" });
      statusEl.setText(`サーバ更新中: ${formatDateTime(this.state.refreshJob.startedAt ?? new Date().toISOString())}`);
    }

    const contentEl = mainEl.createDiv({ cls: "nas-rss-content" });
    contentEl.onscroll = () => {
      this.articleScrollTop = contentEl.scrollTop;
    };

    if (this.state.loading) {
      contentEl.createDiv({ cls: "nas-rss-empty", text: "読み込み中..." });
      return;
    }

    if (this.state.error) {
      contentEl.createDiv({ cls: "nas-rss-empty", text: `読み込みに失敗しました: ${this.state.error}` });
      return;
    }

    if (visibleArticles.length === 0) {
      contentEl.createDiv({ cls: "nas-rss-empty", text: "表示できる記事がありません。" });
      return;
    }

    const gridEl = contentEl.createDiv({ cls: "nas-rss-card-grid" });

    for (const article of visibleArticles) {
      const feed = this.state.feeds.find((entry) => entry.id === article.feedId);
      const cardEl = gridEl.createDiv({
        cls: `nas-rss-card ${article.isRead ? "is-read" : "is-unread"}`
      });
      cardEl.onclick = async () => {
        await this.openArticle(article.id);
      };
      cardEl.onmousedown = (event) => {
        if (event.button === 1) {
          event.preventDefault();
        }
      };
      cardEl.onauxclick = (event) => {
        if (event.button === 1) {
          event.preventDefault();
          event.stopPropagation();
          void this.openArticle(article.id);
        }
      };

      const thumbWrapEl = cardEl.createDiv({ cls: "nas-rss-card-thumb-wrap" });
      if (article.imageUrl) {
        const thumbEl = thumbWrapEl.createEl("img", { cls: "nas-rss-card-thumb" });
        thumbEl.src = article.imageUrl;
        thumbEl.alt = article.title;
        thumbEl.onerror = () => {
          thumbWrapEl.addClass("is-empty");
          thumbEl.remove();
        };
      } else {
        thumbWrapEl.addClass("is-empty");
      }

      const bodyEl = cardEl.createDiv({ cls: "nas-rss-card-body" });
      const metaEl = bodyEl.createDiv({ cls: "nas-rss-card-meta" });

      if (feed?.faviconUrl) {
        const feedIconEl = metaEl.createEl("img", { cls: "nas-rss-card-meta-favicon" });
        feedIconEl.src = feed.faviconUrl;
        feedIconEl.alt = "";
        feedIconEl.onerror = () => {
          feedIconEl.remove();
        };
      }

      metaEl.createSpan({ text: feed?.title ?? "Unknown Feed" });
      metaEl.createSpan({ cls: "nas-rss-card-meta-separator", text: "•" });
      metaEl.createSpan({ text: formatDateTime(article.publishedAt) });

      const titleEl = bodyEl.createDiv({ cls: "nas-rss-card-title" });
      this.renderHighlightedText(titleEl, article.title);

      bodyEl.createDiv({
        cls: "nas-rss-card-snippet",
        text: this.getArticleSummary(article)
      });

      const footerEl = bodyEl.createDiv({ cls: "nas-rss-card-footer" });
      footerEl.createDiv({
        cls: `nas-rss-read-badge ${article.isRead ? "is-read" : "is-unread"}`,
        text: article.isRead ? "既読" : "未読"
      });

      const actionsEl = footerEl.createDiv({ cls: "nas-rss-card-actions" });
      const readLaterButton = actionsEl.createEl("button", {
        cls: `nas-rss-card-action ${article.isReadLater ? "is-active" : ""}`,
        text: article.isReadLater ? "後で読む解除" : "後で読む"
      });
      readLaterButton.onclick = async (event) => {
        event.stopPropagation();
        await this.toggleReadLater(article.id);
      };

      const saveButton = actionsEl.createEl("button", {
        cls: `nas-rss-card-action ${this.savedArticleIds.has(article.id) ? "is-active" : ""}`,
        text: this.savedArticleIds.has(article.id) ? "保存済み" : "MD保存"
      });
      saveButton.onclick = async (event) => {
        event.stopPropagation();
        await this.saveArticleAsNote(article.id);
      };
    }

    window.setTimeout(() => {
      contentEl.scrollTop = this.articleScrollTop;
    }, 0);

    if (totalPages > 1) {
      const paginationEl = mainEl.createDiv({ cls: "nas-rss-pagination" });

      const prevButton = paginationEl.createEl("button", {
        cls: "nas-rss-secondary-button",
        text: "前のページ"
      });
      prevButton.disabled = this.state.currentPage <= 1;
      prevButton.onclick = async () => {
        await this.moveToPreviousPage();
      };

      paginationEl.createDiv({
        cls: "nas-rss-pagination-label",
        text: `${this.state.currentPage} / ${totalPages} ページ`
      });

      const nextButton = paginationEl.createEl("button", {
        cls: "nas-rss-primary-button",
        text: "次のページ"
      });
      nextButton.disabled = this.state.currentPage >= totalPages;
      nextButton.onclick = async () => {
        await this.moveToNextPage(visibleArticles);
      };
    }
  }

  private getVisibleArticles(): ArticleDto[] {
    return this.state.articles
      .slice()
      .sort((left, right) => new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime());
  }

  private getItemsPerPage(): number {
    const count = this.plugin.settings.itemsPerPage;
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 50;
  }

  private normalizePage(page: number, totalItems: number): number {
    const totalPages = Math.max(1, Math.ceil(totalItems / this.getItemsPerPage()));
    if (this.state.selectedSource === "unread") {
      if (totalItems === 0) {
        return 1;
      }
      return Math.max(1, page);
    }
    return Math.min(Math.max(1, page), totalPages);
  }

  private getDisplayTotalPages(): number {
    const calculatedTotalPages = Math.max(1, Math.ceil(this.state.totalArticles / this.getItemsPerPage()));
    if (this.state.selectedSource === "unread") {
      return Math.max(calculatedTotalPages, this.state.currentPage);
    }
    return calculatedTotalPages;
  }

  private getSelectedFeedId(): string | undefined {
    return this.state.selectedSource.startsWith("feed:")
      ? this.state.selectedSource.slice("feed:".length)
      : undefined;
  }

  private getSelectedGroupId(): string | undefined {
    return this.state.selectedSource.startsWith("group:")
      ? this.state.selectedSource.slice("group:".length)
      : undefined;
  }

  private isFeedSelected(feedId: string): boolean {
    return this.getSelectedFeedId() === feedId;
  }

  private isGroupSelected(groupId: string): boolean {
    return this.getSelectedGroupId() === groupId;
  }

  private getSelectedSourceLabel(): string {
    if (this.state.selectedSource === "all") {
      return "すべて";
    }
    if (this.state.selectedSource === "read") {
      return "既読";
    }
    if (this.state.selectedSource === "unread") {
      return "未読";
    }
    if (this.state.selectedSource === "read-later") {
      return "後で読む";
    }

    const feedId = this.getSelectedFeedId();
    if (feedId) {
      return this.state.feeds.find((feed) => feed.id === feedId)?.title ?? "フィード";
    }

    const groupId = this.getSelectedGroupId();
    if (groupId) {
      return this.state.groups.find((group) => group.id === groupId)?.name ?? "グループ";
    }

    return "RSS";
  }

  private getArticleSummary(article: ArticleDto): string {
    const summary = article.snippet?.trim() || stripHtml(article.contentHtml);
    return summary || "本文の要約はまだ取得できていません。";
  }

  private renderHighlightedText(containerEl: HTMLDivElement, value: string): void {
    const keywords = this.plugin.settings.highlightKeywords;
    if (keywords.length === 0) {
      containerEl.setText(value);
      return;
    }

    const pattern = keywords
      .filter((keyword) => keyword.length > 0)
      .map((keyword) => escapeRegExp(keyword))
      .join("|");

    if (!pattern) {
      containerEl.setText(value);
      return;
    }

    const splitRegex = new RegExp(`(${pattern})`, "ig");
    const matchRegex = new RegExp(`^(?:${pattern})$`, "i");
    for (const part of value.split(splitRegex)) {
      if (!part) {
        continue;
      }

      if (matchRegex.test(part)) {
        const markEl = containerEl.createEl("mark");
        markEl.setText(part);
      } else {
        containerEl.appendText(part);
      }
    }
  }

  private toggleGroupCollapse(groupId: string): void {
    if (this.state.collapsedGroupIds.has(groupId)) {
      this.state.collapsedGroupIds.delete(groupId);
    } else {
      this.state.collapsedGroupIds.add(groupId);
    }
    this.render();
  }

  private openFeedMenu(feed: FeedDto, event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("このフィードだけ更新")
        .onClick(() => {
          void this.handleServerRefresh(feed.id);
        })
    );

    if (feed.groupId) {
      menu.addItem((item) =>
        item
          .setTitle("未分類に戻す")
          .onClick(() => {
            void this.assignFeedToGroup(feed.id, undefined);
          })
      );
    }

    for (const group of this.state.groups) {
      if (group.id === feed.groupId) {
        continue;
      }

      menu.addItem((item) =>
        item
          .setTitle(`「${group.name}」へ移動`)
          .onClick(() => {
            void this.assignFeedToGroup(feed.id, group.id);
          })
      );
    }

    menu.addItem((item) =>
      item
        .setTitle("新しいグループを作成して移動")
        .onClick(() => {
          void this.createGroupAndAssignFeed(feed.id);
        })
    );

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("フィード削除")
        .onClick(() => {
          void this.deleteFeed(feed);
        })
    );
    menu.showAtMouseEvent(event);
  }

  private openGroupMenu(group: FeedGroupDto, event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("グループ名を変更")
        .onClick(() => {
          void this.renameGroup(group);
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("グループ削除")
        .onClick(() => {
          void this.deleteGroup(group);
        })
    );
    menu.showAtMouseEvent(event);
  }

  private async handleAddFeed(): Promise<void> {
    const url = window.prompt("追加する RSS フィードの URL");
    if (!url) {
      return;
    }

    try {
      await this.plugin.apiClient.addFeed(url);
      new Notice("フィードを追加しました。");
      await this.refresh();
    } catch (error) {
      new Notice(`フィード追加に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleAddGroup(): Promise<void> {
    const name = window.prompt("作成するグループ名");
    if (!name) {
      return;
    }

    try {
      await this.plugin.apiClient.createGroup(name);
      new Notice("グループを作成しました。");
      await this.refresh();
    } catch (error) {
      new Notice(`グループ作成に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async renameGroup(group: FeedGroupDto): Promise<void> {
    const nextName = window.prompt("新しいグループ名", group.name);
    if (!nextName || nextName === group.name) {
      return;
    }

    try {
      await this.plugin.apiClient.renameGroup(group.id, nextName);
      new Notice("グループ名を更新しました。");
      await this.refresh();
    } catch (error) {
      new Notice(`グループ名の更新に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async deleteGroup(group: FeedGroupDto): Promise<void> {
    if (!window.confirm(`グループ「${group.name}」を削除しますか。所属フィードは未分類に戻ります。`)) {
      return;
    }

    try {
      await this.plugin.apiClient.deleteGroup(group.id);
      if (this.isGroupSelected(group.id)) {
        this.state.selectedSource = "all";
      }
      new Notice("グループを削除しました。");
      await this.refresh();
    } catch (error) {
      new Notice(`グループ削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async createGroupAndAssignFeed(feedId: string): Promise<void> {
    const name = window.prompt("新しいグループ名");
    if (!name) {
      return;
    }

    try {
      const group = await this.plugin.apiClient.createGroup(name);
      await this.plugin.apiClient.assignFeedToGroup(feedId, group.id);
      new Notice("グループを作成してフィードを移動しました。");
      await this.refresh();
    } catch (error) {
      new Notice(`グループ移動に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async assignFeedToGroup(feedId: string, groupId?: string): Promise<void> {
    try {
      await this.plugin.apiClient.assignFeedToGroup(feedId, groupId);
      await this.refresh();
    } catch (error) {
      new Notice(`フィード移動に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async deleteFeed(feed: FeedDto): Promise<void> {
    if (!window.confirm(`フィード「${feed.title}」を削除しますか。`)) {
      return;
    }

    try {
      await this.plugin.apiClient.deleteFeed(feed.id);
      if (this.isFeedSelected(feed.id)) {
        this.state.selectedSource = "all";
      }
      new Notice("フィードを削除しました。");
      await this.refresh();
    } catch (error) {
      new Notice(`フィード削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleServerRefresh(feedId?: string): Promise<void> {
    try {
      this.resetUnreadSession();
      this.state.currentPage = 1;
      this.state.refreshJob = await this.plugin.apiClient.startRefresh(feedId);
      this.startRefreshPolling();
      this.render();
    } catch (error) {
      new Notice(`サーバ更新に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleImportOpml(): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".opml,.xml,text/xml,application/xml";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        return;
      }

      try {
        const content = await file.text();
        const result = await this.plugin.apiClient.importOpml(content);
        new Notice(`OPML取込完了: 追加 ${result.importedCount} / 重複 ${result.duplicateCount} / スキップ ${result.skippedCount}`);
        await this.refresh();
      } catch (error) {
        new Notice(`OPML取込に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    input.click();
  }

  private async handleExportOpml(): Promise<void> {
    try {
      const opml = await this.plugin.apiClient.exportOpml();
      let filePath = "rss_export.opml";
      let counter = 1;
      while (await this.app.vault.adapter.exists(filePath)) {
        filePath = `rss_export_${counter}.opml`;
        counter += 1;
      }
      await this.app.vault.create(filePath, opml);
      new Notice(`OPMLを書き出しました: ${filePath}`);
    } catch (error) {
      new Notice(`OPML書出に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleMarkDisplayedRead(): Promise<void> {
    const targetIds = this.getVisibleArticles()
      .filter((article) => !article.isRead)
      .map((article) => article.id);

    if (targetIds.length === 0) {
      new Notice("既読にする記事がありません。");
      return;
    }

    try {
      await this.applyReadState(targetIds, true);
      new Notice(`${targetIds.length} 件を既読にしました。`);
      this.render();
    } catch (error) {
      new Notice(`一括既読に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleMarkAllUnreadRead(): Promise<void> {
    try {
      const query = this.state.searchQuery.trim() || undefined;
      const result = await this.plugin.apiClient.setReadFiltered({
        isRead: true,
        unreadOnly: true,
        query
      });
      this.resetUnreadSession();
      this.state.currentPage = 1;
      new Notice(`${result.updatedCount} 件の未読を既読にしました。`);
      await this.refresh();
    } catch (error) {
      new Notice(`未読の一括既読に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async moveToPreviousPage(): Promise<void> {
    if (this.state.selectedSource === "unread") {
      this.state.currentPage = Math.max(1, this.state.currentPage - 1);
      this.state.articles = this.unreadSessionPages.get(this.state.currentPage) ?? [];
      this.articleScrollTop = 0;
      this.render();
      return;
    }

    this.state.currentPage = Math.max(1, this.state.currentPage - 1);
    this.articleScrollTop = 0;
    await this.refresh();
  }

  private async moveToNextPage(currentPageArticles: ArticleDto[]): Promise<void> {
    if (this.state.selectedSource === "unread") {
      const nextPage = this.state.currentPage + 1;
      const limit = this.getItemsPerPage();
      const query = this.state.searchQuery.trim() || undefined;
      const sessionKey = this.getUnreadSessionKey(query);
      if (this.unreadSessionKey !== sessionKey) {
        this.unreadSessionKey = sessionKey;
      }

      if (!this.unreadSessionPages.has(nextPage)) {
        const nextPageResult = await this.plugin.apiClient.getArticles({
          unreadOnly: true,
          query,
          offset: (nextPage - 1) * limit,
          limit
        });
        if (nextPageResult.articles.length === 0) {
          return;
        }
        this.unreadSessionPages.set(nextPage, nextPageResult.articles);
        this.unreadSessionTotal = Math.max(this.unreadSessionTotal, nextPageResult.total);
      }

      const unreadIds = currentPageArticles
        .filter((article) => !article.isRead)
        .map((article) => article.id);
      if (unreadIds.length > 0) {
        await this.applyReadState(unreadIds, true);
      }

      this.state.currentPage = nextPage;
      this.state.totalArticles = this.unreadSessionTotal;
      this.state.articles = this.unreadSessionPages.get(nextPage) ?? [];
      this.articleScrollTop = 0;
      this.render();
      return;
    }

    const unreadIds = currentPageArticles
      .filter((article) => !article.isRead)
      .map((article) => article.id);
    if (unreadIds.length > 0) {
      await this.applyReadState(unreadIds, true);
    }

    this.state.currentPage += 1;
    this.state.currentPage = this.normalizePage(this.state.currentPage, this.state.totalArticles);
    this.articleScrollTop = 0;
    await this.refresh();
  }

  private async openArticle(articleId: string): Promise<void> {
    const article = this.state.articles.find((entry) => entry.id === articleId);
    if (!article) {
      return;
    }

    if (!article.isRead) {
      await this.markArticleRead(articleId);
    }

    await openInDefaultBrowser(article.link);
  }

  private async toggleReadLater(articleId: string): Promise<void> {
    const article = this.state.articles.find((entry) => entry.id === articleId);
    if (!article) {
      return;
    }

    try {
      const updated = await this.plugin.apiClient.setReadLater(articleId, !article.isReadLater);
      this.state.articles = this.state.articles.map((entry) => entry.id === articleId ? updated : entry);
      this.render();
    } catch (error) {
      new Notice(`後で読むの更新に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async saveArticleAsNote(articleId: string): Promise<void> {
    const article = this.state.articles.find((entry) => entry.id === articleId);
    if (!article) {
      return;
    }

    try {
      const fullArticle = await this.ensureFullArticle(articleId);
      const feed = this.state.feeds.find((entry) => entry.id === fullArticle.feedId);
      const saved = await this.noteManager.saveArticleAsNote(fullArticle, feed, this.plugin.settings);
      if (saved) {
        this.savedArticleIds.add(articleId);
        this.render();
      }
    } catch (error) {
      new Notice(`Markdown 保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async ensureFullArticle(articleId: string): Promise<ArticleDto> {
    const article = this.state.articles.find((entry) => entry.id === articleId);
    if (article?.contentHtml) {
      return article;
    }

    const fullArticle = await this.plugin.apiClient.getArticle(articleId);
    this.state.articles = this.state.articles.map((entry) => entry.id === articleId ? fullArticle : entry);
    return fullArticle;
  }

  private startRefreshPolling(): void {
    if (this.refreshPollTimer !== null) {
      return;
    }

    this.refreshPollTimer = window.setInterval(async () => {
      try {
        const refreshJob = await this.plugin.apiClient.getRefreshStatus();
        this.state.refreshJob = refreshJob;
        if (refreshJob.status === "completed" || refreshJob.status === "failed") {
          this.stopRefreshPolling();
          await this.refresh();
          if (refreshJob.status === "failed" && refreshJob.errorMessage) {
            new Notice(`サーバ更新に失敗しました: ${refreshJob.errorMessage}`);
          }
        } else {
          this.render();
        }
      } catch (error) {
        this.stopRefreshPolling();
        new Notice(`更新状態の取得に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 2000);
  }

  private stopRefreshPolling(): void {
    if (this.refreshPollTimer !== null) {
      window.clearInterval(this.refreshPollTimer);
      this.refreshPollTimer = null;
    }
  }

  private async markArticleRead(articleId: string): Promise<void> {
    const article = this.state.articles.find((entry) => entry.id === articleId);
    if (!article || article.isRead || this.readInFlightIds.has(articleId)) {
      return;
    }

    this.readInFlightIds.add(articleId);
    try {
      await this.applyReadState([articleId], true);
      this.render();
    } catch (error) {
      new Notice(`既読更新に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.readInFlightIds.delete(articleId);
    }
  }

  private async applyReadState(articleIds: string[], isRead: boolean): Promise<void> {
    if (articleIds.length === 0) {
      return;
    }

    await this.plugin.apiClient.setReadBulk(articleIds, isRead);
    const idSet = new Set(articleIds);
    this.state.articles = this.state.articles
      .map((article) => (idSet.has(article.id) ? { ...article, isRead } : article));

    if (this.state.selectedSource === "unread") {
      const currentPageArticles = this.unreadSessionPages.get(this.state.currentPage);
      if (currentPageArticles) {
        this.unreadSessionPages.set(
          this.state.currentPage,
          currentPageArticles.map((article) => (idSet.has(article.id) ? { ...article, isRead } : article))
        );
      }
      return;
    }
  }
}

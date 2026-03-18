import { Plugin } from "obsidian";
import { NasRssApiClient } from "./apiClient";
import { NasRssSettingsTab } from "./SettingsTab";
import { DEFAULT_SETTINGS, type NasRssPluginSettings } from "./types";
import { NAS_RSS_VIEW_TYPE, NasRssView } from "./views/RssView";

function normalizeSettings(input: Partial<NasRssPluginSettings> | null | undefined): NasRssPluginSettings {
  const merged: NasRssPluginSettings = {
    ...DEFAULT_SETTINGS,
    ...(input ?? {})
  };

  const autoRefreshMinutes = Number(merged.autoRefreshMinutes);
  const itemsPerPage = Number(merged.itemsPerPage);
  const cardMinWidth = Number(merged.cardMinWidth);

  return {
    ...merged,
    autoRefreshMinutes: Number.isFinite(autoRefreshMinutes) && autoRefreshMinutes >= 0
      ? Math.floor(autoRefreshMinutes)
      : DEFAULT_SETTINGS.autoRefreshMinutes,
    itemsPerPage: Number.isFinite(itemsPerPage) && itemsPerPage > 0
      ? Math.floor(itemsPerPage)
      : DEFAULT_SETTINGS.itemsPerPage,
    cardMinWidth: Number.isFinite(cardMinWidth)
      ? Math.min(520, Math.max(220, Math.round(cardMinWidth / 10) * 10))
      : DEFAULT_SETTINGS.cardMinWidth
  };
}

export default class NasRssViewerPlugin extends Plugin {
  settings: NasRssPluginSettings = DEFAULT_SETTINGS;
  apiClient = new NasRssApiClient(() => this.settings.serverBaseUrl);
  private autoRefreshIntervalId: number | null = null;
  private settingsSaveQueue: Promise<void> = Promise.resolve();
  private lastArticleScrollTop = 0;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(
      NAS_RSS_VIEW_TYPE,
      (leaf) => new NasRssView(leaf, this)
    );

    this.addRibbonIcon("rss", "NAS RSS を開く", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-nas-rss-view",
      name: "NAS RSS ビューを開く",
      callback: () => {
        void this.activateView();
      }
    });

    this.addCommand({
      id: "refresh-nas-rss-server",
      name: "NAS RSS サーバを更新する",
      callback: async () => {
        await this.startServerRefresh();
      }
    });

    this.addSettingTab(new NasRssSettingsTab(this.app, this));
    this.resetAutoRefresh();
  }

  onunload(): void {
    if (this.autoRefreshIntervalId !== null) {
      window.clearInterval(this.autoRefreshIntervalId);
      this.autoRefreshIntervalId = null;
    }
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    this.settings = normalizeSettings(loaded);
  }

  async saveSettings(): Promise<void> {
    this.settings = normalizeSettings(this.settings);
    const snapshot = structuredClone(this.settings);
    this.settingsSaveQueue = this.settingsSaveQueue.then(() => this.saveData(snapshot));
    await this.settingsSaveQueue;
  }

  resetAutoRefresh(): void {
    if (this.autoRefreshIntervalId !== null) {
      window.clearInterval(this.autoRefreshIntervalId);
      this.autoRefreshIntervalId = null;
    }

    if (this.settings.autoRefreshMinutes <= 0) {
      return;
    }

    this.autoRefreshIntervalId = window.setInterval(() => {
      void this.refreshOpenViews();
    }, this.settings.autoRefreshMinutes * 60 * 1000);
  }

  async activateView(): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: NAS_RSS_VIEW_TYPE,
      active: true
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async refreshOpenViews(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(NAS_RSS_VIEW_TYPE);
    await Promise.all(
      leaves.map(async (leaf) => {
        if (leaf.view instanceof NasRssView) {
          await leaf.view.refresh();
        }
      })
    );
  }

  async startServerRefresh(feedId?: string): Promise<void> {
    await this.apiClient.startRefresh(feedId);
    await this.refreshOpenViews();
  }

  getLastArticleScrollTop(): number {
    return this.lastArticleScrollTop;
  }

  setLastArticleScrollTop(value: number): void {
    this.lastArticleScrollTop = Math.max(0, value);
  }
}

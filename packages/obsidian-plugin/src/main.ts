import { Plugin } from "obsidian";
import { NasRssApiClient } from "./apiClient";
import { NasRssSettingsTab } from "./SettingsTab";
import { DEFAULT_SETTINGS, type NasRssPluginSettings } from "./types";
import { NAS_RSS_VIEW_TYPE, NasRssView } from "./views/RssView";

export default class NasRssViewerPlugin extends Plugin {
  settings: NasRssPluginSettings = DEFAULT_SETTINGS;
  apiClient = new NasRssApiClient(() => this.settings.serverBaseUrl);
  private autoRefreshIntervalId: number | null = null;
  private settingsSaveQueue: Promise<void> = Promise.resolve();

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
    this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
  }

  async saveSettings(): Promise<void> {
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
}

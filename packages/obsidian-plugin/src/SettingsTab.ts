import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type NasRssViewerPlugin from "./main";

export class NasRssSettingsTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: NasRssViewerPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "NAS RSS Viewer 設定" });

    new Setting(containerEl)
      .setName("サーバ URL")
      .setDesc("NAS 上で動作している RSS サーバの URL を指定します。")
      .addText((text) => {
        text
          .setPlaceholder("http://127.0.0.1:43112")
          .setValue(this.plugin.settings.serverBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverBaseUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Obsidian 側の自動再読込間隔")
      .setDesc("開いている RSS ビューを何分ごとに再読込するかを指定します。0 で無効です。")
      .addText((text) => {
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.autoRefreshMinutes))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.plugin.settings.autoRefreshMinutes = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
            await this.plugin.saveSettings();
            this.plugin.resetAutoRefresh();
          });
      });

    new Setting(containerEl)
      .setName("初期表示を未読のみにする")
      .setDesc("RSS ビューを開いた直後に未読だけを表示します。")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.unreadOnlyDefault)
          .onChange(async (value) => {
            this.plugin.settings.unreadOnlyDefault = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("1ページの記事数")
      .setDesc("カード一覧を何件ずつ表示するかを設定します。次のページへ進むと、直前のページを既読にします。")
      .addText((text) => {
        text
          .setPlaceholder("50")
          .setValue(String(this.plugin.settings.itemsPerPage))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.plugin.settings.itemsPerPage = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 50;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("タイトル強調キーワード")
      .setDesc("1行に1つずつ入力します。記事タイトルに一致した語を強調表示します。")
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.highlightKeywords.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.highlightKeywords = value
              .split("\n")
              .map((keyword) => keyword.trim())
              .filter((keyword) => keyword.length > 0);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 5;
      });

    new Setting(containerEl)
      .setName("保存フォルダ")
      .setDesc("記事を Markdown 保存するフォルダです。")
      .addText((text) => {
        text
          .setPlaceholder("RSS")
          .setValue(this.plugin.settings.saveFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.saveFolderPath = value.trim() || "RSS";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("保存テンプレート")
      .setDesc("{{title}} {{date}} {{link}} {{feed}} {{feed_url}} {{author}} {{saved_date}} {{content}} {{snippet}} が使えます。")
      .addTextArea((text) => {
        text
          .setValue(this.plugin.settings.saveTemplate)
          .onChange(async (value) => {
            this.plugin.settings.saveTemplate = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 10;
      });

    new Setting(containerEl)
      .setName("接続確認")
      .setDesc("現在の設定で RSS サーバに接続できるか確認します。")
      .addButton((button) => {
        button.setButtonText("確認").onClick(async () => {
          try {
            await this.plugin.apiClient.getFeeds();
            new Notice("NAS RSS サーバに接続できました。");
          } catch (error) {
            new Notice(`接続確認に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      });
  }
}

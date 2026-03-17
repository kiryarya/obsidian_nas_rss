import { App, Notice } from "obsidian";
import TurndownService from "turndown";
import type { ArticleDto, FeedDto, NasRssPluginSettings } from "./types";

function sanitizeFileName(name: string): string {
  const safeName = name.replace(/[\\/:*?"<>|]/g, "-").trim();
  return safeName.length > 100 ? safeName.slice(0, 100) : safeName;
}

export class NoteManager {
  private readonly turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced"
  });

  constructor(private readonly app: App) {}

  async saveArticleAsNote(
    article: ArticleDto,
    feed: FeedDto | undefined,
    settings: NasRssPluginSettings
  ): Promise<boolean> {
    try {
      const title = article.title || "Untitled Article";
      const feedTitle = feed?.title || "Unknown Feed";
      const feedUrl = feed?.url || "";
      const author = article.author || "";
      const savedDateStr = new Date().toLocaleString();
      const publishedDateStr = new Date(article.publishedAt).toLocaleString();
      const contentHtml = article.contentHtml || article.snippet || "";
      const markdownBody = this.turndownService.turndown(contentHtml);

      let fileContent = settings.saveTemplate;
      fileContent = fileContent
        .replace(/\{\{\s*title\s*\}\}/gi, title)
        .replace(/\{\{\s*date\s*\}\}/gi, publishedDateStr)
        .replace(/\{\{\s*link\s*\}\}/gi, article.link)
        .replace(/\{\{\s*feed\s*\}\}/gi, feedTitle)
        .replace(/\{\{\s*feed_url\s*\}\}/gi, feedUrl)
        .replace(/\{\{\s*author\s*\}\}/gi, author)
        .replace(/\{\{\s*saved_date\s*\}\}/gi, savedDateStr)
        .replace(/\{\{\s*content\s*\}\}/gi, markdownBody)
        .replace(/\{\{\s*snippet\s*\}\}/gi, article.snippet || "");

      const folderPath = settings.saveFolderPath.replace(/\/$/, "");
      if (!await this.app.vault.adapter.exists(folderPath)) {
        await this.app.vault.createFolder(folderPath);
      }

      const baseName = sanitizeFileName(title);
      let filePath = `${folderPath}/${baseName}.md`;
      if (await this.app.vault.adapter.exists(filePath)) {
        filePath = `${folderPath}/${baseName}_${Date.now()}.md`;
      }

      await this.app.vault.create(filePath, fileContent);
      new Notice(`記事を保存しました: ${title}`);
      return true;
    } catch (error) {
      new Notice(`記事保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}

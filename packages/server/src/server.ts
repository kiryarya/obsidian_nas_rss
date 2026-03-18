import Fastify from "fastify";
import cors from "@fastify/cors";
import { serverConfig } from "./config.js";
import { RefreshJobManager } from "./refresh-job-manager.js";
import { RssService } from "./rss-service.js";
import { StateStore } from "./store.js";

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
  }
  return undefined;
}

function readStringField(body: unknown, fieldName: string): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[fieldName];
  return typeof value === "string" ? value : undefined;
}

const store = new StateStore(serverConfig.dataFilePath);
const rssService = new RssService(
  store,
  serverConfig.refreshIntervalMinutes,
  serverConfig.readRetentionDays
);
const refreshJobManager = new RefreshJobManager();
const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true
});

app.get("/health", async () => ({
  status: "ok",
  time: new Date().toISOString()
}));

app.get("/api/feeds", async () => ({
  feeds: await rssService.listFeeds()
}));

app.get("/api/groups", async () => ({
  groups: await rssService.listGroups()
}));

app.post("/api/groups", async (request, reply) => {
  const name = readStringField(request.body, "name");
  if (!name) {
    reply.status(400);
    return { message: "name を入力してください" };
  }

  try {
    const group = await rssService.createGroup(name);
    reply.status(201);
    return { group };
  } catch (error) {
    request.log.error({ err: error, body: request.body }, "create group failed");
    reply.status(400);
    return { message: error instanceof Error ? error.message : String(error) };
  }
});

app.patch("/api/groups/:groupId", async (request, reply) => {
  const params = request.params as { groupId: string };
  const name = readStringField(request.body, "name");
  if (!name) {
    reply.status(400);
    return { message: "name を入力してください" };
  }

  try {
    return {
      group: await rssService.renameGroup(params.groupId, name)
    };
  } catch (error) {
    request.log.error({ err: error, body: request.body, params }, "rename group failed");
    reply.status(400);
    return { message: error instanceof Error ? error.message : String(error) };
  }
});

app.delete("/api/groups/:groupId", async (request, reply) => {
  const params = request.params as { groupId: string };

  try {
    await rssService.deleteGroup(params.groupId);
    reply.status(204);
    return null;
  } catch (error) {
    request.log.error({ err: error, params }, "delete group failed");
    reply.status(404);
    return { message: error instanceof Error ? error.message : String(error) };
  }
});

app.get("/api/feeds/export-opml", async (_request, reply) => {
  const content = await rssService.exportOpml();
  reply.header("Content-Type", "application/xml; charset=utf-8");
  return content;
});

app.post("/api/feeds", async (request, reply) => {
  const url = readStringField(request.body, "url");
  const title = readStringField(request.body, "title");
  if (!url) {
    reply.status(400);
    return { message: "url を入力してください" };
  }

  try {
    const feed = await rssService.addFeed(url, title);
    reply.status(201);
    return { feed };
  } catch (error) {
    request.log.error({ err: error, body: request.body }, "add feed failed");
    reply.status(400);
    return { message: error instanceof Error ? error.message : String(error) };
  }
});

app.post("/api/feeds/import-opml", async (request, reply) => {
  const content = readStringField(request.body, "content");
  if (!content) {
    reply.status(400);
    return { message: "content に OPML 文字列を指定してください" };
  }

  try {
    return {
      result: await rssService.importOpml(content)
    };
  } catch (error) {
    request.log.error({ err: error }, "import opml failed");
    reply.status(400);
    return { message: error instanceof Error ? error.message : String(error) };
  }
});

app.delete("/api/feeds/:feedId", async (request, reply) => {
  const params = request.params as { feedId: string };
  try {
    await rssService.removeFeed(params.feedId);
    reply.status(204);
    return null;
  } catch (error) {
    request.log.error({ err: error, params }, "delete feed failed");
    reply.status(400);
    return { message: error instanceof Error ? error.message : String(error) };
  }
});

app.post("/api/feeds/:feedId/group", async (request, reply) => {
  const params = request.params as { feedId: string };
  const groupId = readStringField(request.body, "groupId");

  try {
    return {
      feed: await rssService.assignFeedToGroup(params.feedId, groupId)
    };
  } catch (error) {
    request.log.error({ err: error, body: request.body, params }, "assign feed group failed");
    reply.status(400);
    return { message: error instanceof Error ? error.message : String(error) };
  }
});

app.get("/api/feeds/refresh-status", async () => ({
  job: refreshJobManager.getCurrentJob()
}));

app.post("/api/feeds/refresh", async (request) => {
  const feedId = readStringField(request.body, "feedId");
  const job = refreshJobManager.startJob(feedId);

  void rssService.refreshFeeds(feedId)
    .then(() => {
      refreshJobManager.completeJob();
    })
    .catch((error) => {
      refreshJobManager.failJob(error instanceof Error ? error.message : String(error));
    });

  return { job };
});

app.get("/api/articles", async (request, reply) => {
  const query = request.query as Record<string, string | undefined>;
  const limit = query.limit ? Number(query.limit) : undefined;
  const offset = query.offset ? Number(query.offset) : undefined;

  if (query.limit && !Number.isFinite(limit)) {
    reply.status(400);
    return { message: "limit は数値で指定してください" };
  }

  if (query.offset && !Number.isFinite(offset)) {
    reply.status(400);
    return { message: "offset は数値で指定してください" };
  }

  const result = await rssService.listArticles({
    feedId: query.feedId,
    groupId: query.groupId,
    readOnly: parseBoolean(query.readOnly),
    unreadOnly: parseBoolean(query.unreadOnly),
    readLaterOnly: parseBoolean(query.readLaterOnly),
    query: query.query,
    offset,
    limit
  });

  return {
    articles: result.articles,
    total: result.total
  };
});

app.get("/api/articles/:articleId", async (request, reply) => {
  const params = request.params as { articleId: string };
  const article = await rssService.getArticle(params.articleId);

  if (!article) {
    reply.status(404);
    return { message: "記事が見つかりません" };
  }

  return { article };
});

app.post("/api/articles/:articleId/read", async (request, reply) => {
  const params = request.params as { articleId: string };
  const body = request.body as { isRead?: boolean } | undefined;

  if (typeof body?.isRead !== "boolean") {
    reply.status(400);
    return { message: "isRead は boolean で指定してください" };
  }

  try {
    return {
      article: await rssService.markArticleRead(params.articleId, body.isRead)
    };
  } catch (error) {
    request.log.error({ err: error, body, params }, "mark article read failed");
    reply.status(404);
    return { message: error instanceof Error ? error.message : String(error) };
  }
});

app.post("/api/articles/:articleId/read-later", async (request, reply) => {
  const params = request.params as { articleId: string };
  const body = request.body as { isReadLater?: boolean } | undefined;

  if (typeof body?.isReadLater !== "boolean") {
    reply.status(400);
    return { message: "isReadLater は boolean で指定してください" };
  }

  try {
    return {
      article: await rssService.markArticleReadLater(params.articleId, body.isReadLater)
    };
  } catch (error) {
    request.log.error({ err: error, body, params }, "mark article read later failed");
    reply.status(404);
    return { message: error instanceof Error ? error.message : String(error) };
  }
});

app.post("/api/articles/read-bulk", async (request, reply) => {
  const body = request.body as { articleIds?: string[]; isRead?: boolean } | undefined;

  if (!Array.isArray(body?.articleIds) || typeof body.isRead !== "boolean") {
    reply.status(400);
    return { message: "articleIds と isRead を正しく指定してください" };
  }

  return {
    result: await rssService.markArticlesRead(body.articleIds, body.isRead)
  };
});

app.post("/api/articles/read-filtered", async (request, reply) => {
  const body = (request.body ?? {}) as {
    isRead?: boolean;
    feedId?: string;
    groupId?: string;
    readOnly?: boolean;
    unreadOnly?: boolean;
    readLaterOnly?: boolean;
    query?: string;
  };

  if (typeof body.isRead !== "boolean") {
    reply.status(400);
    return { message: "isRead を指定してください" };
  }

  return {
    result: await rssService.markFilteredArticlesRead({
      feedId: body.feedId,
      groupId: body.groupId,
      readOnly: body.readOnly,
      unreadOnly: body.unreadOnly,
      readLaterOnly: body.readLaterOnly,
      query: body.query
    }, body.isRead)
  };
});

const stopAutoRefresh = rssService.createAutoRefreshTask();

const closeApp = async (): Promise<void> => {
  stopAutoRefresh();
  await app.close();
};

process.on("SIGINT", () => {
  void closeApp();
});

process.on("SIGTERM", () => {
  void closeApp();
});

await app.listen({
  host: serverConfig.host,
  port: serverConfig.port
});

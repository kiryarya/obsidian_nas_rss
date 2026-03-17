# アーキテクチャ概要

## 背景

従来の Obsidian プラグインが vault 内に RSS 記事データや既読状態を保存すると、Git 管理対象に差分が乗りやすくなり、複数端末運用ではコンフリクトの温床になります。

このプロジェクトでは、RSS の実データと状態管理を NAS 上のサーバに集約し、Obsidian は API クライアントとして動作します。

## 役割分担

### 1. NAS 上の RSS サーバ

- RSS フィードを定期取得する
- 記事メタデータを保持する
- 既読、あとで読む状態を保持する
- Obsidian クライアント向けの JSON API を提供する

### 2. Obsidian プラグイン

- サーバ接続設定を保持する
- 記事一覧を取得して表示する
- 既読、あとで読むの操作をサーバに反映する
- 必要に応じて元記事をブラウザで開く

## API の最小構成

- `GET /health`
- `GET /api/feeds`
- `POST /api/feeds`
- `DELETE /api/feeds/:feedId`
- `POST /api/feeds/refresh`
- `GET /api/articles`
- `GET /api/articles/:articleId`
- `POST /api/articles/:articleId/read`
- `POST /api/articles/:articleId/read-later`

## 保存戦略

- サーバ: `packages/server/data/rss-state.json`
- Obsidian: 接続設定のみ
- vault: ユーザーが明示的に保存したノートのみ

## この実装で意図的に避けているもの

- クライアントから NAS 共有フォルダへの直接書き込み
- vault 内への記事キャッシュ保存
- 複数クライアントが同じ JSON を直接編集する構成

## 今後の拡張ポイント

- JSON ストアから SQLite への移行
- API キー認証
- 記事全文抽出とキャッシュ
- OPML のインポート、エクスポート
- ユーザー単位の状態分離

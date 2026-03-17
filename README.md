# Obsidian RSS NAS Platform

Obsidian vault に記事キャッシュを保存せず、NAS 上の RSS サーバに状態を集約するための新規プロジェクトです。

## 目的

- Git 管理下の vault から RSS 記事本文と既読状態を切り離す
- NAS 上の単一サーバに RSS 状態を集約し、複数端末から同じ状態を参照する
- Obsidian 側はビューアー兼クライアントとして動作させる

## 構成

- `packages/server`
  - RSS の取得、記事状態の保持、HTTP API の提供
- `packages/obsidian-plugin`
  - Obsidian からサーバ API を呼び出して一覧表示と状態更新を行う
- `docs/architecture.md`
  - 設計と今後の拡張ポイント
- `docs/qnap_deployment_guide.md`
  - QNAP NAS でサーバを動かし始める手順
- `docs/obsidian_plugin_user_guide.md`
  - Obsidian プラグインの導入と使い方

## 現在の実装範囲

- フィード追加、削除、手動更新
- 記事一覧取得
- 既読、未読、あとで読むの切り替え
- サーバ側 JSON ストアへの状態集約
- Obsidian の専用ビューからの閲覧

## 注意点

- 現在のサーバ永続化は JSON ファイルです
- NAS 上では「共有フォルダを複数クライアントが直接書く」のではなく、「サーバプロセス 1 つが書く」前提です
- 記事全文抽出や認証は今後の拡張対象です

## セットアップ

```powershell
pnpm.cmd install
pnpm.cmd --filter @obsidian-rss-nas/server dev
pnpm.cmd --filter @obsidian-rss-nas/obsidian-plugin build
```

サーバは既定で `http://127.0.0.1:43112` で起動します。NAS 配置時は `HOST=0.0.0.0` に変更してください。

## Docker での NAS 配置

```powershell
docker compose up -d --build
```

- 永続データは `rss-server-data` ボリュームに保存されます
- 必要なら `docker-compose.yml` のポートを NAS 環境に合わせて変更してください
- Obsidian プラグイン側の接続先は NAS の IP またはホスト名を指定します

## 次の候補

- サーバ保存層を SQLite に差し替える
- API キー認証を追加する
- 記事全文抽出をサーバ側に移す
- Docker 配置ファイルを追加する

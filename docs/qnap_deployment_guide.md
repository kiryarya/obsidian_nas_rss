# QNAP NAS 導入ガイド

## 目的

このガイドは、QNAP NAS 上で RSS サーバを起動し、Obsidian プラグインから接続できる状態にするまでの手順をまとめたものです。

このプロジェクトでは、RSS の記事データと既読状態を NAS 側サーバに集約します。Obsidian vault には記事キャッシュを持たせないため、Git コンフリクトを減らせます。

## 事前に確認すること

- QNAP NAS で Container Station が利用できること
- QTS または QuTS hero に管理者でログインできること
- NAS に SSH 接続できること
- 同一ネットワーク内から NAS の IP アドレスまたはホスト名でアクセスできること

補足:

- QNAP の公式 FAQ では、Container Station が App Center で利用できない場合は NAS モデルやファームウェア互換性の問題である可能性があります
- QNAP の公式 FAQ では、QTS 5.1 以降かつ Container Station 3.0 以降では `docker-compose` ではなく `docker compose` を使う案内になっています

## 導入の全体像

1. QNAP の App Center で Container Station を導入する
2. NAS にこのプロジェクトを配置する
3. SSH で NAS に入り、`docker compose up -d --build` を実行する
4. ブラウザで `/health` を確認する
5. Obsidian プラグインから NAS の URL を設定する

## 1. Container Station を導入する

### App Center から導入する

1. QNAP に管理者でログインします
2. `App Center` を開きます
3. `Container Station` を検索します
4. `Install` を実行します
5. インストール完了後、Container Station を一度起動します

注意:

- 画面上の名称は QTS の版によって多少異なります
- Container Station が見つからない場合は、QNAP 公式の互換性 FAQ を先に確認してください

## 2. SSH を有効化する

1. `Control Panel`
2. `Network & File Services`
3. `Telnet / SSH`
4. `Allow SSH connection` を有効化
5. `Apply`

推奨:

- SSH ポートを変更している場合は、その番号を控えてください
- 公開ネットワークにそのまま開けず、LAN 内または VPN 経由で使う構成を推奨します

## 3. NAS にプロジェクトを配置する

### 推奨方法

Windows 側でこのプロジェクトを zip 化せず、そのまま NAS の共有フォルダへコピーします。

例:

- NAS 共有フォルダ: `/share/Container/obsidian-rss-nas-platform`

配置後に確認したい主要ファイル:

- `docker-compose.yml`
- `packages/server/Dockerfile`
- `packages/server/package.json`

## 4. NAS 上でサーバを起動する

### SSH で接続する

Windows PowerShell 例:

```powershell
ssh admin@<QNAPのIPアドレス>
```

### プロジェクトフォルダへ移動する

パスは環境に合わせて読み替えてください。

```bash
cd /share/Container/obsidian-rss-nas-platform
```

### 起動する

```bash
docker compose up -d --build
```

補足:

- QNAP の新しい Container Station は Compose V2 前提です
- `docker-compose` ではなく `docker compose` を使ってください
- 初回起動時はイメージの取得とビルドで時間がかかります

## 5. 起動確認をする

NAS または同一ネットワーク内の PC で次を確認します。

ブラウザ:

```text
http://<QNAPのIPアドレス>:43112/health
```

期待される応答例:

```json
{"status":"ok","time":"2026-03-17T01:50:43.689Z"}
```

表示できない場合の確認点:

- Container Station でコンテナが起動しているか
- `43112` ポートが他サービスと競合していないか
- NAS ファイアウォール設定で遮断していないか
- `docker compose logs` にエラーが出ていないか

### ログ確認

```bash
docker compose logs -f
```

### 停止

```bash
docker compose down
```

### 再起動

```bash
docker compose up -d
```

## 6. 永続データの保存先

このプロジェクトの `docker-compose.yml` では、記事データは Docker ボリューム `rss-server-data` に保存されます。

重要:

- コンテナを作り直しても、ボリュームを消さない限りデータは残ります
- 完全初期化したい場合だけボリューム削除を行ってください

## 7. 更新手順

### プロジェクトの内容を更新した場合

1. NAS 上のプロジェクトファイルを新しい内容に置き換える
2. 既存フォルダで次を実行する

```bash
docker compose up -d --build
```

### データは維持したままアプリだけ更新したい場合

上の手順で問題ありません。ボリュームを削除しなければ状態は維持されます。

## 8. QNAP でよくある注意点

### 1. コンテナは動いているが外から開けない

主な原因:

- NAS ファイアウォール
- ルーター側の制限
- `HOST=0.0.0.0` になっていない
- ポート競合

このプロジェクトの `docker-compose.yml` では `HOST=0.0.0.0` を設定済みです。

### 2. Container Station はあるが `docker compose` が動かない

考えられる原因:

- Container Station の初期化が未完了
- QTS / Container Station の版が古い
- SSH セッションの PATH 問題

まずは NAS を再起動せずに、Container Station を一度停止して再起動し、その後 SSH を張り直してください。

### 3. App Center に Container Station が出ない

QNAP 公式 FAQ では、モデルやファームウェア互換性の可能性が案内されています。これに該当する場合はこの構成は採用しづらいです。

### 4. Docker ビルド中に npm registry 関連でタイムアウトする

症状例:

- `corepack` や `pnpm` の取得で止まる
- `Headers Timeout Error`
- `https://registry.npmjs.org` へのアクセスで失敗する

確認順:

1. 少し時間を空けて `docker compose up -d --build` を再実行する
2. NAS の DNS 設定とインターネット接続を確認する
3. Container Station 側のプロキシ設定が必要な環境か確認する
4. プロジェクト側の Dockerfile を最新化して再配置する

このプロジェクトでは、初期版の Dockerfile で `corepack` を利用していましたが、QNAP 環境ではここが不安定になることがあります。最新版では `corepack` を使わない形に変更しています。

また、ホスト側の `node_modules` が Docker build context に入ると、`COPY packages/server packages/server` の段階で衝突することがあります。最新版ではルート `.dockerignore` を追加し、ビルド時は `src` と `tsconfig.json` だけをコピーする構成に変更しています。

## 9. セキュリティ上の推奨

- 最初は LAN 内だけで運用する
- 外部公開するなら VPN を優先する
- リバースプロキシを使う場合でも、先に LAN 内で安定動作を確認する
- 将来的に API キー認証を追加する

## 10. 次にやること

QNAP 側のサーバが起動できたら、次は Obsidian プラグインをビルドして vault に配置します。手順は [obsidian_plugin_user_guide.md](./obsidian_plugin_user_guide.md) を参照してください。

## 参考情報

- QNAP: Installing an app from App Center  
  https://docs.qnap.com/operating-system/qts/5.2.x/en-us/installing-an-app-from-app-center-E04E2943.html
- QNAP: Container Station Quick Start Guide  
  https://www.qnap.com/en-us/how-to/tutorial/article/container-station-quick-start-guide
- QNAP: Why can't I use docker-compose commands in Container Station?  
  https://www.qnap.com/en-uk/how-to/faq/article/why-cant-i-use-docker-compose-commands-in-container-station
- QNAP: I am not able to find Container Station for My NAS  
  https://www.qnap.com/en/how-to/faq/article/i-am-not-able-to-find-container-station-for-my-nas

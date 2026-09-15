# 急上昇動画ウォッチャー

YouTube の急上昇ランキングを自動で集めて、**いろいろな切り口のランキング**に並べ直す静的サイトです。

- カテゴリはタブ切り替え（総合・音楽・ゲーム・エンタメ・スポーツ・ニュースなど 15 種）
- ランキングの種類を切り替えられる：**急上昇順 / いま伸びてる順 / 同時視聴者数順 / 再生数順 / 高評価率順 / コメント数順 / 新着順**
- **ライブ配信中**のタブと、同時視聴者数つきの「いま配信中」モジュール
- 順位の隣に **前回からの変動（▲▼・NEW）** を表示
- サムネイル・再生時間・ショート判定つきの一覧
- 「ランクインの多いチャンネル」ランキングも併載
- 収集も公開も GitHub Actions で自動実行（1 日 4 回）

## 必要な準備：YouTube Data API のキー

データは **YouTube Data API v3** から取得します。無料のキーが必要です（審査なし）。

1. https://console.cloud.google.com/ でプロジェクトを作る
2. 「APIとサービス」→「ライブラリ」で **YouTube Data API v3** を有効化する
3. 「認証情報」→「認証情報を作成」→ **APIキー** を発行する
4. ローカルで実行するときは環境変数に入れる

```powershell
$env:YOUTUBE_API_KEY = "発行したAPIキー"
npm run collect
```

GitHub Actions で動かすときは、リポジトリの Secrets に `YOUTUBE_API_KEY` を登録します。

**無料枠は 1 日 10,000 ユニット**です。1 回の収集の内訳は次のとおりです。

| 呼び出し | 回数 | 単価 | 小計 |
| --- | --- | --- | --- |
| `videos.list`（カテゴリ別の急上昇） | 15 | 1 | 15 |
| `search.list`（配信中のライブ探し） | 1 | **100** | 100 |
| `videos.list`（ライブの数値取り直し） | 1 | 1 | 1 |
| `channels.list`（登録者数・アイコン） | 3〜5 | 1 | 5 |
| | | | **約 120** |

1 時間に 1 回（1 日 24 回）で約 2,880 ユニット。枠の 3 割ほどなのでまだ余裕があります。

ただし **`search.list` だけは 1 回 100 ユニット**と高いので、
`config.json` の `live.queries` / `live.categoryIds` を増やすとそのぶん一気に消費します
（1 要素につき +100 ユニット / 回）。増やすときは 1 日の合計を計算してからにしてください。
ライブ収集自体を止めるなら `live.enabled` を `false` にします。

> キーがなくても `npm run sample` でサンプルデータを作れば、画面の確認だけはできます。
> その場合はページ上部に「これはサンプルデータです」と表示されます。

## 使い方

```bash
npm install          # esbuild / sharp（ビルド用のみ）
npm run sample       # サンプルデータを作る（APIキー不要・画面確認用）
npm run collect      # 実データを収集して docs/data/rankings.json を更新
npm run build        # site/ を最小化して docs/ に出力
npm start            # ビルドしてローカルサーバー（http://localhost:3240）
```

## 構成

| パス | 役割 |
| --- | --- |
| `config.json` | カテゴリ（タブ）とランキングの種類、収集件数などの設定 |
| `scripts/collect.mjs` | 収集 → 伸び・順位変動の計算 → `docs/data/rankings.json` 出力 |
| `scripts/lib/youtube.mjs` | YouTube Data API（videos.list / channels.list）の呼び出し |
| `scripts/sample.mjs` | APIキーなしで画面を確認するためのサンプルデータ生成 |
| `data/history.json` | 前回の再生数・順位。**次回の「伸び」計算に使うのでコミットする** |
| `site/` | 編集するソース。`docs/` は生成物なので直接触らない |
| `docs/` | 公開ディレクトリ（FTP でアップロードされる） |

## ランキングのしくみ

1. カテゴリごとに `videos.list?chart=mostPopular&regionCode=JP` で急上昇を取得する
   （複数カテゴリに出る動画はまとめ、良いほうの順位を残す）
2. `data/history.json` の前回値と比べて
   - **いま伸びてる順** … 1 時間あたりの再生数の増加
   - **▲▼の順位変動** … 前回の順位との差
   を計算する（初めて見る動画は NEW 扱い。伸びは公開からの平均で代用）
3. `search.list?eventType=live` で配信中のライブを探し、`videos.list` で同時視聴者数を取り直して
   「ライブ配信中」タブに載せる（急上昇にも出ているライブは両方に出る）
4. `channels.list` で登録者数とチャンネルアイコンを足す
5. チャンネル別のランクイン本数を数えてチャンネルランキングを作る
6. すべてを `docs/data/rankings.json` に書き出し、フロントはこの 1 ファイルだけを読む

**「いま伸びてる順」は 2 回目の収集から本領を発揮します**（前回値がないと差分が出せないため）。
初回はすべて NEW 扱いになります。

調整したいところ:

- `categories` … タブに出すカテゴリ（`youtubeCategoryId` は YouTube のカテゴリ ID）
- `rankings` … ランキングの種類と説明文
- `maxResults` … 1 カテゴリあたりの取得件数（最大 50）
- `likeRateMinViews` … 高評価率ランキングの対象にする最低再生数（既定 10,000）
- `historyDays` … 履歴を残す日数（既定 14 日）
- `live.enabled` / `live.queries` / `live.categoryIds` … ライブ配信の収集（クォータ注意、上記参照）

## 公開の設定（ロリポップ）

リポジトリの Settings → Secrets and variables → Actions で登録します。
APIキーと FTP の認証情報はご本人で入力してください。

**Secrets**

| 名前 | 内容 |
| --- | --- |
| `YOUTUBE_API_KEY` | YouTube Data API v3 のキー |
| `LOLIPOP_FTP_SERVER` | FTP サーバー名 |
| `LOLIPOP_FTP_USER` | FTP アカウント |
| `LOLIPOP_FTP_PASSWORD` | FTP パスワード |

**Variables**

| 名前 | 内容 |
| --- | --- |
| `DEPLOY_TARGET` | `lolipop`（この値のときだけアップロードする） |
| `LOLIPOP_SERVER_DIR` | サブドメインの公開ディレクトリ（例: `./trend.gamelab.website/`。末尾のスラッシュ必須） |

サブドメインを決めたら `config.json` の `site.url` と `site/index.html` の OGP も更新してください。

## 表示している内容について

タイトル・サムネイル・公開されている数値（再生数・高評価数・コメント数・登録者数）と、
YouTube へのリンクのみを表示しています。動画のダウンロードや再配布はしていません。
サムネイルは YouTube の画像 URL をそのまま参照しています。

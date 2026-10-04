# DAILY DROP

VALORANTの今日の個人ショップを表示するWindowsデスクトップアプリです。独自のWebサーバーやクラウドアカウントは不要で、このPCとインターネット接続だけで動作します。

## ダウンロードして使う

1. [最新リリース](https://github.com/Cookie12734/valorant-daily-drop/releases/latest)から `DailyDrop-1.3.1-win-x64.zip` をダウンロードします。
2. ZIPをすべて展開し、フォルダー内の **DailyDrop.exe** を起動します。EXEだけを移動せず、同梱ファイルと一緒に置いてください。
3. 初回は **Riotでログイン** を押し、アプリのRiot認証ウィンドウでログインします。二段階認証やCAPTCHAもその画面で完了します。「ログイン状態を保持する」を有効にしてください。
4. 認証後はショップを自動表示します。次回起動時も保存済みのセッションが有効なら、自動で今日のショップを取得します。

Windows x64向けです。Node.jsのインストール、ターミナル操作、ゲームの起動、Developer PortalのAPIキーは必要ありません。終了するときはショップ画面を閉じます。ログアウトは保存済みの認証Cookieも削除します。Riot側のセッションが失効した場合は再ログインが必要です。

配布版は独自のコード署名を付けていません。Windowsによって発行元の確認が表示される場合があります。更新はリリースから新しいZIPを取得して行います。自動更新はありません。

## コンパクト表示

デスクトップ版は420×460pxの小さなショップ画面で起動します。商品は2列で表示し、画像・名前・価格を確認できます。ウィンドウはドラッグで移動、端をドラッグでサイズ変更できます。既定では常に手前に表示し、画面内の右クリックメニューで解除できます。ログインが必要なときだけ従来のRiot認証ウィンドウを開きます。「ショップ／ナイトマーケット」で表示を切り替えられます。ナイトマーケットは割引後価格・通常価格・割引率を表示し、未開催時には案内を表示します。Web版にも同じ切り替えがあります。公開サイト単体ではRiot認証は行えません。

## 接続先と保存する情報

- Riotの認証・アカウント・ショップAPIへ、このPCから直接接続します。
- [Valorant-API](https://valorant-api.com/)からスキンの名前・画像とクライアントバージョンを取得します。フォントはGoogle Fontsから読み込みます。これらへRiotトークンを送信しません。
- 独自サーバー、公開サイトへのログイン情報送信、利用状況の収集はありません。
- パスワードは分離されたRiotページへ直接入力し、アプリは読み取り・保存しません。Google・Appleなど外部サービス経由の認証は対象外です。
- 再起動後のログイン復元用Cookieは `%APPDATA%\DailyDrop` に保存します。Riotの有効期限は変更しません。ショップ取得用アクセストークンはメモリー内だけで扱います。
- アプリ内の画面にはスキンID・価格・取得／更新時刻・リージョンを返し、トークンを渡しません。

内部では、このPCからだけアクセスできる `127.0.0.1` の空きポートで同梱画面を配信します。利用者がサーバーを用意する必要はなく、アプリ終了時に停止します。認証・ログアウト・ショップ取得は同一オリジンのJSON POSTに限定しています。ネットワークへの公開や多人数共有は想定していません。

## 非公式方式の制約

Riotの[公式VALORANT API](https://developer.riotgames.com/docs/valorant)には個人ショップ取得用の公開エンドポイントがありません。[非公式認証の調査資料](https://valapidocs.techchrism.me/endpoint/auth-request)に基づくクライアントであり、承認済みRSO連携ではありません。Riot側の仕様変更や認証制限により利用できなくなる場合があります。

2026年10月4日、従来版で実アカウントのログインからv3 Storefront APIによるショップ表示まで利用者による確認が完了しています。デスクトップ版の実アカウントによる再起動後の自動表示は、別途実機確認が必要です。保存Cookieのプロセス間の引き継ぎ・削除はテスト用Cookieで検証済みです。

## ソースから起動・配布する

開発時のみNode.js 22.12以降が必要です。

```powershell
git clone https://github.com/Cookie12734/valorant-daily-drop.git
cd valorant-daily-drop
npm ci
npm start
npm test
node node_modules/electron/cli.js scripts/desktop-smoke.mjs
npm run package:win
```

Windows上で `npm run package:win` を実行すると、`releases/` に実行可能なフォルダー、ZIP、SHA-256ファイルを作ります。インストール済みElectronを同梱し、配布先でnpmを実行する必要はありません。認証情報・exports・開発用ファイルは同梱しません。

`dist/` は同梱画面、`scripts/desktop.mjs` はデスクトップウィンドウ、`scripts/riot-login.mjs` は認証・ショップ取得、`scripts/local-server.mjs` はアプリ内のローカル配信です。Electron以外はNode.js標準機能を使用します。

従来の起動中Riot Client経由の取得は `npm run start:client`、JSON書き出しは `npm run shop` で利用できます。静的ホスティング版はプレビュー・ダウンロード案内・ファイル表示のみ提供します。

VALORANTおよびスキン画像の権利はRiot Gamesに帰属します。本プロジェクトはRiot Gamesと提携していません。

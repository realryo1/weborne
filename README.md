# weborne（ウェボルネ）

地デジチューナー（CECH-ZD1J）を、Chromeでページを開いてUSBでつなぐだけで見られるようにするウェブアプリです。
アプリのインストールは不要で、WebUSBでチューナーを直接動かします。AndroidとWindowsのChromeで動作を確認しています。

**サイト：[https://realryo1.github.io/weborne/](https://realryo1.github.io/weborne/)**

## 使い方

1. **Chrome**で[https://realryo1.github.io/weborne/](https://realryo1.github.io/weborne/)を開きます（初回だけ自動で1回再読み込みされます）。
2. Windowsの場合は、最初の1回だけドライバの割り当てが必要です（下の「注意」を参照）。
3. CECH-ZD1JをUSBでつなぎ、「接続」を押してCECH-ZD1Jを選びます。(AndroidはCECH-ZD1Jを押さないと接続ボタンが押せない)
4. 勝手にチャンネルスキャンが始まります（UHF 13〜62ch、約2分）。見つかった局から順にボタンになります。途中で中断しても再開可能です。
5. ボタンを押すと再生します。全画面ボタン（⛶）で横向き全画面になります。

画質は3段階です。端末の性能に合わせて選んでください。多分大体の端末で1080p行けると思う。

| 画質 | 内容 | 重さの目安（PCの1コア） |
|---|---|---|
| 標準（軽量・540p） | MPEG-2を半分の解像度でデコード（lowres）。既定 | 約170〜200 fps分の余裕 |
| 高画質（1080） | 1440×1080をそのままデコード | 約85 fps分の余裕 |
| ワンセグ | 同じ放送のワンセグ（H.264 320×180） | ごく軽い |

### 対応環境

- チューナー：CECH-ZD1Jのみ。B-CASカードはチューナー本体のカードスロットに挿したものを使います。
- ブラウザ：WebUSBに対応したChromium系（Android / Windows / macOS / Linux / ChromeOSのChrome、Edge）。**iPhone・iPad、Firefox、Safariは不可**。

### 注意

- **Windowsは自動でドライバを割り当てない**ので、最初の1回だけWinUSBの割り当てが必要です。接続に失敗するとサイトに案内が出、[web/driver/weborne-winusb.bat](web/driver/weborne-winusb.bat)（coaxの`install-winusb.bat`に専用のinfを埋め込んだもの）をダウンロードして実行できます。署名用の証明書を作ってPCに追加し、秘密鍵は署名後に削除します。
- 同じチューナーを同時に使えるのは1つのアプリだけです。PCではTVTestや`coaxd.exe`を終了してから使ってください。
- チューナーはUSBから給電されます。スマホ側の給電が足りず不安定なときは、セルフパワーのUSBハブを挟んでください。
- 「チューナーに前回の状態が残っています」と出たら、チューナーを一度抜いて挿し直してください。
- 私的な視聴の範囲で使ってください。

## しくみ

```
CECH-ZD1J
   │ USB（WebUSB）
usb.js              WebUSBの転送。ストリーム用に常に複数の受信を出しておく
   │
weborne.wasm（Go）coaxのMB86H47A／DiB8096ドライバをそのままWASM化したもの
   ├─ 選局・信号測定
   ├─ 内蔵カードスロット（B-CAS）→ ECMから鍵を取得 → MULTI2でスクランブル解除
   └─ 1サービスだけ取り出し、PAT/PMTを書き換えて出力
   │ TS
player.js ──(SharedArrayBufferのリング)──▶ decoder-worker.js（ffmpeg.wasm）
   │                                          MPEG-2/H.264 + AACをデコード
   │◀──── 生のYUVとPCM（Matroskaに入れてタイムスタンプ付きで受け取る）
   ├─ WebGLで表示（YUV→RGB、インターレース解除はシェーダーで）
   └─ Web Audioで再生（音声を時計にして映像を合わせる）
```

- チューナーの制御は[coax](https://github.com/Till0196/coax)のコードを**そのまま**使っています。`go/`はcoaxのソース（2026-11-02時点のmain）から使う部分だけを取り出し、`cmd/weborne-wasm`、`cmd/weborne-file`、`internal/weborne`を足したものです（[go/README.md](go/README.md)）。
- MPEG-2はブラウザが再生できないので、ffmpeg.wasm（[@ffmpeg/core](https://www.npmjs.com/package/@ffmpeg/core)）でデコードしています。

## 配信のしかた

公開中のサイトをそのまま使えば、配信の準備はいりません。自分で配信する場合は、ビルド（下記）したあとの`web/`を静的サイトとして置くだけです（サーバー側の処理はありません）。WebUSBはHTTPS（またはlocalhost）でしか動きません。

- **GitHub Pages**：`main`にpushすると[.github/workflows/deploy.yml](.github/workflows/deploy.yml)がビルドして配信します。forkして使う場合は、最初に一度だけリポジトリのSettings → Pages → Sourceを「GitHub Actions」にしてください。ヘッダー（COOP/COEP）は`web/coi-sw.js`（Service Worker）が付けます。
- **ローカル**：`node serve.js`で`http://localhost:8080/`に立ちます（必要なヘッダー付き）。PCのChromeならそのまま使えます。
- **Tailscale**：`node serve.js`を起動したまま`tailscale serve --bg 8080`を実行すると、tailnet内の端末だけに`https://<PC名>.<tailnet>.ts.net/`で公開されます。外出先のスマホからも使えます。止めるときは`tailscale serve --https=443 off`。
- **adb経由**：`start.bat`がサーバーを起動し、`adb reverse tcp:8080 tcp:8080`でスマホの`localhost:8080`をPCに転送します。スマホのUSB端子はチューナーに使うので、adbは**ワイヤレス デバッグ**でつなぎます（Android 11以降）。
- **ほかの静的ホスティング**：GitHub Pagesと同じく`web/`を置くだけです。ffmpeg-core.wasmが約32MBあるので、1ファイル25MiBまでのCloudflare Pagesには分割などの対応が必要です。

## ビルド

```powershell
npm install
powershell -ExecutionPolicy Bypass -File build.ps1
```

- Go 1.26以上が必要です（PATHに無ければ`.work/go`に置いたポータブル版を使います）。
- `go/`を`GOOS=js GOARCH=wasm`でビルドして`web/weborne.wasm`を作り、`wasm_exec.js`とffmpeg.wasm（npmの`@ffmpeg/core`）を`web/`にコピーします。これらの生成物はリポジトリには含めていません。

### 検証用スクリプト（`tools/`）

| スクリプト | 内容 |
|---|---|
| `hw-test.mjs` | ブラウザなしで`weborne.wasm`と`usb.js`をNodeから実機に対して動かし、受信したTSを保存する |
| `e2e-hw.mjs` | ヘッドレスChromeでアプリを動かし、USB転送だけNode経由で実機に中継する通しテスト（`node serve.js`を起動しておく） |
| `test-worker.mjs` | 録画したTSをNode上のffmpeg.wasmに通して、デコード速度と出力を確認する |
| `test-mkv.mjs` | Matroskaの読み取りを確認する |

## ライセンス

- weborneのために書いたコード（`web/`、`go/cmd/weborne-*`、`go/internal/weborne`、`tools/`など）は[GPL-2.0](COPYING)です。
- `go/`のcoax由来のコードはcoaxのライセンス（`Apache-2.0 OR GPL-2.0-or-later`、一部`GPL-2.0-only`）のままです（[go/NOTICE](go/NOTICE)、[go/COPYING](go/COPYING)、[go/LICENSE-APACHE](go/LICENSE-APACHE)）。DiB8096のドライバに`GPL-2.0-only`のファイルが含まれるので、`weborne.wasm`は全体としてGPL-2.0-onlyです。
- `web/driver/weborne-winusb.bat`はcoaxの`install-winusb.bat`（Apache-2.0）をもとにしています。
- ffmpeg.wasm（`@ffmpeg/core`）はGPL-2.0-or-laterです。
- サイトを他の人に公開する場合は、GPLに従ってソースコードも入手できるようにしてください。

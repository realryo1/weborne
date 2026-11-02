# weborne（ウェボルネ）

torne（PS3 用地デジチューナー **Sony CECH-ZD1 J**）を、Chrome で **ページを開いて USB でつなぐだけ** で見られるようにするウェブアプリです。
アプリのインストールは不要で、WebUSB でチューナーを直接動かします。Android と Windows の Chrome で動作を確認しています。

## しくみ

```
torne（CECH-ZD1 J）
   │ USB（WebUSB）
usb.js              WebUSB の転送。ストリーム用に常に複数の受信を出しておく
   │
weborne.wasm（Go）   coax の MB86H47A／DiB8096 ドライバをそのまま WASM 化したもの
   ├─ 選局・信号測定
   ├─ 内蔵カードスロット（B-CAS）→ ECM から鍵を取得 → MULTI2 でスクランブル解除
   └─ 1 サービスだけ取り出し、PAT/PMT を書き換えて出力
   │ TS
player.js ──(SharedArrayBuffer のリング)──▶ decoder-worker.js（ffmpeg.wasm）
   │                                          MPEG-2/H.264 + AAC をデコード
   │◀──── 生の YUV と PCM（Matroska に入れてタイムスタンプ付きで受け取る）
   ├─ WebGL で表示（YUV→RGB、インターレース解除はシェーダーで）
   └─ Web Audio で再生（音声を時計にして映像を合わせる）
```

- チューナーの制御は [coax](https://github.com/Till0196/coax) のコードを **そのまま** 使っています。`go/` は coax のソース（2026-11-02 時点の main）から使う部分だけを取り出し、`cmd/weborne-wasm`、`cmd/weborne-file`、`internal/weborne` を足したものです（[go/README.md](go/README.md)）。
- MPEG-2 はブラウザが再生できないので、ffmpeg.wasm（[@ffmpeg/core](https://www.npmjs.com/package/@ffmpeg/core)）でデコードしています。

## 使い方

1. サイトを **HTTPS**（または localhost）で開けるようにします（WebUSB は安全な接続でしか動きません）。下の「配信のしかた」を参照。
2. **Chrome** でページを開きます。
3. torne を USB でつなぎ（スマホは **USB OTG アダプタ** 経由）、「接続」を押して CECH-ZD1 J を選びます。
4. 初回は「チャンネルスキャン」（UHF 13〜62ch、約 2 分）。見つかった局から順にボタンになります。途中で「中断」しても、次に接続したときに続きから再開します。
5. 局のボタンを押すと再生します。全画面ボタン（⛶）で横向き全画面になります。

画質は 3 段階です。端末の性能に合わせて選んでください。

| 画質 | 内容 | 重さの目安（PC の 1 コア） |
|---|---|---|
| 標準（軽量・540p） | MPEG-2 を半分の解像度でデコード（lowres）。既定 | 約 170〜200 fps 分の余裕 |
| 高画質（1080） | 1440×1080 をそのままデコード | 約 85 fps 分の余裕 |
| ワンセグ | 同じ放送のワンセグ（H.264 320×180） | ごく軽い |

### 対応環境

- チューナー：Sony CECH-ZD1 J のみ。B-CAS カードは torne 本体のカードスロットに挿したものを使います。
- ブラウザ：WebUSB に対応した Chromium 系（Android / Windows / macOS / Linux / ChromeOS の Chrome、Edge）。iPhone・iPad、Firefox、Safari は不可。

### 注意

- **Windows** は torne に自動でドライバを割り当てないので、最初の 1 回だけ WinUSB の割り当てが必要です。接続に失敗するとサイトに案内が出て、[web/driver/weborne-winusb.bat](web/driver/weborne-winusb.bat)（coax の `install-winusb.bat` に torne 用の inf を埋め込んだもの）をダウンロードして実行できます。署名用の証明書を作って PC に追加し、秘密鍵は署名後に削除します。
- 同じ torne を同時に使えるのは 1 つのアプリだけです。PC では TVTest や `coaxd.exe` を終了してから使ってください。
- torne は USB から給電されます。スマホ側の給電が足りず不安定なときは、セルフパワーの USB ハブを挟んでください。
- 「torne に前回の状態が残っています」と出たら、torne を一度抜いて挿し直してください。
- 私的な視聴の範囲で使ってください。

## 配信のしかた

ビルド（下記）したあとの `web/` を、そのまま静的サイトとして置くだけです（サーバー側の処理はありません）。

- **GitHub Pages**：`main` に push すると [.github/workflows/deploy.yml](.github/workflows/deploy.yml) がビルドして配信します。最初に一度だけ、リポジトリの Settings → Pages → Source を「GitHub Actions」にしてください。

- **ローカル**：`node serve.js` で `http://localhost:8080/` に立ちます（必要なヘッダー付き）。PC の Chrome ならそのまま使えます。
- **Tailscale**：`node serve.js` を起動したまま `tailscale serve --bg 8080` を実行すると、tailnet 内の端末だけに `https://<PC名>.<tailnet>.ts.net/` で公開されます。外出先のスマホからも使えます。止めるときは `tailscale serve --https=443 off`。
- **adb 経由**：`start.bat` がサーバーを起動し、`adb reverse tcp:8080 tcp:8080` でスマホの `localhost:8080` を PC に転送します。スマホの USB 端子は torne に使うので、adb は **ワイヤレス デバッグ** でつなぎます（Android 11 以降）。
- **ほかの静的ホスティング**：SharedArrayBuffer に必要なヘッダー（COOP/COEP）は、ヘッダーを設定できないホストでも `web/coi-sw.js`（Service Worker）が付けます。初回だけ自動で 1 回再読み込みされます。ffmpeg-core.wasm が約 32MB あるので、1 ファイル 25MiB までの Cloudflare Pages には分割などの対応が必要です。

## ビルド

```powershell
npm install
powershell -ExecutionPolicy Bypass -File build.ps1
```

- Go 1.26 以上が必要です（PATH に無ければ `.work/go` に置いたポータブル版を使います）。
- `go/` を `GOOS=js GOARCH=wasm` でビルドして `web/weborne.wasm` を作り、`wasm_exec.js` と ffmpeg.wasm（npm の `@ffmpeg/core`）を `web/` にコピーします。これらの生成物はリポジトリには含めていません。

## フォルダ構成

| パス | 中身 |
|---|---|
| [web/](web/) | 配信するサイト一式 |
| [web/app.js](web/app.js) | 画面と操作（接続、選局、スキャン、状態表示、Windows のドライバ案内） |
| [web/usb.js](web/usb.js) | WebUSB の転送（Go 側から呼ばれる） |
| [web/player.js](web/player.js) | デコーダ Worker の管理、WebGL 表示、音声、同期 |
| [web/decoder-worker.js](web/decoder-worker.js) | ffmpeg.wasm を動かす Worker |
| [web/mkv.js](web/mkv.js) | ffmpeg の出力（Matroska）を読む |
| [web/ring.js](web/ring.js) | ページ → Worker の TS 受け渡し（SharedArrayBuffer） |
| [web/coi-sw.js](web/coi-sw.js) | COOP/COEP ヘッダーを付ける Service Worker |
| [web/driver/](web/driver/) | Windows 用の WinUSB インストーラ |
| [go/cmd/weborne-wasm/](go/cmd/weborne-wasm/) | WASM の入口。`weborne` オブジェクトを JS に公開する |
| [go/internal/weborne/pipeline/](go/internal/weborne/pipeline/) | PAT/PMT/SDT の解析、ECM→カード、スクランブル解除、サービスの抜き出し |
| [go/internal/weborne/multi2/](go/internal/weborne/multi2/) | MULTI2 暗号 |
| [go/cmd/weborne-file/](go/cmd/weborne-file/) | 動作確認用：録画した TS を winscard.dll 経由のカードで解除する Windows 用ツール |
| [tools/](tools/) | 検証用スクリプト |
| [serve.js](serve.js) / [start.bat](start.bat) | ローカル配信用 |
| `.work/` | 作業用（ポータブル Go、録画サンプルなど）。リポジトリには含めない |

### 検証用スクリプト（`tools/`）

| スクリプト | 内容 |
|---|---|
| `hw-test.mjs` | ブラウザなしで `weborne.wasm` と `usb.js` を Node から実機に対して動かし、受信した TS を保存する |
| `e2e-hw.mjs` | ヘッドレス Chrome でアプリを動かし、USB 転送だけ Node 経由で実機に中継する通しテスト（`node serve.js` を起動しておく） |
| `test-worker.mjs` | 録画した TS を Node 上の ffmpeg.wasm に通して、デコード速度と出力を確認する |
| `test-mkv.mjs` | Matroska の読み取りを確認する |

## ライセンス

- weborne のために書いたコード（`web/`、`go/cmd/weborne-*`、`go/internal/weborne`、`tools/` など）は [GPL-2.0](COPYING) です。
- `go/` の coax 由来のコードは coax のライセンス（`Apache-2.0 OR GPL-2.0-or-later`、一部 `GPL-2.0-only`）のままです（[go/NOTICE](go/NOTICE)、[go/COPYING](go/COPYING)、[go/LICENSE-APACHE](go/LICENSE-APACHE)）。DiB8096 のドライバに `GPL-2.0-only` のファイルが含まれるので、`weborne.wasm` は全体として GPL-2.0-only です。
- `web/driver/weborne-winusb.bat` は coax の `install-winusb.bat`（Apache-2.0）をもとにしています。
- ffmpeg.wasm（`@ffmpeg/core`）は GPL-2.0-or-later です。
- サイトを他の人に公開する場合は、GPL に従ってソースコードも入手できるようにしてください。

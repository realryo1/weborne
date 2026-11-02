# go/

[coax](https://github.com/Till0196/coax)（2026-11-02 時点の main）から、weborne が使うパッケージだけを取り出したものに、weborne のコードを足したものです。

- coax から取り出したもの（変更なし。テストは除外）：`internal/coaxd/demod/dib8096`、`internal/coaxd/usb/bridge/mb86h47`、`pkg/`（`isdb`、`mpegts`、`iso7816`、`usbio` など）
- weborne のコード：`cmd/weborne-wasm`、`cmd/weborne-file`、`internal/weborne`

ライセンスは coax のものに従います（[NOTICE](NOTICE)、[COPYING](COPYING)、[LICENSE-APACHE](LICENSE-APACHE)）。

# go/

[coax](https://github.com/Till0196/coax)（2026-11-02時点のmain）から、weborneが使うパッケージだけを取り出したものに、weborneのコードを足したものです。

- coaxから取り出したもの（変更なし。テストは除外）：`internal/coaxd/demod/dib8096`、`internal/coaxd/usb/bridge/mb86h47`、`pkg/`（`isdb`、`mpegts`、`iso7816`、`usbio`など）
- weborneのコード：`cmd/weborne-wasm`、`cmd/weborne-file`、`internal/weborne`

ライセンスはcoaxのものに従います（[NOTICE](NOTICE)、[COPYING](COPYING)、[LICENSE-APACHE](LICENSE-APACHE)）。

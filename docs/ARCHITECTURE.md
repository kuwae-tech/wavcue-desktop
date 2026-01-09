# WavCue Desktop Architecture (Short)

WavCue Desktop は Electron の single-window アプリで、機能の大半は Renderer 側の単一 HTML (`renderer/prototype.html`) に集約されています。

## High-level flow
1. **Main process** (`main.js`)
   - `BrowserWindow` を生成し、Renderer をロード。
   - `electron-store` で Settings を保存。
   - OS 依存のフォルダ作成 / 保存ダイアログ / ウィンドウ制御を担当。
2. **Preload** (`preload.js`)
   - `contextBridge` で IPC API を `window.wavcue` に公開。
   - Windows のタイトルバードラッグ安定化 CSS を注入。
3. **Renderer** (`renderer/prototype.html`)
   - WAV 読み込み、CUE/チャンク編集、QC、添付、書き出し、ログ/差分 UI を実装。
   - `state` をシングルソースとして維持し、必要に応じて localStorage / IndexedDB でプリセットを保存。

## Key data flows
- **Settings**: Renderer → IPC → Main (`electron-store`) の単方向保存が中心。
- **Export**: Renderer でチャンクを生成 → `export:saveFile` IPC で保存。
- **Attachments**: Renderer のメモリストア (`_pdfStore`) と `state.attachments` に保持。

## Notes
- `renderer/settings.html` は単体ページとして存在するが、現在アプリからは参照されていません。

# Implementation Status Inventory

この資料は、現行実装の「できていること / できていないこと」を網羅的に棚卸しし、次の実装指示の一次資料として使うためのものです。

## A. アプリ構成

### エントリポイント / プロセス責務
- **Entry**: `main.js`（Electron メインプロセス）。`BrowserWindow` を作成して `renderer/prototype.html` をロードする。`preload.js` を `contextIsolation` で注入。
- **Main（Electron）**: フォルダ初期化 (`Exports/Backups/Reports`)、設定保存（`electron-store`）、ウィンドウ操作 IPC、書き出し保存ダイアログ (`export:saveFile`) の実装。
- **Preload**: `contextBridge` で `window.wavcue` API を公開。Windows タイトルバーのドラッグ安定化 CSS を注入。
- **Renderer**: `renderer/prototype.html` が UI とロジックを単一 HTML に集約。波形描画、CUE/チャンク編集、QC、添付、書き出し、ログ/差分 UI を全部内包。

### 主要ディレクトリ
- `main.js`: メインプロセス・設定/IPC。
- `preload.js`: IPC ブリッジ/Windows ドラッグ安定化。
- `renderer/`: UI とフロントロジック（`prototype.html` が実体）。
  - `renderer/prototype.html`: 全 UI と WAV 解析/書き出し。
  - `renderer/settings.html`: 単体の設定ページ（現状アプリからは未使用）。
- `build/`: アイコン・ビルド成果物。

## B. 画面 / モーダル一覧

> すべて `renderer/prototype.html` が実体。Open 方法は主にボタンイベントから `dialog.showModal()`。

| 画面 / モーダル | 実体ファイル | 開き方 | 状態管理の所在 |
| --- | --- | --- | --- |
| メイン画面（波形/キュー/ログ） | `renderer/prototype.html` | アプリ起動時にロード | `state` オブジェクト（Renderer メモリ） |
| チャンク/ログ（bext/cmcd/ログ/差分） | `renderer/prototype.html` `#chunkDialog` | `#btnChunk` クリック | `state` + DOM（Renderer） |
| CMCD 入力モーダル | `renderer/prototype.html` `#cmcdDialog` | `#btnCmcd` / chunkDialog から open | `state.cmcdBytes` + `state.cmcdPresetId`（Renderer） |
| PDF/ファイル添付モーダル | `renderer/prototype.html` `#pdfAttachDialog` | `#btnPdfAttach` | `state.attachments` + `_pdfStore`（Renderer メモリ） |
| 添付ビューア | `renderer/prototype.html` `#pdfViewDialog` | 添付モーダル内「確認」 | `state.pdfViewUrl` / 添付 state（Renderer） |
| Export Check（書き出し前チェック） | `renderer/prototype.html` `#exportCheckDialog` | `#btnExport` → `_ecRunAndShow()` | `state` + QC 設定（Renderer） |
| Standard Check（規格チェック） | `renderer/prototype.html` `#stdCheckDialog` | `#btnStdCheck` | `state.qc*` + QC プリセット（Renderer, localStorage/IndexedDB） |
| Settings モーダル | `renderer/prototype.html` `#settingsDialog` | `#btnSettings` | Main の `electron-store`（IPC 経由） |
| Changelog | `renderer/prototype.html` `#changelogDialog` | `#btnChangelog` | DOM 固定情報 |
| QC/CMCD プリセットエクスポート選択 | `renderer/prototype.html` `#scExportSelDialog`, `#cmcdExportSelDialog` | プリセット管理 UI | Renderer（localStorage/IndexedDB） |

## C. IPC 一覧

| Channel | 呼び出し側 | 受け側 | Payload | 返り値 / エラー |
| --- | --- | --- | --- | --- |
| `window:minimize` | Renderer (`window.wavcue.winMinimize`) | Main | なし | なし |
| `window:toggle-maximize` | Renderer (`window.wavcue.winToggleMaximize`) | Main | なし | なし |
| `window:close` | Renderer (`window.wavcue.winClose`) | Main | なし | なし |
| `window:is-maximized` | Renderer (`window.wavcue.winIsMaximized`) | Main | なし | `boolean` |
| `settings:get` | Renderer (`window.wavcue.getSettings`) | Main | なし | `settings` オブジェクト |
| `settings:set` | Renderer (`window.wavcue.setSettings`) | Main | `patch` オブジェクト | 更新後 `settings` |
| `settings:ensure-default-folders` | Renderer (`window.wavcue.ensureDefaultFolders`) | Main | なし | 更新後 `settings` |
| `settings:open-folder` | Renderer (`window.wavcue.openFolder`) | Main | `{kind: 'exports'|'backups'|'reports'|'root'}` | `{ ok: boolean, message? }` |
| `settings:run-cleanup-now` | Renderer (`window.wavcue.runCleanupNow`) | Main | なし | `{ ok, summary, deletions }` |
| `settings:cleanup-progress` | Main → Renderer (`window.wavcue.onCleanupProgress`) | Renderer | `{ message }` | なし |
| `export:saveFile` | Renderer (`window.wavcue.saveExportFile`) | Main | `{ defaultName, dataBase64 }` | `{ ok, filePath }` / `{ ok:false, canceled:true }` / `{ ok:false, error }` |

## D. Export 処理フロー

### 入力 → 処理 → 生成物
1. **WAV 読み込み**: Renderer で `loadFile()` が `ArrayBuffer` を読み取り、RIFF チャンク解析 + `state` 更新。
2. **書き出し前チェック**: `exportWav()` が CUE 数/NOTE 重複/CP932 ラベル可否/PCM 判定を実施。
3. **チャンク生成**:
   - **bext**: `buildBextChunk()` で CodingHistory のみ更新（他フィールドは保持）。
   - **cmcd**: `buildCmcdChunkFixed2048()`。
   - **cue/plst/LIST:adtl**: `buildCueChunks()` でラベル整形・NOTE/添付を反映。
   - **data**: 自動補正適用時のみ `procDataPayload` を差し替え。
4. **書き出し方式の分岐**:
   - **ハイブリッド in-place**（CUE 位置変更のみ & 添付なし）: 既存 `cue ` チャンクを上書きし、`plst` のみ再生成。
   - **再構築**: `rebuildWaveFromOriginal()` で `bext/cmcd/cue/LIST/plst/data` を差し替え、未知チャンク/iXML をパススルー。
5. **保存**:
   - Renderer が `export:saveFile` IPC で OS 保存ダイアログを起動。
   - 成功後に **バックアップ WAV**（原本のまま）を別名保存。
   - `autoReport` が有効なら **Export Report (.txt)** を保存。

### 「余計な Export フォルダを作らない」方針
- 書き出しは **必ずユーザーの保存ダイアログ** 経由。Main は `ensureWavExtension` で拡張子のみ補正し、保存先はユーザーが決定する設計。
- `Exports/Backups/Reports` は Settings 用に作成されるが、書き出し先の既定には使われていない。

## E. Settings の現状

### 実装済み
- **永続化**: Main で `electron-store` (`settings` namespace) に保存。
- **設定 UI**: `renderer/prototype.html` 内の `#settingsDialog`。
- **対応項目**: cleanup 関連（retentionDays/backupQuotaGB/minKeepCount/deleteMethod/autoCleanup フラグ群）、パス表示、フォルダオープン、即時クリーンアップ。
- **Export への反映**: `autoReport` のみ Renderer が反映（書き出し時のレポート保存）。

### 未実装 / 限定的
- **autoCleanupOnExport/OnQuit/OnStartup** のトリガーは Main/Renderer どちらにも実装なし（設定保存はできるが使われていない）。
- **保存先フォルダの自動反映**は未実装（Settings の `Exports/Backups/Reports` は手動で開くのみ）。
- **バリデーション**: 数値入力の範囲・妥当性は UI 側でほぼ未検証（最低値のみ `min` 属性）。
- **Renderer 独自設定**: `pairSeconds` / `linkPair` は localStorage 保存で、Main の `electron-store` とは別系統。

## F. 重要仕様（壊すと危険）Top 10

1. **BWF/bext の保持**: 既存 bext がある場合は CodingHistory 以外を保持する設計。
2. **iXML パススルー**: iXML はユーザー編集不可で、書き出し時に保持する前提。
3. **未知チャンク保持**: `rebuildWaveFromOriginal()` で未知チャンクをパススルーし、自己検証で差分検知。
4. **CUE 最大 99 件 & NOTE 重複禁止**: 書き出し直前に規格制約をチェック。
5. **CUE ラベルの CP932 (Shift-JIS) 適合**: 変換不可文字がある場合は書き出しを止める。
6. **CUE dwName の保持/再割当**: `normalizeCueIds` で ID 0/重複のみ再採番し、既存 ID を優先維持。
7. **NOTE の扱いと添付の紐付け**: 添付がある場合は `BC$NOTE1..9` を自動補充し、LIST/adtl/file を NOTE の直後に挿入。
8. **plst の規格互換**: `BC$NOTE` を除外した `plst` を生成し、BC$ セグメントのみ列挙。
9. **拡張子事故防止**: Main の `ensureWavExtension` で `.wav` 以外を補正。
10. **タイトルバー安定状態**: Main の `titleBarStyle` と Preload の Windows ドラッグ修正 CSS により、ドラッグ領域やアニメーションを固定化。

## G. TODO / 未実装 / 仮実装（優先度付き）

### P0（今すぐ直すと事故が減る）
- **autoCleanupOnExport/OnQuit/OnStartup を実際に実行**
  - 設定は保存されるがトリガーが無いため、期待通りクリーンアップされない。
- **Settings の数値バリデーション強化**
  - retentionDays / backupQuotaGB / minKeepCount の範囲逸脱でも保存できてしまう。

### P1（運用で困るが致命的ではない）
- **Exports/Backups/Reports の自動利用**
  - 保存先フォルダの既定がユーザー任意になっており、設定値が実運用で反映されない。
- **添付データの永続化**
  - `_pdfStore` はメモリのみで、アプリ再起動で添付が失われる。

### P2（UI/設計の整理）
- **`renderer/settings.html` の扱い**
  - 現在アプリから参照されておらず、動作している Settings UI は `#settingsDialog` のみ。
- **Renderer 側 localStorage 設定と Main の settings を統合**
  - `pairSeconds` / `linkPair` が別系統で保存されている。

## 付録: TODO コメントの集約
- リポジトリ直下の実コード（`main.js` / `preload.js` / `renderer/*.html`）には TODO コメントは見当たりません。
  - `node_modules` 内には多数存在するため対象外。

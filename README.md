# wavcue-desktop

## 開発起動方法

```bash
npm install
npm run dev
```

## Settings

メニューバーの「WavCue > Settings」から設定ウィンドウを開けます。初回起動時に Documents/WavCue 配下へ Exports/Backups/Reports フォルダを自動作成します。作成できない場合は作業フォルダ選択ダイアログが表示され、さらに失敗した場合は userData 配下へフォールバックします。

## Actions成果物のダウンロード方法

1. GitHub のリポジトリで Actions を開きます。
2. 「Build Desktop Apps」を選び、対象の workflow run を開きます。
3. 画面下部の Artifacts から OS に対応した成果物をダウンロードします。

### macOS の初回起動警告について

未署名アプリのため初回起動時に警告が出る場合があります。Finder でアプリを右クリックして「開く」を選ぶか、「システム設定 > プライバシーとセキュリティ」から許可すると起動できます。
　

# UniBrowse

ブラウザ・エクスプローラ・ウィンドウ管理を1つにまとめた自分用ツール（Tauri v2 / Windows向け）。

## できること
- **タブ**：Ctrl+T で新規、Ctrl+W で閉じる
- **分割ペイン**：左右/上下に何段でも分割、境界線をドラッグしてサイズ変更
- **Webペイン**：URL/検索ワード入力、戻る・進む・再読込
- **フォルダペイン**：ダブルクリックで移動/ファイルを既定アプリで開く、上へ・ホーム・ドライブ一覧
- **アプリ取り込みペイン**：開いている他アプリのウィンドウを選んでペイン内に埋め込み（「取り出す」で戻せる）

## 準備（初回のみ）
1. Rust: https://www.rust-lang.org/tools/install
2. Node.js
3. WebView2（Windows 11は標準搭載）とVisual Studio Build Tools（C++）

## 起動・ビルド
```
npm install
npm run dev      # 開発起動
npm run build    # インストーラ作成
```

## 既知の制限
- Webペインのアドレス欄は、ページ内リンクで遷移しても自動では更新されません。
- 取り込みペインは Win32 の SetParent を使うため、管理者権限のアプリ・UWPアプリ・一部のゲーム等は埋め込めない場合があります。
  アプリを取り込んだまま UniBrowse を強制終了すると、そのアプリが道連れになることがあります（先に「取り出す」を推奨）。
- Web用の子Webview（Tauriの `unstable` 機能）を使っています。Tauriのバージョンによって挙動が変わる可能性があります。

## 構成
- `src/` … 画面（index.html / main.js / style.css、ビルド不要）
- `src-tauri/src/lib.rs` … ファイル操作、子Webview制御、Win32ウィンドウ取り込み

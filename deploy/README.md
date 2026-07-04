# デプロイ補助ファイル

GitHub Pages は「Settings → Pages → Build and deployment → Source: **Deploy from a branch** → `main` / `/ (root)`」で配信可能（ワークフロー不要）。

`.github/workflows/` へ置くと自動化できるワークフローの雛形を、`workflow` スコープの都合でここに `.txt` で退避してあります。
サーバ側の日次再生成が必要なときは、GitHub の Actions 画面（Web UI）から以下を新規ワークフローとして貼り付けてください：

- `pages.yml.txt` … push で Pages へデプロイ（Source を「GitHub Actions」にする場合）
- `daily.yml.txt` … 毎日 06:20 JST に `scripts/build_regions.py` を再実行して commit

※ 現状、画面表示の数値はブラウザ側で「今日の日付」へ補間するため、ワークフローなしでも**日々変化**します。

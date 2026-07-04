# TAmJ 地域共生インテリジェンス（teamONE）

医療・介護・暮らし・地域産業を一つの連携でつなぎ直す構想の企画ポータル。

## ページ構成
- `index.html` … ホーム（ビジョン・連携のかたち・導線）
- `data.html`  … 地域データ（全国全市区町村の独自マクロ推計。都道府県／市区町村を入力検索）
- `impact.html`… 経済と投資（経済効果 / 投資構造 / 地域産業資本）
- `css/app.css` `css/site.css` … 共通スタイル（白×セージ緑×珊瑚の柔らかいトーン）
- `js/engine.js` … 推計エンジン（アンカー×日付補間、人口10万対など各指標はエリア人口で算出）
- `data/regions.json` … 全国データ（47都道府県＋全1,740市区町村, 国勢調査実測人口）
- `data/source_pop_census.csv` … 人口アンカー元データ
- `scripts/build_regions.py` … regions.json 生成
- `assets/img/` … キービジュアル・各章の画像
- `deploy/` … Pages/日次ワークフローの雛形（PATにworkflowスコープが無いため退避）

## データの性質
人口・長期変化率は国勢調査（実測）。高齢化率・施設数・現在値・各種10万対指標は独自推計
（アンカー×日付補間×人口按分）であり確定値ではない。金額・利回りはすべて仮説モデル。

## 公開
GitHub Pages（main / root）→ カスタムドメイン `teamone.tamjump.com`（`CNAME`）。DNSは Cloudflare 側で設定。

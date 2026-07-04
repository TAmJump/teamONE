# TAmJ 地域インテリジェンス（teamONE）

全国 市区町村単位の医療・介護マクロ推計。公式統計のアンカー値を「今日の日付」へ日次補間し、
人口・年齢・労働人口・高齢化率・社会福祉法人数・介護事業所数・医療機関数（診療科目別）・薬局数を
**独自マクロ推計**として表示する。2000年からの推移＋現在地を提示。

## 構成
- `index.html` … ダッシュボード本体（地方→都道府県→市区町村セレクタ）
- `js/engine.js` … 推計エンジン（アンカー×補間、性比・労働力率・施設按分）
- `js/auth.js` … 会員認証（Cloudflare Worker `tamjump-member-api`）／登録は無料・必須
- `data/regions.json` … アンカーデータ（47都道府県＋主要市区町村）
- `scripts/build_regions.py` … アンカーからデータ生成
- `.github/workflows/pages.yml` … push で GitHub Pages へ自動デプロイ
- `.github/workflows/daily.yml` … 毎日 06:20 JST に再生成・commit（日次更新）

## データの性質
人口・高齢化率は公式統計（国勢2020／住基2025／高齢社会白書R7）のアンカーに基づく。
施設数・労働人口・現在値は、全国確定値の人口按分と日付補間による**推計**であり確定値ではない。

## 全 1,741 市区町村への拡張
`scripts/build_regions.py` の `MUNI` テーブルに市区町村を追加すれば自動で反映。
将来は e-Stat API（国勢・医療施設・介護事業所・衛生行政報告例）を daily workflow から取得して
アンカーを実データ差し替え可能な設計。

## カスタムドメイン
`CNAME` = `chiiki.tamjump.com`（変更可）。DNS 設定は JIN（Cloudflare）が実施。

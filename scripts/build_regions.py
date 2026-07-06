#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_regions.py — TAmJ 地域マクロ推計（全国フル版）
実測: 全1,741市区町村の総人口（国勢調査2020）と長期変化率（1980→2020）。
推計: 高齢化率（県アンカー×人口規模×減少率）・施設数（全国確定値の人口按分）・現在値（日付補間）。
出力: data/regions.json（series はエンジン側で算出するため保持しない＝軽量化）。
データ源: data/source_pop_census.csv（keisukekondokk/female-population-japan, 国勢調査由来）
"""
import json, csv, math, datetime, os, urllib.request

SRC_LOCAL = os.path.join("data", "source_pop_census.csv")
SRC_URL = "https://raw.githubusercontent.com/keisukekondokk/female-population-japan/main/data/csv_pop/population_census_panel_1980_2020_total_age20_39.csv"

NATIONAL = {
    "pop2020": 126146, "pop2024": 123802,
    "aging2025": 29.4, "youth2025": 10.9,
    "shafuku": 21086, "hospital": 8064, "clinic": 105000,
    "dental": 67000, "pharmacy": 62000, "kaigo": 230000,
    "tokuyo": 8500, "roken": 4300,
}
SHINRYOU_KAMOKU = {
    "内科": 0.62, "小児科": 0.20, "外科": 0.13, "整形外科": 0.14,
    "皮膚科": 0.11, "眼科": 0.09, "耳鼻いんこう科": 0.07,
    "産婦人科": 0.05, "精神科": 0.06, "泌尿器科": 0.05,
    "リハビリテーション科": 0.12, "循環器内科": 0.10,
}
PREF_META = {
 "北海道":("北海道",33.5),"青森県":("東北",35.0),"岩手県":("東北",35.0),"宮城県":("東北",29.0),
 "秋田県":("東北",39.45),"山形県":("東北",35.0),"福島県":("東北",33.0),"茨城県":("関東",30.5),
 "栃木県":("関東",29.8),"群馬県":("関東",30.5),"埼玉県":("関東",28.0),"千葉県":("関東",28.5),
 "東京都":("関東",23.44),"神奈川県":("関東",26.30),"新潟県":("中部",33.5),"富山県":("中部",33.0),
 "石川県":("中部",30.5),"福井県":("中部",31.5),"山梨県":("中部",31.5),"長野県":("中部",32.5),
 "岐阜県":("中部",31.0),"静岡県":("中部",30.5),"愛知県":("中部",26.0),"三重県":("中部",30.5),
 "滋賀県":("近畿",27.0),"京都府":("近畿",29.5),"大阪府":("近畿",28.0),"兵庫県":("近畿",29.5),
 "奈良県":("近畿",32.0),"和歌山県":("近畿",34.0),"鳥取県":("中国",33.0),"島根県":("中国",35.0),
 "岡山県":("中国",30.5),"広島県":("中国",29.5),"山口県":("中国",35.67),"徳島県":("四国",35.0),
 "香川県":("四国",32.0),"愛媛県":("四国",33.5),"高知県":("四国",36.57),"福岡県":("九州",28.0),
 "佐賀県":("九州",30.5),"長崎県":("九州",33.0),"熊本県":("九州",31.5),"大分県":("九州",33.5),
 "宮崎県":("九州",32.5),"鹿児島県":("九州",32.5),"沖縄県":("九州",24.29),
}
PREF_YOUTH = {
 "沖縄県":16.6,"滋賀県":13.2,"佐賀県":13.2,"愛知県":12.5,"熊本県":12.8,"宮崎県":13.0,
 "鹿児島県":13.0,"福岡県":12.7,"広島県":12.3,"岡山県":12.1,"長野県":12.0,"岐阜県":12.0,
 "福井県":12.2,"三重県":11.8,"長崎県":12.2,"大分県":11.8,"鳥取県":11.8,"島根県":11.9,
 "静岡県":11.7,"兵庫県":11.7,"香川県":11.6,"石川県":11.6,"栃木県":11.5,"群馬県":11.3,
 "茨城県":11.3,"神奈川県":11.4,"埼玉県":11.4,"山口県":11.3,"愛媛県":11.2,"千葉県":11.2,
 "山梨県":11.2,"東京都":11.1,"大阪府":11.1,"宮城県":11.3,"和歌山県":11.0,"奈良県":11.0,
 "福島県":11.0,"京都府":10.9,"富山県":10.7,"山形県":10.7,"岩手県":10.3,"北海道":10.2,
 "新潟県":10.8,"徳島県":10.6,"高知県":10.5,"青森県":10.0,"秋田県":9.2,
}

# ── 実データ取り込み（任意・後入れ） ─────────────────────────────
# data/real/*.csv を 市区町村コード(id_muni2020, 例 "1100") を主キーに束ねる。
# 各ファイル・各列は任意。存在する値だけを muni["real"] に載せ、無い分は
# engine.js 側で従来の代理指標（推計）へ自動フォールバックする。
REAL_DIR = os.path.join("data", "real")
REAL_FILES = {
    # 厚労省 医療施設調査（静態）市区町村編：病床数・在宅療養支援診療所・訪問看護ST
    "medical_facilities.csv": ["beds", "zaishien", "houkan", "hospital", "clinic"],
    # 厚労省 無医地区等調査：無医地区数・準無医地区数・対象人口
    "mui.csv":                ["mui", "junmui", "muiPop"],
    # 各都道府県 救急告示リスト：二次救急(告示)施設数・救命救急センター数
    "emergency.csv":          ["er2", "er3"],
    # 農林業/漁業センサス・観光統計：農業産出額(百万円)・漁業(百万円)・延べ宿泊(千人泊)
    "industry.csv":           ["agri", "fishery", "tourism"],
}

def _num(s):
    s = (s or "").strip().replace(",", "")
    if s == "" or s.upper() in ("NA", "-", "…", "X"):
        return None
    try:
        v = float(s)
        return int(v) if v == int(v) else round(v, 2)
    except ValueError:
        return None

def load_real():
    """data/real/*.csv を code(id_muni2020)で束ねて返す: {code:{field:value}}。"""
    real = {}
    if not os.path.isdir(REAL_DIR):
        return real
    loaded = []
    for fname, fields in REAL_FILES.items():
        path = os.path.join(REAL_DIR, fname)
        if not os.path.exists(path):
            continue
        n = 0
        for row in csv.DictReader(open(path, encoding="utf-8-sig")):
            code = (row.get("code") or row.get("id_muni2020") or "").strip()
            if not code:
                continue
            d = real.setdefault(code, {})
            got = False
            for k in fields:
                v = _num(row.get(k))
                if v is not None:
                    d[k] = v; got = True
            if got:
                n += 1
        loaded.append("%s:%d" % (fname, n))
    real = {c: d for c, d in real.items() if d}   # 値の無い行(空dict)は除外
    if loaded:
        print("real ingested ->", ", ".join(loaded), "| muni with data:", len(real))
    return real

def load_rows():
    if not os.path.exists(SRC_LOCAL):
        os.makedirs("data", exist_ok=True)
        urllib.request.urlretrieve(SRC_URL, SRC_LOCAL)
    rows = []
    for r in csv.DictReader(open(SRC_LOCAL, encoding="utf-8")):
        try:
            p2020 = int(float(r["pop_total_2020"])); p1980 = int(float(r["pop_total_1980"]))
        except (ValueError, KeyError):
            continue
        if p2020 <= 0: continue
        toks = r["name_muni2020"].split()
        pref = toks[0]; gun = toks[1] if len(toks)==3 else ""; name = toks[-1]
        rows.append({"code": r["id_muni2020"], "pref": pref, "gun": gun,
                     "name": name, "pop2020": p2020, "pop1980": p1980})
    return rows

def cagr(a, b, yrs):
    if a<=0 or b<=0: return 0.0
    return (math.pow(b/a, 1.0/yrs)-1)*100.0

def facilities_for(pop2020, natl_pop):
    share = pop2020/(natl_pop*1000.0); f={}
    for k in ["shafuku","hospital","clinic","dental","pharmacy","kaigo","tokuyo","roken"]:
        f[k]=max(0, round(NATIONAL[k]*share))
    for k in ["shafuku","hospital","clinic","dental","pharmacy","kaigo"]:
        f[k]=max(1, f[k])
    return f

def muni_aging(pref_aging, pop2020, growth):
    size_off=(math.log10(40000)-math.log10(max(500,pop2020)))*4.5
    size_off=max(-4.5,min(11.0,size_off))
    decl_off=max(-3.0,min(6.0,-growth*2.2))
    return round(max(12.0,min(50.0, pref_aging+size_off+0.5*decl_off)),1)

def build():
    rows=load_rows(); natl_pop=NATIONAL["pop2020"]
    real=load_real()
    pref_agg={}
    for r in rows:
        a=pref_agg.setdefault(r["pref"],{"pop2020":0,"pop1980":0})
        a["pop2020"]+=r["pop2020"]; a["pop1980"]+=r["pop1980"]
    prefectures=[]
    for pref,meta in PREF_META.items():
        region,aging=meta; agg=pref_agg.get(pref,{"pop2020":0,"pop1980":0})
        prefectures.append({"name":pref,"region":region,"level":"pref","code":pref,
            "pop2020":round(agg["pop2020"]/1000.0,1),"aging":aging,
            "youth":PREF_YOUTH.get(pref,11.0),"growth":round(cagr(agg["pop1980"],agg["pop2020"],40),2),
            "facilities":facilities_for(agg["pop2020"],natl_pop)})
    municipalities=[]
    pref_real={}
    for r in rows:
        meta=PREF_META.get(r["pref"])
        if not meta: continue
        region,pref_aging=meta; growth=round(cagr(r["pop1980"],r["pop2020"],40),2)
        aging=muni_aging(pref_aging,r["pop2020"],growth)
        youth=round(max(6.0,min(18.0, PREF_YOUTH.get(r["pref"],11.0)-(aging-pref_aging)*0.18)),1)
        disp=(r["name"]+"（"+r["gun"]+"）") if r["gun"] else r["name"]
        m={"name":r["name"],"disp":disp,"pref":r["pref"],"region":region,
            "level":"muni","code":r["code"],"pop2020":round(r["pop2020"]/1000.0,1),
            "aging":aging,"youth":youth,"growth":growth,
            "facilities":facilities_for(r["pop2020"],natl_pop)}
        rd=real.get(r["code"])
        if rd:
            m["real"]=rd
            pa=pref_real.setdefault(r["pref"],{})
            for k,v in rd.items():
                pa[k]=pa.get(k,0)+v   # 県値＝管内市区町村の実データ合算
        municipalities.append(m)
    # 県レコードへ集計済み実データを付与
    for p in prefectures:
        pr=pref_real.get(p["name"])
        if pr: p["real"]={k:(round(v,2) if isinstance(v,float) else v) for k,v in pr.items()}
    # yomi（ひらがな・別工程で付与）は build で作らないため、既存 regions.json から引き継ぐ
    OUT="data/regions.json"
    if os.path.exists(OUT):
        try:
            old=json.load(open(OUT,encoding="utf-8"))
            ym={m["code"]:m["yomi"] for m in old.get("municipalities",[]) if m.get("yomi")}
            yp={p["name"]:p["yomi"] for p in old.get("prefectures",[]) if p.get("yomi")}
            for m in municipalities:
                if m["code"] in ym: m["yomi"]=ym[m["code"]]
            for p in prefectures:
                if p["name"] in yp: p["yomi"]=yp[p["name"]]
            carried=sum(1 for m in municipalities if m.get("yomi"))
            print("yomi carried over: %d/%d muni" % (carried,len(municipalities)))
        except Exception as ex:
            print("yomi carry skipped:", ex)
    out={"meta":{"title":"TAmJ 地域マクロ推計","generated":datetime.date.today().isoformat(),
        "coverage":{"prefectures":len(prefectures),"municipalities":len(municipalities)},
        "note":"人口・長期変化率は国勢調査（実測）。高齢化率・施設数・現在値は独自推計（アンカー×補間×按分）。",
        "sources":["総務省 国勢調査（1980・2020, 市区町村別総人口）",
            "内閣府 高齢社会白書 令和7年版 / 総務省 住民基本台帳2025（高齢化率アンカー）",
            "厚生労働省 医療施設(動態)調査2024（病院8,064）",
            "WAM 社会福祉法人現況報告集約2024（21,086法人）",
            "厚生労働省 介護サービス施設・事業所調査 / 衛生行政報告例",
            "市区町村総人口: keisukekondokk/female-population-japan（国勢調査由来）"],
        "national":NATIONAL,"kamoku":SHINRYOU_KAMOKU,"laborForceRate":0.82,
        "hasReal":bool(real),
        "realFields":sorted({k for d in real.values() for k in d}) if real else []},
        "prefectures":prefectures,"municipalities":municipalities}
    json.dump(out,open("data/regions.json","w",encoding="utf-8"),ensure_ascii=False,separators=(",",":"))
    print(f"prefectures={len(prefectures)} municipalities={len(municipalities)} size={os.path.getsize('data/regions.json')//1024}KB")

if __name__=="__main__":
    build()

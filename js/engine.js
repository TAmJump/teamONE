/* ============================================================
   engine.js — TAmJ 地域マクロ推計エンジン
   公式アンカー（国勢2020・住基2025・医療施設2024・WAM2024）を
   「今日の日付」へ補外し、日次で動く独自推計値を返す。
   ============================================================ */
(function (global) {
  'use strict';

  const DRIFT = {
    youth: -0.05,    // 年少割合 年間ドリフト(pt/yr)
    facDamp: 0.5,    // 施設数は人口変動の平方根で緩やかに追随
  };

  // 全国高齢化率アンカー（実績＋推計, %）→ 各地域を全国比率でスケール
  const NATL_AGING = [
    [2000,17.4],[2005,20.2],[2010,23.0],[2015,26.6],[2020,28.6],
    [2024,29.3],[2025,29.4],[2030,31.2],[2040,34.8],[2050,37.1],[2070,38.7]
  ];
  const NATL_2025 = 29.4;

  function natlAging(yf) {
    const a = NATL_AGING;
    if (yf <= a[0][0]) return a[0][1];
    if (yf >= a[a.length-1][0]) return a[a.length-1][1];
    for (let i=0;i<a.length-1;i++){
      if (yf>=a[i][0] && yf<=a[i+1][0]){
        const t=(yf-a[i][0])/(a[i+1][0]-a[i][0]);
        return a[i][1]+t*(a[i+1][1]-a[i][1]);
      }
    }
    return NATL_2025;
  }
  function regionAging(base2025, yf){
    return base2025 * (natlAging(yf) / NATL_2025);
  }

  function yearFrac(date) {
    const d = date || new Date();
    const y = d.getFullYear();
    const start = new Date(y, 0, 1);
    const end = new Date(y + 1, 0, 1);
    return y + (d - start) / (end - start);
  }

  // 65歳以上=性比76.5(女多) / 15-64=103.3(男多) / 15歳未満=105.0
  function sexSplit(elderly, working, youth) {
    const eF = elderly * (100 / (100 + 76.5));       // 女
    const eM = elderly - eF;
    const wM = working * (103.3 / (100 + 103.3));     // 男
    const wF = working - wM;
    const yM = youth * (105.0 / (100 + 105.0));
    const yF = youth - yM;
    return { male: eM + wM + yM, female: eF + wF + yF };
  }

  // 地域オブジェクト + メタ → 今日の推計
  function estimateToday(region, meta, date) {
    const yf = yearFrac(date);
    const dt = yf - 2020;

    // 人口（千人）— 2020国勢を成長率で補外
    const popK = region.pop2020 * Math.pow(1 + region.growth / 100, dt);
    const pop = Math.round(popK * 1000);

    // 高齢化率（全国比率でスケール）・年少割合（微ドリフト）
    let aging = regionAging(region.aging, yf);
    let youth = region.youth + DRIFT.youth * (yf - 2025);
    aging = Math.min(50, Math.max(12, aging));
    youth = Math.min(20, Math.max(6, youth));
    const working = Math.max(0, 100 - aging - youth);

    const elderlyN = Math.round(pop * aging / 100);
    const youthN = Math.round(pop * youth / 100);
    const workingN = pop - elderlyN - youthN;

    const sx = sexSplit(elderlyN, workingN, youthN);

    // 労働人口（生産年齢 × 労働力率）
    const labor = Math.round(workingN * (meta.laborForceRate || 0.82));

    // 施設数 — 人口変動に平方根で追随（施設は人口ほど急には動かない）
    const popRatio = popK / region.pop2020;
    const facMul = Math.pow(popRatio, DRIFT.facDamp);
    const f = region.facilities;
    const facilities = {};
    Object.keys(f).forEach(k => { facilities[k] = Math.max(0, Math.round(f[k] * facMul)); });

    // 診療科目別（標榜・一般診療所ベース）
    const kamoku = {};
    Object.keys(meta.kamoku || {}).forEach(k => {
      kamoku[k] = Math.round(facilities.clinic * meta.kamoku[k]);
    });

    // 医療機関総数（病院＋一般診療所＋歯科）
    const medTotal = facilities.hospital + facilities.clinic + facilities.dental;

    // 人口あたり指標
    const per10k = (n) => pop > 0 ? +(n / pop * 10000).toFixed(2) : 0;

    return {
      yearFrac: yf,
      pop, popMale: Math.round(sx.male), popFemale: Math.round(sx.female),
      aging: +aging.toFixed(2), youth: +youth.toFixed(2), working: +working.toFixed(2),
      elderlyN, youthN, workingN, labor,
      facilities, kamoku, medTotal,
      per: {
        clinicPer10k: per10k(facilities.clinic),
        hospitalPer10k: per10k(facilities.hospital),
        kaigoPer10k: per10k(facilities.kaigo),
        pharmacyPer10k: per10k(facilities.pharmacy),
        shafukuPer10k: per10k(facilities.shafuku),
      },
    };
  }

  // 2000→現在 の推移系列（人口・高齢化率の推計）
  function trendSeries(region) {
    const pts = [];
    const nowYf = yearFrac();
    for (let y = 2000; y <= Math.floor(nowYf); y++) {
      const dt = y - 2020;
      const popK = region.pop2020 * Math.pow(1 + region.growth / 100, dt);
      let aging = Math.min(50, Math.max(8, regionAging(region.aging, y)));
      pts.push({ year: y, pop: Math.round(popK), aging: +aging.toFixed(1) });
    }
    // 末尾に「現在」点
    const dt = nowYf - 2020;
    const popK = region.pop2020 * Math.pow(1 + region.growth / 100, dt);
    let agingNow = Math.min(50, Math.max(8, regionAging(region.aging, nowYf)));
    pts.push({ year: +nowYf.toFixed(2), pop: Math.round(popK), aging: +agingNow.toFixed(1), now: true });
    return pts;
  }

  function fmt(n) { return n.toLocaleString('ja-JP'); }
  function fmtMan(n) { // 万人表記
    if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万';
    return fmt(n);
  }

  global.MacroEngine = { estimateToday, trendSeries, yearFrac, fmt, fmtMan };

})(typeof window !== 'undefined' ? window : globalThis);

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

    // 各エリアの実人口を分母にした「住民◯人あたり1施設」（10万対の固定分母は使わない）
    const rpf = (n) => n > 0 ? Math.round(pop / n) : 0;

    // 充足率：全国平均の「1人（介護は高齢者1人）あたり供給量」を100%とした比
    //  100%超＝全国平均より手厚い、100%未満＝全国平均より薄い
    const nat = meta.national || {};
    const natPop = (nat.pop2020 || 0) * 1000;
    const natEld = natPop * (nat.aging2025 || NATL_2025) / 100;
    const fillRate = (cnt, base, natCnt, natBase) => {
      if (!cnt || !base || !natCnt || !natBase) return 0;
      const loc = cnt / base, ntl = natCnt / natBase;
      return ntl > 0 ? Math.round(loc / ntl * 100) : 0;
    };
    const fill = {
      shafuku:  fillRate(facilities.shafuku,  pop,      nat.shafuku,  natPop),
      kaigo:    fillRate(facilities.kaigo,     elderlyN, nat.kaigo,    natEld),
      clinic:   fillRate(facilities.clinic,    pop,      nat.clinic,   natPop),
      hospital: fillRate(facilities.hospital,  pop,      nat.hospital, natPop),
      pharmacy: fillRate(facilities.pharmacy,  pop,      nat.pharmacy, natPop),
    };

    return {
      yearFrac: yf,
      pop, popMale: Math.round(sx.male), popFemale: Math.round(sx.female),
      aging: +aging.toFixed(2), youth: +youth.toFixed(2), working: +working.toFixed(2),
      elderlyN, youthN, workingN, labor,
      facilities, kamoku, medTotal, fill,
      per: {
        clinic: rpf(facilities.clinic),
        hospital: rpf(facilities.hospital),
        kaigo: rpf(facilities.kaigo),
        pharmacy: rpf(facilities.pharmacy),
        shafuku: rpf(facilities.shafuku),
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
      pts.push({ year: y, pop: Math.round(popK*1000), aging: +aging.toFixed(1) });
    }
    // 末尾に「現在」点
    const dt = nowYf - 2020;
    const popK = region.pop2020 * Math.pow(1 + region.growth / 100, dt);
    let agingNow = Math.min(50, Math.max(8, regionAging(region.aging, nowYf)));
    pts.push({ year: +nowYf.toFixed(2), pop: Math.round(popK*1000), aging: +agingNow.toFixed(1), now: true });
    return pts;
  }

  function fmt(n) { return n.toLocaleString('ja-JP'); }
  function fmtMan(n) {
    if (n >= 10000) return (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万';
    return fmt(n);
  }

  // 2000→現在 を隔年で。人口=実数(人)、増減=前回比(人)、背景=数字からの一般解釈（断定でない）
  function tableRows(region, step) {
    step = step || 1;
    var popAt = function (y) { return Math.round(region.pop2020 * Math.pow(1 + region.growth / 100, y - 2020) * 1000); };
    var agAt  = function (y) { return +Math.min(50, Math.max(8, regionAging(region.aging, y))).toFixed(1); };
    var nowYf = yearFrac();
    var nowY  = Math.floor(nowYf);

    // 対象年の配列（2000から隔年、現在は別途）
    var years = [];
    for (var y = 2000; y < nowY; y += step) years.push(y);
    if (years[years.length - 1] !== 2020 && 2020 <= nowY) { /* 2020は主要年なので必ず含める */ }
    if (years.indexOf(2020) === -1 && 2020 < nowY) years.push(2020);
    years.sort(function (a, b) { return a - b; });

    var rows = [], prev = null, prevAg = null;
    years.forEach(function (yy) {
      var pop = popAt(yy), ag = agAt(yy);
      var d = prev == null ? null : pop - prev;
      rows.push({ year: yy, pop: pop, aging: ag, delta: d, reason: reasonFor(yy, pop, prev, ag, prevAg, region) });
      prev = pop; prevAg = ag;
    });
    // 現在
    var popN = Math.round(region.pop2020 * Math.pow(1 + region.growth / 100, nowYf - 2020) * 1000);
    var agN  = +Math.min(50, Math.max(8, regionAging(region.aging, nowYf))).toFixed(1);
    rows.push({ year: '現在', pop: popN, aging: agN, delta: prev == null ? null : popN - prev, now: true,
                reason: reasonFor('現在', popN, prev, agN, prevAg, region) });
    return rows;
  }

  // 背景＝数字から推定される「理由」（社会減・自然減・産業・雇用など。一般的な機序であり特定の出来事の断定ではない）
  function reasonFor(year, pop, prev, ag, prevAg, region) {
    if (prev == null) return '基準年（2000年）。以降はこの年からの推計。';
    var dPop = pop - prev;
    var dPct = prev > 0 ? dPop / prev * 100 : 0;         // 前年比
    var dAg  = prevAg == null ? 0 : (ag - prevAg);
    var ind  = REGION_IND[region.region] || REGION_IND['関東'];
    var mag  = (dPop === 0) ? '増減なし'
             : (dPop > 0 ? '約' + Math.abs(dPop).toLocaleString('ja-JP') + '人増'
                         : '約' + Math.abs(dPop).toLocaleString('ja-JP') + '人減');
    var cause;
    if (dPct <= -0.8) {
      // 明確な減少：高齢化の段階で主因が変わる（社会減→自然減主導）
      if (ag >= 36)      cause = '高齢化が進み、死亡が出生を上回る自然減が主導。若年層の進学・就職に伴う転出超過も続くとみられる';
      else if (ag >= 30) cause = '若年層の転出超過に少子化が重なり、担い手世代が薄くなる減少と推定';
      else               cause = '進学・就職による若年層の域外流出（社会減）が主因の減少と推定';
      cause += '。' + ind.bad + 'も下押し';
    } else if (dPct <= -0.2) {
      cause = '転出超過と少子化によるゆるやかな減少と推定。' + ind.bad + 'が影を落とす';
    } else if (dPct < 0.2) {
      cause = '転入と転出がほぼ拮抗し横ばい。ただし自然減が始まりつつあると推定';
    } else if (dPct < 0.8) {
      cause = '雇用・生活利便の集積による転入がゆるやかな増加を支えると推定。' + ind.good + 'が寄与';
    } else {
      cause = '都市機能・雇用の集積で転入が続く増加と推定。' + ind.good + 'が牽引';
    }
    var agTail = dAg >= 0.8 ? '／高齢化も進行（+' + dAg.toFixed(1) + 'pt）'
               : (dAg <= -0.4 ? '／高齢化率は低下' : '');
    return cause + '（' + mag + agTail + '）。数字からの推定で、特定の出来事の断定ではない。';
  }

  // 複数地域を1つに束ねる（全国／地方ブロック／東西 用）
  //  list = pref または muni オブジェクト配列
  function aggregate(list, name, regionLabel) {
    var totPop = 0, wGrowth = 0, wAging = 0, wYouth = 0;
    var fac = { shafuku:0, hospital:0, clinic:0, dental:0, pharmacy:0, kaigo:0, tokuyo:0, roken:0 };
    list.forEach(function (r) {
      var p = r.pop2020 || 0;
      totPop += p; wGrowth += (r.growth || 0) * p; wAging += (r.aging || 0) * p; wYouth += (r.youth || 0) * p;
      var f = r.facilities || {};
      Object.keys(fac).forEach(function (k) { fac[k] += (f[k] || 0); });
    });
    var w = totPop > 0 ? totPop : 1;
    return {
      name: name, disp: name, level: 'agg', region: regionLabel || (list[0] && list[0].region) || '関東',
      pop2020: +totPop.toFixed(1), growth: +(wGrowth / w).toFixed(3),
      aging: +(wAging / w).toFixed(2), youth: +(wYouth / w).toFixed(2),
      facilities: fac,
    };
  }

  // 地方別の産業アーキタイプ（一般的傾向・解釈用）
  var REGION_IND = {
    '北海道': { base: '農業・酪農・水産・観光', good: '観光や食の産地としての強み、広い農地', bad: '一次産業の担い手不足、旧産炭地の縮小、冬季の雇用の細り' },
    '東北': { base: '稲作・果樹・製造業', good: '食料生産の集積、製造業の立地', bad: '若年層の都市流出、工場再編、豪雪地の生活コスト' },
    '関東': { base: '都市機能・商業・製造', good: '雇用と大学の集積、通勤圏の広がり', bad: '周縁部の空洞化、住居費の高さ' },
    '中部': { base: '自動車など製造業・農業', good: 'ものづくりの集積が雇用を支える', bad: '製造業の景気変動、山間部の過疎' },
    '近畿': { base: '都市・商業・工業', good: '都市圏の求心力、中小製造の厚み', bad: '内陸・北部の人口減、産業構造の転換' },
    '中国': { base: '瀬戸内工業・農業・造船', good: '臨海工業と農水産の両輪', bad: '基幹産業の再編、中山間・離島の過疎' },
    '四国': { base: '農業・水産・製造', good: '柑橘など特産、地場製造', bad: '人口流出と高齢化の先行、交通の不便' },
    '九州': { base: '農業・畜産・半導体・観光', good: '近年の半導体・企業立地、観光と食', bad: '離島・山間部の過疎、地域間の偏り' },
  };

  // 数字から読み取る「沿革・背景」解釈（事実の断定ではなく推計からの解釈）
  function narrative(region, e) {
    var rows = tableRows(region);
    var pop2000 = rows[0].pop, popNow = rows[rows.length - 1].pop;
    var chg = pop2000 > 0 ? (popNow - pop2000) / pop2000 * 100 : 0;
    var ind = REGION_IND[region.region] || REGION_IND['関東'];
    var g = region.growth, aging = e.aging;

    var popStory;
    if (g <= -1.0) popStory = '2000年以降、人口はおよそ' + Math.abs(chg).toFixed(0) + '%減少。進学・就職に伴う若年層の流出と出生数の減少が続き、地域の担い手が薄くなってきた。';
    else if (g <= -0.4) popStory = '人口はゆるやかに減少（約' + Math.abs(chg).toFixed(0) + '%）。転出と少子化が重なり、緩慢だが確かな縮小が進む。';
    else if (g < 0.2) popStory = '人口はおおむね横ばい。大きな流出は抑えられているが、自然減が始まっている。';
    else popStory = '人口は維持〜増加（約' + chg.toFixed(0) + '%）。雇用や都市機能の集積が流入を支えている。';

    var good = [], bad = [];
    good.push(ind.good + 'が地域の土台。');
    if (g > 0.2) good.push('雇用や生活利便の集積で、人口の流入・定着が進んだ。');
    if (aging < 27) good.push('高齢化は全国平均を下回り、現役層の比率が比較的厚い。');
    if (region.pop2020 >= 300) good.push('一定の人口規模があり、医療・介護・商業の選択肢が保たれやすい。');

    bad.push(ind.bad + '。');
    if (g <= -0.6) bad.push('若年層の流出が続き、産業の後継者と福祉の担い手が同時に細っている。');
    if (aging >= 34) bad.push('高齢化率が' + aging.toFixed(0) + '%に達し、支え手の減少が施設運営を圧迫しやすい。');
    if (region.pop2020 < 30) bad.push('人口規模が小さく、一つの施設・店舗の撤退が地域全体に響く。');

    var careStory;
    var ag2000 = rows[0].aging;
    if (aging >= 34) careStory = '高齢化率は' + ag2000 + '%（2000年）から' + aging.toFixed(0) + '%へ上昇。介護需要は急拡大した一方、生産年齢人口の減少で医療機関・介護事業所の維持そのものが課題になっている。訪問・通所を含めた広域での支え合いが要になる。';
    else if (aging >= 29) careStory = '高齢化は' + ag2000 + '%→' + aging.toFixed(0) + '%と全国並みに進行。医療・介護の需要は着実に増え、担い手確保と事業所の持続が論点になってきた。';
    else careStory = '高齢化率は全国平均を下回るものの、' + ag2000 + '%→' + aging.toFixed(0) + '%へ上昇。高齢者の絶対数は増えており、医療・介護の需要は今後さらに強まる。';

    return { rows: rows, popStory: popStory, good: good, bad: bad, careStory: careStory, industry: ind.base };
  }

  global.MacroEngine = { estimateToday, trendSeries, tableRows, narrative, aggregate, yearFrac, fmt, fmtMan };

})(typeof window !== 'undefined' ? window : globalThis);

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

  // 全国の総人口アンカー（2026までは実測：国勢調査＋推計、2030・2040は社人研 将来推計・中位, 千人）
  var NATIONAL_POP = [
    [2000,126926],[2005,127768],[2008,128084],[2010,128057],
    [2015,127095],[2020,126146],[2022,124947],[2024,123802],[2026,122600],
    [2030,119125],[2040,111284]
  ];
  // アンカー系列から任意年の人口（人）を線形補間／端は外挿
  function seriesPopAt(series, y){
    var a = series, n = a.length;
    if (y <= a[0][0]) { var s0=(a[1][1]-a[0][1])/(a[1][0]-a[0][0]); return Math.round((a[0][1]+s0*(y-a[0][0]))*1000); }
    for (var i=0;i<n-1;i++){ if (y>=a[i][0] && y<=a[i+1][0]){ var t=(y-a[i][0])/(a[i+1][0]-a[i][0]); return Math.round((a[i][1]+t*(a[i+1][1]-a[i][1]))*1000); } }
    var sN=(a[n-1][1]-a[n-2][1])/(a[n-1][0]-a[n-2][0]); return Math.round((a[n-1][1]+sN*(y-a[n-1][0]))*1000);
  }
  // 地域の任意年の人口（人）。popSeries があれば実データ系列、無ければ CAGR 補外。
  function regionPop(region, y){
    if (region.popSeries) return seriesPopAt(region.popSeries, y);
    return Math.round(region.pop2020 * Math.pow(1 + region.growth / 100, y - 2020) * 1000);
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

    // 人口（人）— popSeries があれば実データ、無ければ2020国勢を成長率で補外
    const pop = regionPop(region, yf);
    const popRatio = region.pop2020 > 0 ? pop / (region.pop2020 * 1000) : 1;

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
    const facMul = Math.pow(popRatio, DRIFT.facDamp);
    const f = region.facilities;
    const facilities = {};
    Object.keys(f).forEach(k => { facilities[k] = Math.max(0, Math.round(f[k] * facMul)); });
    // 医療施設調査の実数があれば病院・一般診療所を上書き（存在時のみ・無ければ按分推計のまま）
    if (region.real) {
      if (region.real.hospital != null) facilities.hospital = region.real.hospital;
      if (region.real.clinic   != null) facilities.clinic   = region.real.clinic;
    }

    // 診療科目別（標榜・一般診療所ベース）
    const kamoku = {};
    Object.keys(meta.kamoku || {}).forEach(k => {
      kamoku[k] = Math.round(facilities.clinic * meta.kamoku[k]);
    });

    // 医療機関総数（病院＋一般診療所。歯科は別項目）
    const medTotal = facilities.hospital + facilities.clinic;

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
      dental:   fillRate(facilities.dental,    pop,      nat.dental,   natPop),
    };

    // 要介護・要支援認定者（介護度別・推計）：65歳以上×全国認定率19.4%を、全国の介護度別割合で按分
    const CARE_RATE = 0.194;
    const CARE_SHARE = { '要支援1':0.138, '要支援2':0.137, '要介護1':0.206, '要介護2':0.168, '要介護3':0.133, '要介護4':0.129, '要介護5':0.089 };
    const careTotal = Math.round(elderlyN * CARE_RATE);
    const careLevels = {};
    Object.keys(CARE_SHARE).forEach(function (k) { careLevels[k] = Math.round(careTotal * CARE_SHARE[k]); });
    const care = { total: careTotal, rate: CARE_RATE, levels: careLevels };

    // 介護施設ベッド数（推計）＝特養×平均定員＋老健×平均定員（介護医療院は少数のため特養・老健で近似）
    const AVG_TOKUYO = 75, AVG_ROKEN = 86;   // 全国平均定員（介護サービス施設・事業所調査ベースの概算）
    const careBeds = Math.round(facilities.tokuyo * AVG_TOKUYO + facilities.roken * AVG_ROKEN);
    const natCareBeds = (nat.tokuyo || 0) * AVG_TOKUYO + (nat.roken || 0) * AVG_ROKEN;
    const natCareTotal = natEld * CARE_RATE;   // 全国の要介護等認定者（推計）
    // 介護施設ベッド充足率：要介護等認定者1人あたりの施設ベッド数を全国平均=100で比較
    fill.kaigoBed = fillRate(careBeds, careTotal, natCareBeds, natCareTotal);

    return {
      yearFrac: yf,
      pop, popMale: Math.round(sx.male), popFemale: Math.round(sx.female),
      aging: +aging.toFixed(2), youth: +youth.toFixed(2), working: +working.toFixed(2),
      elderlyN, youthN, workingN, labor,
      facilities, kamoku, medTotal, fill, care, careBeds,
      per: {
        clinic: rpf(facilities.clinic),
        hospital: rpf(facilities.hospital),
        kaigo: rpf(facilities.kaigo),
        pharmacy: rpf(facilities.pharmacy),
        shafuku: rpf(facilities.shafuku),
        dental: rpf(facilities.dental),
      },
    };
  }

  // 2000→現在→2040 の推移系列（現在以降は予測 future:true）
  function trendSeries(region, toYear) {
    toYear = toYear || 2040;
    const pts = [];
    const nowYf = yearFrac();
    const nowY = Math.floor(nowYf);
    for (let y = 2000; y <= nowY; y++) {
      let aging = Math.min(50, Math.max(8, regionAging(region.aging, y)));
      pts.push({ year: y, pop: regionPop(region, y), aging: +aging.toFixed(1) });
    }
    // 「現在」点
    let agingNow = Math.min(50, Math.max(8, regionAging(region.aging, nowYf)));
    pts.push({ year: +nowYf.toFixed(2), pop: regionPop(region, nowYf), aging: +agingNow.toFixed(1), now: true });
    // 将来（予測）
    for (let y = nowY + 1; y <= toYear; y++) {
      let aging = Math.min(50, Math.max(8, regionAging(region.aging, y)));
      pts.push({ year: y, pop: regionPop(region, y), aging: +aging.toFixed(1), future: true });
    }
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
    var popAt = function (y) { return regionPop(region, y); };
    var agAt  = function (y) { return +Math.min(50, Math.max(8, regionAging(region.aging, y))).toFixed(1); };
    var nowYf = yearFrac();
    var nowY  = Math.floor(nowYf);

    var years = [];
    for (var y = 2000; y < nowY; y += step) years.push(y);
    if (years.indexOf(2020) === -1 && 2020 < nowY) years.push(2020);
    years.sort(function (a, b) { return a - b; });

    // 数値行を先に作る（過去〜現在）
    var rows = years.map(function (yy) { return { year: yy, pop: popAt(yy), aging: agAt(yy) }; });
    rows.push({ year: '現在', pop: regionPop(region, nowYf),
                aging: +Math.min(50, Math.max(8, regionAging(region.aging, nowYf))).toFixed(1), now: true });
    // 将来（予測）: 現在の翌年〜2040年
    for (var fy = nowY + 1; fy <= 2040; fy += step) rows.push({ year: fy, pop: popAt(fy), aging: agAt(fy), future: true });
    for (var i = 0; i < rows.length; i++) rows[i].delta = i === 0 ? null : rows[i].pop - rows[i - 1].pop;

    // 背景は「トピックのある年だけ」：局面が変わった年＋節目（しきい値到達）＋検証済み史実の年（他は空欄）
    var prevKey = null, base2000 = rows[0].pop;
    rows.forEach(function (r, i) {
      var yNum = (typeof r.year === 'number') ? r.year : null;
      var note = '';
      if (i === 0) { note = '基準年（2000年）。以降はこの年からの推計。'; prevKey = phaseKey(r, null, region).key; }
      else {
        var pr = rows[i - 1];
        var pk = phaseKey(r, pr, region);
        if (pk.key !== prevKey) { note = pk.text; prevKey = pk.key; }   // 局面が変わった年だけ機序を書く
        // 節目（しきい値の到達）＝実質的な交差点
        var ms = [];
        [30, 35, 40].forEach(function (th) { if (pr.aging < th && r.aging >= th) ms.push('高齢化率が' + th + '%を突破（老年人口が' + (th/10) + '割超に）'); });
        var c = (r.pop - base2000) / base2000 * 100, cp = (pr.pop - base2000) / base2000 * 100;
        [-10, -20, -30].forEach(function (th) { if (cp > th && c <= th) ms.push('人口が2000年比 約' + Math.abs(th) + '%減に到達'); });
        [10, 20].forEach(function (th) { if (cp < th && c >= th) ms.push('人口が2000年比 約' + th + '%増に到達'); });
        if (ms.length) note = (note ? note + ' ' : '') + '【節目】' + ms.join('／') + '。';
      }
      var ev = yNum != null ? eventFor(yNum, region) : '';
      if (ev) note = note ? (note + ' ' + ev.trim()) : ev.trim();
      r.reason = note;   // トピックが無ければ空欄
    });
    return rows;
  }

  // 局面キー＋その局面の説明（地方産業＋その地域自身の増減率・高齢化段階で決まる＝地域ごとに変わる）
  function phaseKey(r, prev, region) {
    var ind  = REGION_IND[region.region] || REGION_IND['関東'];
    var dPct = (prev && prev.pop > 0) ? (r.pop - prev.pop) / prev.pop * 100 : 0;
    var ag   = r.aging;
    var bucket = dPct <= -0.8 ? 'down2' : dPct <= -0.2 ? 'down1' : dPct < 0.2 ? 'flat' : dPct < 0.8 ? 'up1' : 'up2';
    var band   = ag >= 36 ? 'a3' : ag >= 30 ? 'a2' : 'a1';
    var key = bucket + (bucket === 'down2' ? ('/' + band) : '');
    var text;
    if (bucket === 'down2') {
      if (band === 'a3')      text = '高齢化が進み、死亡が出生を上回る自然減が主導する局面に。若年層の転出超過も続く。';
      else if (band === 'a2') text = '若年層の転出超過に少子化が重なり、担い手世代が薄くなる減少局面に。';
      else                    text = '進学・就職による若年層の域外流出（社会減）が主因の減少局面に。';
      text += ind.bad + 'も下押し。';
    } else if (bucket === 'down1') { text = '転出超過と少子化によるゆるやかな減少局面へ。' + ind.bad + 'が影を落とす。'; }
    else if (bucket === 'flat')    { text = '転入と転出がほぼ拮抗する横ばい局面。自然減が始まりつつある。'; }
    else if (bucket === 'up1')     { text = '雇用・生活利便の集積による転入がゆるやかな増加を支える局面。地域の強み（' + ind.good + '）も後押し。'; }
    else                           { text = '都市機能・雇用の集積で転入が続く増加局面。地域の強み（' + ind.good + '）が背景。'; }
    return { key: key, text: text + '（数字からの推定・断定でない）' };
  }

  // ── 検証済みの「史実」イベント（実在の出来事。推定ではなく事実） ──
  // 全国的な出来事（年→背景）。出典：総務省人口推計・各府省白書 等。
  var NATIONAL_EVENTS = {
    2008: 'この年、日本の総人口が約1億2,808万人でピークに達し、以降の減少局面へ。リーマン・ショック（世界金融危機）で景気が急速に悪化した年でもある。',
    2009: 'リーマン・ショックの影響で景気後退（GDPマイナス成長）。雇用悪化が地方の転出・出生減に波及した時期。',
    2011: '東日本大震災（3月11日）と福島第一原発事故が発生。被災地の人口が大きく動き、全国的にも人口減少が本格化（2011年以降、総人口は連続して減少）。',
    2020: '新型コロナウイルス感染拡大が始まった年。婚姻・出生の減少、入国制限による社会増の縮小で人口減が加速。',
    2021: 'コロナ禍が続き、出生数の減少と超過死亡で人口減が加速。',
    2022: 'コロナ禍3年目。出生数がさらに減少し、全国の人口減少幅が拡大。'
  };
  // 原発事故（2011）で避難指示区域となり人口が激減した福島の自治体
  var FUK_FULL = { 2011: '福島第一原発事故により避難指示区域となり、全域または大部分で住民が避難。人口が激減した。' };
  var FUK_PART = { 2011: '福島第一原発事故により一部が避難指示区域となり、住民が避難。人口が大きく減った。' };
  // 地域固有の出来事（自治体名→{年:背景}）。検証できた史実のみを掲載。
  var LOCAL_EVENTS = {
    '夕張市': { 2006: '財政破綻を表明（隠れ借金・不適正な財務処理で負債は約353億円）。', 2007: '全国初の「財政再生団体」に指定。行政サービス縮小・住民負担増で若年層・子育て世代の流出が加速し、人口減が全国有数の速さに。かつて炭鉱で約12万人だった人口は大きく減少。' },
    '双葉町': FUK_FULL, '大熊町': FUK_FULL, '浪江町': FUK_FULL, '富岡町': FUK_FULL, '楢葉町': FUK_FULL, '葛尾村': FUK_FULL, '飯舘村': FUK_FULL,
    '南相馬市': FUK_PART, '川内村': FUK_PART, '広野町': FUK_PART, '田村市': FUK_PART, '川俣町': FUK_PART
  };
  function eventFor(year, region) {
    if (typeof year !== 'number') return '';
    var out = [];
    var loc = region && LOCAL_EVENTS[region.name];
    if (loc && loc[year]) out.push('【この地域の出来事（史実）】' + loc[year]);
    if (NATIONAL_EVENTS[year]) out.push('【この年の全国的な出来事（史実）】' + NATIONAL_EVENTS[year]);
    return out.length ? ' ' + out.join(' ') : '';
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

  /* ============================================================
     投資家スクリーニング（独自推計・仮説モデル）
     4軸：需要 D × 供給空白 S × 承継母数 R × 産業再生余地 I
     → 投資機会スコア（幾何平均・0〜100）。「どこから入るか」を採点する。
     いずれも公式アンカーを人口按分した推計で、断定ではない。
     ============================================================ */
  function clamp01(x){ return x < 0 ? 0 : x > 1 ? 1 : x; }
  // v を [lo,hi] で 0〜100 に正規化。hi<lo を渡せば反転（小さいほど高い）。
  function nz(v, lo, hi){ if (hi === lo) return 0; return clamp01((v - lo) / (hi - lo)) * 100; }

  // 供給空白：region.real があれば実データを優先し、無ければ代理指標（推計）にフォールバック。
  //   src で各項目が 'real' か 'est' かを返す（UIのバッジ切替に使用）。
  function supplyGap(region, e, meta){
    var nat = meta.national || {};
    var natPop = (nat.pop2020 || 0) * 1000;
    var natEld = natPop * (nat.aging2025 || NATL_2025) / 100;
    var R = region.real || {};
    var src = {};
    // 病床：実数（医療施設調査）優先／無ければ 病院数×全国平均病床186
    var AVG_HOSP_BEDS = 186;
    var bedsReal = (R.beds != null);
    var beds = bedsReal ? R.beds : Math.round(e.facilities.hospital * AVG_HOSP_BEDS);
    src.beds = bedsReal ? 'real' : 'est';
    var natBeds = (nat.hospital || 0) * AVG_HOSP_BEDS;
    var bedsPerEld = (beds > 0 && e.elderlyN > 0) ? Math.round(e.elderlyN / beds) : 0;
    var bedsFill = (beds > 0 && natBeds > 0 && e.elderlyN > 0)
      ? Math.round((beds / e.elderlyN) / (natBeds / natEld) * 100) : 0;
    // 在宅療養支援診療所：実数優先／無ければ 一般診療所の約14%
    var zaiReal = (R.zaishien != null);
    var zaishien = zaiReal ? R.zaishien : Math.round(e.facilities.clinic * 0.14);
    src.zaishien = zaiReal ? 'real' : 'est';
    var natZai = Math.round((nat.clinic || 0) * 0.14);
    var zaishienFill = (natZai > 0 && e.elderlyN > 0)
      ? Math.round((zaishien / e.elderlyN) / (natZai / natEld) * 100) : 0;
    // 訪問看護ST：実数優先／無ければ 介護事業所の約6.5%
    var houReal = (R.houkan != null);
    var houkan = houReal ? R.houkan : Math.round(e.facilities.kaigo * 0.065);
    src.houkan = houReal ? 'real' : 'est';
    // 救急：実データ（各県 救急告示）優先。無ければ救急空白リスク（代理指標）を推計。
    var er2 = (R.er2 != null) ? R.er2 : null;
    var er3 = (R.er3 != null) ? R.er3 : null;
    var erReal = (er2 != null || er3 != null);
    src.er = erReal ? 'real' : 'est';
    // 救急空白リスク（代理指標・0〜100）：住民あたり病院が薄い×小規模×高齢ほど救急アクセスが空白＝参入余地
    var hospThin = nz(e.per.hospital, 15000, 90000);
    var erRisk = Math.round(0.50 * hospThin + 0.30 * nz(region.pop2020 || 0, 80, 4) + 0.20 * nz(e.aging, 30, 44));
    // 無医地区リスク：実データ（無医地区等調査）があれば存在・地区数で構成／無ければ代理指標
    var clinicSparse = nz(e.per.clinic, 900, 3200);
    var smallPop = nz(region.pop2020 || 0, 60, 3);
    var aged = nz(e.aging, 30, 44);
    var proxy = 0.45 * clinicSparse + 0.30 * smallPop + 0.25 * aged;
    var muiReal = (R.mui != null || R.junmui != null);
    var muiN = (R.mui != null) ? R.mui : null;
    var junmui = (R.junmui != null) ? R.junmui : null;
    var muiRisk;
    if (muiReal) {
      // 無医地区が有れば下限を引き上げ、地区数で加算（準無医は半掛け）
      var cnt = (muiN || 0) + 0.5 * (junmui || 0);
      muiRisk = Math.round(Math.min(100, Math.max(proxy, 45 + nz(cnt, 0, 6))));
    } else {
      muiRisk = Math.round(proxy);
    }
    src.mui = muiReal ? 'real' : 'est';
    return { beds: beds, bedsPerEld: bedsPerEld, bedsFill: bedsFill,
             zaishien: zaishien, zaishienFill: zaishienFill, houkan: houkan,
             muiRisk: muiRisk, mui: muiN, junmui: junmui, muiReal: muiReal,
             er2: er2, er3: er3, erReal: erReal, erRisk: erRisk, src: src };
  }

  // 承継母数（ロールアップ）：社福が細分化・小規模・後継難ほど厚い
  function successionPool(region, e, meta){
    var nat = meta.national || {};
    var natPop = (nat.pop2020 || 0) * 1000;
    var natEld = natPop * (nat.aging2025 || NATL_2025) / 100;
    var shafuku = e.facilities.shafuku;
    // 分散度：高齢者あたり社福が全国比で多い＝細分化＝束ねる母数が厚い
    var natShaPerEld = natEld > 0 ? (nat.shafuku || 0) / natEld : 0;
    var locShaPerEld = e.elderlyN > 0 ? shafuku / e.elderlyN : 0;
    var disperse = natShaPerEld > 0 ? nz(locShaPerEld / natShaPerEld, 0.7, 1.8) : 0;
    // 規模：1法人あたりの高齢者数の目安（小さい＝小規模＝承継しやすい／後継難）
    var eldPerSha = shafuku > 0 ? Math.round(e.elderlyN / shafuku) : 0;
    var smallScale = shafuku > 0 ? nz(eldPerSha, 5000, 800) : 0;   // 5000人/法人→0(大), 800→100(小)
    // 承継圧力：高齢化＝経営者の高齢化・後継難
    var pressure = nz(e.aging, 30, 44);
    var score = Math.round(0.42 * disperse + 0.33 * smallScale + 0.25 * pressure);
    var bucket = eldPerSha === 0 ? '—' : (eldPerSha >= 3000 ? '大' : eldPerSha >= 1500 ? '中' : '小');
    return { shafuku: shafuku, eldPerSha: eldPerSha, disperse: Math.round(disperse),
             smallScale: Math.round(smallScale), score: score, bucket: bucket };
  }

  // 産業再生余地：region.real に実額（農業産出額・漁業・観光宿泊）があれば実額ベース、
  //   無ければ従来の素地代理指標（地方アーキタイプ×過疎度×担い手流出）にフォールバック。
  function industryPotential(region, e){
    var ind = REGION_IND[region.region] || REGION_IND['関東'];
    var R = region.real || {};
    var haveReal = (R.agri != null || R.fishery != null || R.tourism != null);
    if (haveReal) {
      var popTh = (region.pop2020 || 0);                     // 千人
      var prodPer = popTh > 0 ? ((R.agri || 0) + (R.fishery || 0)) / popTh : 0; // 百万円/千人
      var tourPer = popTh > 0 ? (R.tourism || 0) / popTh : 0;                    // 千人泊/千人
      var prodScore = nz(prodPer, 20, 1200);                 // 住民千人あたり一次産業産出額
      var tourScore = nz(tourPer, 0, 3000);
      var rural = nz(region.pop2020 || 0, 60, 3);
      var loss = nz(-(region.growth || 0), 0.2, 1.6);
      var score = Math.round(0.46 * prodScore + 0.18 * tourScore + 0.18 * rural + 0.18 * loss);
      return { archetype: ind.base, good: ind.good, prim: Math.round(prodScore),
               score: Math.min(100, score), real: true,
               agri: (R.agri != null ? R.agri : null),
               fishery: (R.fishery != null ? R.fishery : null),
               tourism: (R.tourism != null ? R.tourism : null) };
    }
    var primaryWeight = { '北海道':95,'東北':82,'四国':80,'九州':78,'中国':70,'中部':55,'近畿':40,'関東':30 };
    var prim = primaryWeight[region.region] != null ? primaryWeight[region.region] : 55;
    var rural = nz(region.pop2020 || 0, 60, 3);              // 小規模ほど高
    var loss = nz(-(region.growth || 0), 0.2, 1.6);          // 人口減が速いほど高
    var workingThin = nz(e.working, 62, 48);                 // 生産年齢が薄いほど高
    var score = Math.round(0.34 * prim + 0.26 * rural + 0.20 * loss + 0.20 * workingThin);
    // 基幹産業の規模感（推計・0〜100）＝地方アーキタイプの一次産業ウェイト × 人口の裾野
    var popIdx = nz(region.pop2020 || 0, 3, 200);
    var sizeIdx = Math.round(0.5 * prim + 0.5 * popIdx);
    var sizeBucket = sizeIdx >= 66 ? '大きめ' : (sizeIdx >= 40 ? '中程度' : '小さめ');
    return { archetype: ind.base, good: ind.good, prim: prim, score: Math.min(100, score),
             real: false, sizeIdx: sizeIdx, sizeBucket: sizeBucket };
  }

  // 投資機会スコア（4軸の幾何平均 × 需要規模の実効係数）
  function investScore(region, e, meta){
    var sg = supplyGap(region, e, meta);
    var sp = successionPool(region, e, meta);
    var ip = industryPotential(region, e);
    var ag2040 = Math.min(50, Math.max(12, regionAging(region.aging, 2040)));
    // D 需要（強度＝高齢化率 ／ 持続＝2040高齢化 ／ 規模＝要介護認定者[log]）
    var intensity = nz(e.aging, 24, 44);
    var durab = nz(ag2040, 28, 48);
    var size = nz(Math.log10(Math.max(1, e.care.total)), 2.3, 5.3);
    var D = Math.round(0.42 * intensity + 0.28 * durab + 0.30 * size);
    // S 供給空白（充足率が全国比で薄い＝高い ＋ 無医地区 ＋ 救急空白）
    var thin = function(fill){ return nz(fill == null ? 100 : fill, 130, 55); };
    var erGap = sg.erReal ? nz((sg.er2 || 0) + (sg.er3 || 0) * 1.5, 3, 0) : sg.erRisk;
    var S = Math.round(0.26 * thin(sg.bedsFill) + 0.24 * thin(e.fill.kaigoBed) +
                       0.18 * thin(e.fill.clinic) + 0.16 * sg.muiRisk + 0.16 * erGap);
    var R = sp.score;      // 承継母数
    var I = ip.score;      // 産業再生余地
    // 需要が極端に小さい所は緩やかに減点（0.6〜1.0）
    var viability = 0.6 + 0.4 * (nz(Math.log10(Math.max(1, e.care.total)), 1.8, 3.3) / 100);
    var cc = function(x){ return Math.max(2, Math.min(100, x)); };
    var gm = Math.pow(cc(D) * cc(S) * cc(R) * cc(I), 0.25);
    var total = Math.round(gm * viability);
    return { total: total, D: cc(D), S: cc(S), R: cc(R), I: cc(I),
             sg: sg, sp: sp, ip: ip, ag2040: +ag2040.toFixed(1) };
  }

  global.MacroEngine = { estimateToday, trendSeries, tableRows, narrative, aggregate, regionPop, NATIONAL_POP, yearFrac, fmt, fmtMan,
                         supplyGap, successionPool, industryPotential, investScore };

})(typeof window !== 'undefined' ? window : globalThis);

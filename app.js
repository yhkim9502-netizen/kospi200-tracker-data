const CSS = getComputedStyle(document.documentElement);
const C = (n) => CSS.getPropertyValue(n).trim();
const COL = { fut: C("--fut"), call: C("--call"), put: C("--put"),
  idx: C("--idx"), basis: C("--basis"), muted: C("--muted"), line: C("--line"),
  pcval: C("--pcval"), pcoi: C("--pcoi"), pcvol: C("--pcvol") };

Chart.defaults.color = COL.muted;
Chart.defaults.borderColor = COL.line;
Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

const fmtD = (s) => s ? `${s.slice(4,6)}/${s.slice(6,8)}` : "";
const nf = (x, d=0) => x==null ? "—" : Number(x).toLocaleString("ko-KR",{maximumFractionDigits:d,minimumFractionDigits:d});
const sign = (x, d=0) => x==null ? "—" : (x>=0?"+":"") + nf(x,d);

// 공개 데이터 저장소의 최신 dashboard.json (매일 EOD 실행이 이 저장소로 push).
// 방문 시마다 여기서 최신 데이터를 읽어오고, 실패 시 로컬/번들 스냅샷으로 폴백.
const REMOTE_DATA_URL =
  "https://raw.githubusercontent.com/yhkim9502-netizen/kospi200-tracker-data/master/dashboard.json";

async function loadData() {
  // 우선순위: (1) 공개 저장소 raw(매일 EOD 실행이 여기로 push) →
  //           (2) 같은 출처(S3) 번들 스냅샷 → (3) 로컬 Express API.
  // 토큰 절감을 위해 매일 사이트를 재배포하지 않으므로, 방문 시마다
  // 공개 저장소의 최신 dashboard.json 을 우선 읽어온다. raw CDN 엣지
  // 캐시가 잠깐 지연될 수 있어 실패/구버전 시 번들 스냅샷으로 폴백한다.
  const remote = `${REMOTE_DATA_URL}?t=${Date.now()}`;
  const fallback = [
    `dashboard.json?v=${Date.now()}`,
    "/api/dashboard",
  ];
  const tryFetch = async (url) => {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return null;
      const j = await r.json();
      return (j && j.series) ? j : null;
    } catch (e) { return null; }
  };
  // 최신성 판단 키: meta.generated_at(있으면) → meta.as_of → 최신 series 날짜.
  const freshness = (j) => {
    const m = j && j.meta || {};
    if (m.generated_at) return String(m.generated_at);
    if (m.as_of) return String(m.as_of);
    const dt = j && j.series && j.series.date;
    return (dt && dt.length) ? String(dt[dt.length - 1]) : "";
  };
  // 원격 raw 우선 시도. 단, raw CDN 엣지 캐시가 지연되어 구버전을 줄 수
  // 있으므로 번들 스냅샷도 함께 받아 더 최신인 쪽을 채택한다.
  const remoteJ = await tryFetch(remote);
  const bundledJ = await tryFetch(fallback[0]);
  if (remoteJ && bundledJ) {
    const fr = freshness(remoteJ), fb = freshness(bundledJ);
    if (fb > fr) return bundledJ;
    if (fr > fb) return remoteJ;
    // 날짜 동률: 더 풍부한 레이어를 가진 쪽을 선호한다.
    //  1순위) 유효 ATM IV 레이어 개수(stock_futures.*.options.atm.has === true)
    //  2순위) stock_futures 존재 여부(하위호환)
    // 동률이면 원격을 유지(원격 우선 정책).
    const atmCount = (j) => {
      const sf = j && j.stock_futures;
      if (!sf) return 0;
      return Object.values(sf).reduce((n, s) =>
        n + ((s && s.options && s.options.atm && s.options.atm.has === true) ? 1 : 0), 0);
    };
    const rich = (j) => [atmCount(j), (j && j.stock_futures) ? 1 : 0];
    const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);   // 사전식 비교
    return (cmp(rich(bundledJ), rich(remoteJ)) > 0) ? bundledJ : remoteJ;
  }
  if (remoteJ) return remoteJ;
  if (bundledJ) return bundledJ;
  // 마지막 폴백: 로컬 Express API
  return await tryFetch(fallback[1]);
}

async function main() {
  const data = await loadData();
  if (!data) {
    document.getElementById("narrative").textContent = "데이터를 불러오지 못했습니다.";
    return;
  }
  render(data);
}

function render(d) {
  const s = d.series, L = d.latest, m = d.meta;
  const labels = s.date.map(fmtD);

  // header
  document.getElementById("cycle").textContent =
    `${fmtD(m.expiry)} 만기 이후 (${m.rows}영업일)`;
  const badge = document.getElementById("srcBadge");
  if (m.source === "krx_live") { badge.textContent = "KRX 실시간"; badge.className = "badge live"; }
  else { badge.textContent = "샘플 데이터"; badge.className = "badge sample";
    const note = document.getElementById("dataNote");
    note.style.display = "block";
    note.innerHTML = "현재 <b>샘플 데이터</b>로 표시 중입니다. KRX Open API의 3개 서비스(KOSPI 시리즈 일별시세, 선물 일별매매정보, 옵션 일별매매정보) 이용신청이 승인되면 자동으로 실데이터로 전환됩니다.";
  }
  document.getElementById("asof").textContent = "기준: " + fmtD(L.date);
  document.getElementById("narrative").textContent = d.narrative;

  // Directional insight
  renderDirectional(d.directional);

  // KPIs — 거래대금 P/C 를 핵심 동행 지표로 최상단 강조.
  const kpis = [
    { label: "거래대금 풋/콜 (동행)", val: nf(L.pc_ratio_val,2),
      cls: L.pc_ratio_val>=1.1?"down":(L.pc_ratio_val<=0.9?"up":""),
      chg: (L.call_val_eok!=null && L.put_val_eok!=null)
        ? `콜 ${nf(L.call_val_eok)} / 풋 ${nf(L.put_val_eok)} 억원` : "" },
    { label: "KOSPI 200 (현물)", val: nf(L.index_close,2) },
    { label: "선물 종가", val: nf(L.fut_close,2) },
    { label: "베이시스", val: sign(L.basis,2)+"p", cls: L.basis>=0?"up":"down" },
    { label: "선물 미결제약정", val: nf(L.fut_oi), chg: `${sign(L.fut_oi_chg)} 계약` },
    { label: "풋/콜 비율 (OI, 참고)", val: nf(L.pc_ratio_oi,2),
      cls: L.pc_ratio_oi>=1.15?"down":(L.pc_ratio_oi<=0.87?"up":"") },
  ];
  document.getElementById("kpis").innerHTML = kpis.map(k=>`
    <div class="card kpi">
      <div class="label">${k.label}</div>
      <div class="val ${k.cls||""}">${k.val}</div>
      ${k.chg?`<div class="chg">${k.chg}</div>`:""}
    </div>`).join("");

  renderAlerts(d);

  drawCharts(d, s, labels);

  // 개별종목 파생 분석 섹션 (KOSPI200 블록 이후, 삼성전자 → SK하이닉스 순)
  const hasInsights = d.stock_insights && Object.keys(d.stock_insights).length;
  const hasStockFut = d.stock_futures && Object.keys(d.stock_futures).length;
  if (hasInsights) {
    document.getElementById("stkInsightCard").style.display = "block";
    renderStockInsights(d.stock_insights, d.stock_futures || {});
  }
  if (hasStockFut) {
    document.getElementById("stkCard").style.display = "block";
    setupStockFutures(d.stock_futures);
  }
  const secStocks = document.getElementById("secStocks");
  if (secStocks) secStocks.style.display = (hasInsights || hasStockFut) ? "" : "none";
}

function positioningHTML(pos, key) {
  if (!pos) return "";
  const fr = pos.front || {};
  const am = pos.all_month || {};
  const ra = pos.rollover_adjusted || {};
  const invF = pos.investor_futures || {};
  const invO = pos.investor_options || {};
  const rows = [];
  rows.push(`<div class="pos-row"><span class="pos-lb">근월물 OI</span>`
    + `<span class="pos-v">${nf(fr.oi)} <em>(${sign(fr.oi_chg)})</em>`
    + `${fr.month ? ` · ${fr.month}` : ""}</span></div>`);
  if (am.available) {
    rows.push(`<div class="pos-row"><span class="pos-lb">전체 월물 합산 OI</span>`
      + `<span class="pos-v">${nf(am.oi)} <em>(${sign(am.oi_chg)})</em>`
      + ` · ${nf(am.n_contracts)}개 계약월</span></div>`);
    rows.push(`<div class="pos-row"><span class="pos-lb">롤오버조정 순OI</span>`
      + `<span class="pos-v">${sign(ra.net_oi_chg)}`
      + ` <em>(롤전환 ${sign(ra.roll_transfer)})</em></span></div>`);
  } else {
    rows.push(`<div class="pos-row pos-na"><span class="pos-lb">전체 월물 합산 · 롤오버조정</span>`
      + `<span class="pos-v">데이터 없음(과거 캐시 미보유)</span></div>`);
  }
  const invLine = (lbl, blk) =>
    `<div class="pos-row pos-na"><span class="pos-lb">${lbl}</span>`
    + `<span class="pos-v">${blk.available ? "제공" : "미제공"}</span></div>`;
  // 옵션 투자자별은 여전히 미제공(공개 소스 없음).
  rows.push(invLine("옵션 투자자별 수급", invO));
  return `<div class="pos-block"><div class="pos-cap">📊 포지셔닝(실데이터)</div>`
    + rows.join("")
    + investorFuturesHTML(invF, key)
    + `</div>`;
}

// 업로드 엑셀 기반 단일주식선물 투자자별 순매수 표. 현재/전일/5D/20D + 외국인 누적.
// 색상은 순매수(+, 강세측) 초록 / 순매도(−) 빨강. 미제공/구소스는 honest 미제공 행.
function investorFuturesHTML(invF, key) {
  if (!invF || !invF.available) {
    return `<div class="pos-row pos-na"><span class="pos-lb">선물 투자자별 수급</span>`
      + `<span class="pos-v">미제공</span></div>`;
  }
  const invs = [["외국인", "foreign"], ["기관", "inst"],
                ["개인", "indiv"], ["기타법인", "other_corp"]];
  const cur = invF.current || {}, prev = invF.previous || {};
  const w = invF.windows || {}, d5 = w.d5 || {}, d20 = w.d20 || {};
  const cell = (x) => `<td class="${x > 0 ? "iv-pos" : x < 0 ? "iv-neg" : ""}">${sign(x)}</td>`;
  const ul = invF.unit_label || "백만원";
  const head = `<tr><th>투자자</th><th>당일</th><th>전일</th><th>5일</th><th>20일</th></tr>`;
  const body = invs.map(([lb, k]) =>
    `<tr><td class="iv-lb">${lb}</td>${cell(cur[k])}${cell(prev[k])}`
    + `${cell(d5[k])}${cell(d20[k])}</tr>`).join("");
  const cum = (invF.cumulative || {});
  const stale = invF.stale
    ? `<span class="iv-stale" title="파생 기준일과 불일치">stale · ${invF.lag_days}일 지연</span>`
    : `<span class="iv-fresh">최신</span>`;
  const note = `${invF.scope_note || "업로드 자료 기준 · 월물 범위 미표기 · 순매수 거래대금(백만원)"}`
    + ` · 출처 ${invF.source === "uploaded_excel" ? "업로드 Excel" : (invF.source || "")}`
    + ` · 기준일 ${fmtD(invF.as_of)} ${stale}`;
  const cumLine = cum.foreign == null ? "" :
    `<div class="iv-cum">외국인 누적 순매수 거래대금(${fmtD(cum.since)}~): `
    + `<em class="${cum.foreign > 0 ? "iv-pos" : cum.foreign < 0 ? "iv-neg" : ""}">${sign(cum.foreign)}</em> ${ul}</div>`;
  return `<div class="inv-fut"><div class="inv-cap">선물 투자자별 순매수 거래대금(${ul})</div>`
    + `<table class="inv-tbl">${head}${body}</table>`
    + cumLine + `<div class="inv-note">${note}</div>`
    + cumSmallMultiplesHTML(invF, key, ul)
    + `</div>`;
}

// 투자자별 누적 순매수 거래대금 스몰멀티플 컨테이너(캔버스는 이후 Chart.js로 렌더).
// 4개 패널: 외국인/기관 합계/개인/기타법인. 각 패널 최신 누적값 + 단위 라벨 표기.
function cumSmallMultiplesHTML(invF, key, ul) {
  const cs = invF.cum_series;
  if (!cs || !key || !(cs.dates && cs.dates.length)) return "";
  const lc = cs.latest || {};
  const since = fmtD(String(cs.dates[0])), until = fmtD(String(cs.dates[cs.dates.length - 1]));
  const cells = CUM_INV.map(([nm, ik]) => {
    const lv = lc[ik];
    const cls = lv > 0 ? "iv-pos" : lv < 0 ? "iv-neg" : "";
    return `<div class="cum-cell"><div class="hd">`
      + `<span class="nm">${nm}</span>`
      + `<span class="lv ${cls}">${sign(lv)} ${ul}</span></div>`
      + `<div class="cv"><canvas id="cum-${key}-${ik}" `
      + `role="img" aria-label="${nm} 누적 순매수 거래대금 추이(${ul}), 최신 ${sign(lv)}"></canvas></div></div>`;
  }).join("");
  return `<div class="cum-sm"><div class="cum-sm-hd">투자자별 누적 순매수 거래대금 추이 (${ul})</div>`
    + `<div class="cum-sm-note">${since}~${until} 일별 순매수 거래대금의 누적합. `
    + `4개 패널은 각각 <b>독립 y축</b>(스케일 상이)이며 점선은 0 기준선입니다 — `
    + `패널 간 기울기·크기를 직접 비교하지 말고 각 라벨과 값을 확인하세요.</div>`
    + `<div class="cum-grid">${cells}</div></div>`;
}

function renderStockInsights(si, sf) {
  sf = sf || {};
  const grid = document.getElementById("stkInsightGrid");
  grid.innerHTML = Object.entries(si).map(([key, v]) => {
    const cls = stanceMiniCls(v.stance);
    const sigs = (v.signals || []).map(s => {
      const dc = s.dir === "pos" ? "dot-pos" : s.dir === "neg" ? "dot-neg" : "dot-neu";
      return `<div class="sig"><span class="dot ${dc}"></span>`
           + `<span class="lb">${s.label}</span>`
           + `<span class="dt">${s.detail}</span></div>`;
    }).join("");
    const conf = v.confidence == null ? "" :
      `<span class="conf" title="투자자 수급 미제공 등으로 신뢰도 상한 80%">신뢰도 ${v.confidence}%</span>`;
    const proxy = v.is_proxy
      ? `<span class="proxy-tag" title="델타환산 아님 · 프록시">프록시</span>` : "";
    const posBlk = positioningHTML(
      Object.assign({}, (sf[key] || {}).positioning || {},
        { investor_options: (((sf[key] || {}).options) || {}).investor_options }), key);
    const method = (v.method || v.limitations)
      ? `<div class="stk-method">${v.method || ""}${v.method && v.limitations ? "<br>" : ""}`
        + `${v.limitations ? `<span class="lim">한계: ${v.limitations}</span>` : ""}</div>`
      : "";
    return `<div class="stk-ins">`
         + `<div class="top"><span class="name">${v.label} ${proxy}</span>`
         + `<span class="stance ${cls}">${v.stance}${conf}</span></div>`
         + dirCompareHTML(v)
         + `<div class="sum">${v.summary}</div>`
         + sigs + posBlk + method + `</div>`;
  }).join("");

  // 표 삽입 후 각 종목의 투자자별 누적 스몰멀티플 차트를 그린다.
  Object.entries(si).forEach(([key]) => {
    const invF = ((sf[key] || {}).positioning || {}).investor_futures;
    if (invF && invF.available && invF.cum_series) drawInvestorCumCharts(key, invF.cum_series);
  });
}

// 투자자별(외국인/기관/개인/기타법인) 누적 순매수 거래대금 스몰멀티플.
// 각 패널은 독립 y축(스케일 상이) — 슬로프/크기 패널 간 직접 비교 금지(라벨 참조).
const _cumCharts = {};
const CUM_INV = [["외국인", "foreign", "--foreign"], ["기관 합계", "inst", "--inst"],
                 ["개인", "indiv", "--indiv"], ["기타법인", "other_corp", "--other"]];
function drawInvestorCumCharts(key, cs) {
  const labels = (cs.dates || []).map(d => fmtD(String(d)));
  const ul = cs.unit_label || "백만원";
  CUM_INV.forEach(([nm, ik, cvar]) => {
    const el = document.getElementById(`cum-${key}-${ik}`);
    if (!el) return;
    const color = C(cvar) || C("--accent");
    if (_cumCharts[el.id]) _cumCharts[el.id].destroy();
    const opts = baseOpts({ y: { grid: { color: COL.line },
        ticks: { maxTicksLimit: 4, font: { size: 9 },
                 callback: v => Number(v).toLocaleString("ko-KR", { notation: "compact" }) },
        title: { display: true, text: ul, font: { size: 9 } } } }, false);
    opts.scales.x.ticks = { maxRotation: 0, autoSkip: true, maxTicksLimit: 4, font: { size: 9 } };
    opts.plugins.tooltip.callbacks = {
      title: items => `${nm} · ${items[0].label}`,
      label: ctx => `누적 ${sign(ctx.parsed.y)} ${ul}` };
    _cumCharts[el.id] = new Chart(el, {
      type: "line",
      data: { labels, datasets: [
        // 0 기준선 (누적이 0 위/아래인지 시각적 기준)
        { label: "0", data: labels.map(() => 0), borderColor: COL.muted,
          borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, tension: 0 },
        { label: nm, data: cs[ik] || [], borderColor: color, backgroundColor: color + "22",
          borderWidth: 2, pointRadius: 0, fill: true, tension: .25 },
      ] },
      options: opts,
    });
  });
}

function stanceMiniCls(stance) {
  if (stance === "강세" || stance === "강세우위") return "st-bull";
  if (stance === "약세" || stance === "약세우위") return "st-bear";
  return "st-neu";
}

// 현재 방향 / 전일 방향 / 전일 대비 (동일 방법론·가중치, 당일 데이터 미참조)
function dirCompareHTML(v) {
  const dc = v.direction_change || {};
  const chip = (stance, score, conf, date) => {
    const meta = [date ? fmtD(date) : null,
                  score == null ? null : `스코어 ${sign(score, 2)}`,
                  conf == null ? null : `신뢰도 ${conf}%`].filter(Boolean).join(" · ");
    return `<span class="stance-mini ${stanceMiniCls(stance)}">${stance}</span>`
         + `<span class="dc-meta">${meta}</span>`;
  };
  const curCell = `<div class="dc-cell"><div class="dc-lb">현재 방향</div>`
    + `<div class="dc-val">${chip(v.stance, v.score, v.confidence, v.date)}</div></div>`;

  let prevCell, deltaCell;
  if (dc.available && dc.previous) {
    const p = dc.previous;
    prevCell = `<div class="dc-cell"><div class="dc-lb">전일 방향</div>`
      + `<div class="dc-val">${chip(p.stance, p.score, p.confidence, p.date)}</div></div>`;
    // 배지 색/화살표는 base label이 아니라 '현재 스탠스'(tone)를 따른다.
    // 약세 강화에 초록 ▲가 붙는 오해를 방지: bull→초록▲, bear→빨강▼, 중립→회색.
    const tone = dc.tone != null ? dc.tone
      : (stanceMiniCls(v.stance) === "st-bull" ? 1 : stanceMiniCls(v.stance) === "st-bear" ? -1 : 0);
    const toneCls = tone > 0 ? "up" : tone < 0 ? "down" : "flat";
    const text = dc.label_detail || dc.label;
    const arrow = tone > 0 ? "▲" : tone < 0 ? "▼" : (dc.label === "유지" ? "=" : "⇄");
    const tip = `${p.date ? fmtD(p.date) : "전일"} → ${v.date ? fmtD(v.date) : "당일"} 세션 비교`;
    deltaCell = `<div class="dc-cell dc-delta" title="${tip}"><div class="dc-lb">전일 대비</div>`
      + `<div class="dc-val"><span class="chg-badge chg-${toneCls}">${arrow} ${text}</span></div>`
      + `<div class="dc-meta">Δ스코어 ${sign(dc.score_change, 2)}</div></div>`;
  } else {
    prevCell = `<div class="dc-cell"><div class="dc-lb">전일 방향</div>`
      + `<div class="dc-val dc-na">미제공</div>`
      + `<div class="dc-meta">${dc.reason || "직전 세션 데이터 없음"}</div></div>`;
    deltaCell = `<div class="dc-cell dc-delta"><div class="dc-lb">전일 대비</div>`
      + `<div class="dc-val dc-na">—</div></div>`;
  }
  return `<div class="dir-cmp">${curCell}${prevCell}${deltaCell}</div>`;
}

function stanceClass(score) {
  if (score == null) return "";
  if (score >= 0.12) return "up";
  if (score <= -0.12) return "down";
  return "";
}

function renderDirectional(dir) {
  const card = document.getElementById("dirCard");
  if (!dir || dir.score == null) { card.style.display = "none"; return; }
  card.style.display = "block";
  const cls = stanceClass(dir.score);
  const st = document.getElementById("dirStance");
  st.textContent = dir.stance;
  st.className = "dir-stance " + cls;
  document.getElementById("dirConf").textContent =
    `스코어 ${sign(dir.score,2)} · 신뢰도 ${dir.confidence}%`;
  // knob position: map [-1,1] -> [0%,100%]; 0 = center (50%)
  const pct = Math.max(0, Math.min(100, (dir.score + 1) / 2 * 100));
  document.getElementById("dirKnob").style.left = pct + "%";
  // fill: a segment from center (50%) out to the knob, colored by direction.
  // Its length is proportional to |score|, so a small score = a small fill.
  const fill = document.getElementById("dirFill");
  const half = Math.abs(pct - 50); // width in % from center
  if (dir.score >= 0) {
    fill.style.left = "50%"; fill.style.right = "auto";
    fill.style.width = half + "%";
    fill.style.background = "var(--up)";
    fill.style.boxShadow = "0 0 8px rgba(46,204,113,.55)";
  } else {
    fill.style.right = "50%"; fill.style.left = "auto";
    fill.style.width = half + "%";
    fill.style.background = "var(--down)";
    fill.style.boxShadow = "0 0 8px rgba(231,76,60,.55)";
  }
  // stance label color: muted for neutral/mild, saturated only for strong reads
  const strong = Math.abs(dir.score) >= 0.35;
  st.style.opacity = strong ? "1" : "0.85";
  document.getElementById("dirSummary").textContent = dir.summary;

  // 방향 전환 강조 배너 (카드 상단)
  renderFlipBanner(dir);

  // 전일 대비 방향성 변화
  const chgEl = document.getElementById("dirChange");
  if (dir.score_delta != null && dir.prev_score != null) {
    const dlt = dir.score_delta;
    const cls = dlt > 0.005 ? "chg-up" : (dlt < -0.005 ? "chg-down" : "chg-flat");
    const arrow = dlt > 0.005 ? "▲" : (dlt < -0.005 ? "▼" : "▬");
    const stanceChanged = dir.prev_stance && dir.prev_stance !== dir.stance;
    const stanceTxt = stanceChanged
      ? ` · ${dir.prev_stance} → ${dir.stance}`
      : "";
    chgEl.innerHTML =
      `전일 대비 <span class="${cls}">${arrow} ${sign(dlt,3)}</span>` +
      ` (전일 ${sign(dir.prev_score,2)})${stanceTxt}`;
    chgEl.style.display = "";
  } else {
    chgEl.style.display = "none";
  }

  // 주요 지표 전일 대비 변화
  const dd = document.getElementById("dirDeltas");
  const D = dir.deltas;
  if (D) {
    const item = (label, val, unit, digits, invert) => {
      if (val == null) return "";
      // invert=true 면 상승이 약세 신호(예: 풋/콜 비율) — 색을 반전
      const pos = val >= 0;
      const good = invert ? !pos : pos;
      const c = Math.abs(val) < (digits ? 0.005 : 0.5) ? "" : (good ? "d-up" : "d-down");
      return `${label} <span class="${c}">${sign(val,digits)}${unit}</span>`;
    };
    const parts = [
      item("지수", D.index_close, "p", 2, false),
      item("거래대금 P/C", D.pc_ratio_val, "", 2, true),
      item("베이시스", D.basis, "p", 2, false),
      item("풋/콜 OI", D.pc_ratio_oi, "", 2, true),
      item("선물 미결제", D.fut_oi, "계약", 0, false),
    ].filter(Boolean);
    dd.innerHTML = parts.length
      ? `<span style="opacity:.75">전일(${fmtD(D.prev_date)}) 대비 — </span>` + parts.join("  ·  ")
      : "";
    dd.style.display = parts.length ? "" : "none";
  } else {
    dd.style.display = "none";
  }

  const bull = "var(--up)", bear = "var(--down)", neu = "var(--muted)";
  document.getElementById("dirSignals").innerHTML = dir.signals.map(sg => {
    const v = sg.vote;
    const color = v > 0.05 ? bull : (v < -0.05 ? bear : neu);
    // centered bar: half-width 26px. fill grows from center (26px) outward,
    // right for bull (green), left for bear (red). min 4px so any vote is visible.
    const w = Math.max(4, Math.min(24, Math.abs(v) * 24));
    const side = v >= 0 ? `left:26px` : `right:26px`;
    return `<div class="sig">
      <div class="sig-bar"><div class="sig-fill" style="${side};width:${w}px;background:${color}"></div></div>
      <div class="sig-txt"><span class="sig-name">${sg.name}</span><span class="sig-reason">${sg.reason}</span></div>
    </div>`;
  }).join("");

  renderWeightTable(dir);
}

// 방향 전환이 발생한 신호를 카드 상단 배너로 강조.
function renderFlipBanner(dir) {
  const el = document.getElementById("dirFlipBanner");
  if (!el) return;
  const flips = (dir.signals || []).filter(s => s.flipped && s.prev_tag);
  if (!flips.length) { el.style.display = "none"; el.innerHTML = ""; return; }
  // 가중치 높은 순으로 정렬(영향력 큰 전환을 앞에)
  const sorted = flips.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const tagOf = (v) => (v == null) ? "중립"
    : (v > 0.05 ? "강세" : (v < -0.05 ? "약세" : "중립"));
  const clsOf = (label) => label === "강세" ? "to-bull"
    : (label === "약세" ? "to-bear" : "to-neu");
  const items = sorted.map(s => {
    const nowLbl = tagOf(s.vote);
    const prevLbl = s.prev_tag;
    return `<span class="fb-item">
      <span class="fb-name">${s.name}</span>
      <span class="fb-flow"><span class="from">${prevLbl}</span> → <span class="${clsOf(nowLbl)}">${nowLbl}</span></span>
    </span>`;
  }).join("");
  const n = sorted.length;
  el.innerHTML =
    `<div class="fb-head">⚠️ 방향 전환 감지 <span class="fb-badge">${n}개 신호</span>
       <span style="font-weight:600;color:var(--muted);font-size:11.5px">— 전일 대비 방향성이 바뀐 변곡점 신호</span>
     </div>
     <div class="fb-list">${items}</div>`;
  el.style.display = "";
}

// 신호별 가중치 표 — 각 신호의 고정 가중치와 종합 스코어 기여도를 한눈에.
function renderWeightTable(dir) {
  const el = document.getElementById("dirWeights");
  if (!el) return;
  const sigs = (dir.signals || []).filter(s => s.weight != null);
  if (!sigs.length) { el.innerHTML = ""; return; }
  const wTotal = sigs.reduce((a, s) => a + s.weight, 0);
  const wMax = Math.max(...sigs.map(s => s.weight));
  // 가중치 내림차순 정렬(동일하면 순서 유지)
  const rows = sigs.map((s, i) => ({ ...s, i }))
    .sort((a, b) => (b.weight - a.weight) || (a.i - b.i));

  const dirTag = (v) => {
    if (v == null)   return `<span class="dir-tag dir-neu">—</span>`;
    if (v > 0.05)  return `<span class="dir-tag dir-bull">강세 ▲</span>`;
    if (v < -0.05) return `<span class="dir-tag dir-bear">약세 ▼</span>`;
    return `<span class="dir-tag dir-neu">중립 ▬</span>`;
  };

  // 전일 대비 투표 변화 셀: 화살표 + 변화량. flipped(방향 전환)은 별도 강조.
  const deltaCell = (s) => {
    if (s.is_new) return `<span class="d-new">NEW</span>`;
    const dv = s.vote_delta;
    if (dv == null) return `<span class="d-flat">—</span>`;
    const cls = dv > 0.02 ? "d-up" : (dv < -0.02 ? "d-down" : "d-flat");
    const arr = dv > 0.02 ? "▲" : (dv < -0.02 ? "▼" : "▬");
    return `<span class="${cls}">${arr} ${sign(dv,2)}</span>`;
  };

  const anyFlip = rows.some(s => s.flipped);

  const body = rows.map(s => {
    const share = wTotal > 0 ? (s.weight / wTotal * 100) : 0;
    const barW = wMax > 0 ? (s.weight / wMax * 100) : 0;
    const flipTag = s.flipped
      ? `<span class="flip-tag" title="전일 ${s.prev_tag} → 금일 방향 전환">⇄ 전환</span>` : "";
    return `<tr class="${s.flipped ? "row-flip" : ""}">
      <td class="w-name">${s.name}${flipTag}</td>
      <td class="num"><span class="wbar-wrap"><span class="wbar" style="width:${barW.toFixed(0)}%"></span></span>${nf(s.weight,1)}</td>
      <td class="num">${share.toFixed(0)}%</td>
      <td>${dirTag(s.vote)}</td>
      <td>${s.prev_tag ? dirTag(s.prev_vote) : `<span class="dir-tag dir-neu">—</span>`}</td>
      <td class="num">${sign(s.vote,2)}</td>
      <td class="num">${deltaCell(s)}</td>
    </tr>`;
  }).join("");

  const flipNote = anyFlip
    ? ` · ⇄ 표시된 신호는 전일 대비 <b>방향이 전환</b>된 항목입니다(방향성 변곡점 신호).`
    : " · 전일 대비 방향이 전환된 신호는 없습니다.";

  el.innerHTML = `<table class="wtbl">
    <thead><tr>
      <th>신호</th><th class="num">가중치</th><th class="num">비중</th>
      <th>현재 방향</th><th>전일 방향</th><th class="num">투표</th><th class="num">전일대비</th>
    </tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><td colspan="7">종합 스코어 = Σ(투표×가중치) ÷ Σ가중치 · 가중치 합계 ${nf(wTotal,1)}${flipNote}<br><span style="opacity:.8">※ 투자자별(외국인·기관) 신호는 만기 이후 누적 기준이라 일별 전일대비 변화가 작게 나타날 수 있습니다.</span></td></tr></tfoot>
  </table>`;
}

function renderAlerts(d) {
  // Alerts
  const al = document.getElementById("alerts");
  if (!d.alerts.length) {
    al.innerHTML = `<div class="empty">현재 임계치를 초과한 신호가 없습니다. 시장은 정상 범위 내에서 움직이고 있습니다.</div>`;
  } else {
    al.innerHTML = d.alerts.map(a=>`
      <div class="item">
        <div class="dot ${a.level}"></div>
        <div>
          <div class="t">${a.title}<span class="lvl-tag lvl-${a.level}">${a.level.toUpperCase()}</span></div>
          <div class="d">${a.detail}</div>
          <div class="i">💡 ${a.interpretation}</div>
        </div>
      </div>`).join("");
  }
}

function drawCharts(d, s, labels) {
  const L = d.latest, m = d.meta;
  // Charts
  const grid = (c=COL.line) => ({ grid:{color:c}, ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:8} });

  // ---- 거래대금 풋/콜 (동행 지표, 최상단 강조) ----
  if (s.pc_ratio_val && s.pc_ratio_val.some(v => v != null)) {
    new Chart(pcVal, {
      type:"line",
      data:{ labels, datasets:[
        lineDS("거래대금 풋/콜", s.pc_ratio_val, COL.pcval, true),
      ]},
      options: baseOpts({ y:{...grid(), title:{display:true,text:"배수"}} }, false)
    });

    new Chart(valAmt, {
      type:"bar",
      data:{ labels, datasets:[
        barDS("콜 거래대금", s.call_val_eok, COL.call),
        barDS("풋 거래대금", s.put_val_eok, COL.put),
      ]},
      options: baseOpts({ y:{...grid(), title:{display:true,text:"억원"}} })
    });

    // 헤드라인 배지: 최신 거래대금 P/C + 방향성 톤
    const pcv = L.pc_ratio_val;
    let tone = "중립", tcol = "var(--muted)";
    if (pcv != null) {
      if (pcv >= 1.1) { tone = "풋 우위 (약세/헤지)"; tcol = "var(--down)"; }
      else if (pcv <= 0.9) { tone = "콜 우위 (강세)"; tcol = "var(--up)"; }
    }
    document.getElementById("pcvalHead").innerHTML =
      `<div style="font-size:30px;font-weight:800;line-height:1;color:${tcol}">${nf(pcv,2)}</div>` +
      `<div style="font-size:12px;font-weight:700;margin-top:4px;color:${tcol}">${tone}</div>` +
      (L.call_val_eok!=null && L.put_val_eok!=null
        ? `<div style="font-size:11px;color:var(--muted);margin-top:3px">콜 ${nf(L.call_val_eok)}억 · 풋 ${nf(L.put_val_eok)}억</div>` : "");

    document.getElementById("pcvalNote").textContent =
      "거래대금 풋/콜은 당일 실제 자금이 어디로 쏠렸는지 보여주는 동행 지표입니다. " +
      "1보다 높을수록 풋(하락 대비)에, 낮을수록 콜(상승 기대)에 자금이 집중됨을 뜻합니다. " +
      "미결제약정(재고성) 기반 P/C보다 당일 방향성 설명력이 높습니다.";
  } else {
    const pv = document.getElementById("pcvalCard");
    if (pv) pv.style.display = "none";
  }

  new Chart(oiChg, {
    type:"bar",
    data:{ labels, datasets:[
      barDS("선물", s.fut_oi_chg, COL.fut),
      barDS("콜옵션", s.call_oi_chg, COL.call),
      barDS("풋옵션", s.put_oi_chg, COL.put),
    ]},
    options: baseOpts({ y:{...grid(), title:{display:true,text:"계약"}} })
  });

  new Chart(oiCum, {
    type:"line",
    data:{ labels, datasets:[
      lineDS("선물", s.cum_fut_oi, COL.fut),
      lineDS("콜옵션", s.cum_call_oi, COL.call),
      lineDS("풋옵션", s.cum_put_oi, COL.put),
    ]},
    options: baseOpts({ y:{...grid(), title:{display:true,text:"만기대비 순증 계약"}} })
  });

  new Chart(basis, {
    type:"line",
    data:{ labels, datasets:[{
      label:"베이시스 (선물−현물)", data:s.basis, borderColor:COL.basis,
      backgroundColor:"rgba(245,166,35,.12)", fill:true, tension:.25,
      pointRadius:2, borderWidth:2,
    }]},
    options: baseOpts({ y:{...grid(), title:{display:true,text:"지수포인트"}} }, false)
  });

  new Chart(pcr, {
    type:"line",
    data:{ labels, datasets:[
      lineDS("풋/콜 (미결제)", s.pc_ratio_oi, COL.put, true),
      lineDS("풋/콜 (거래량)", s.pc_ratio_vol, COL.call, true),
    ]},
    options: baseOpts({ y:{...grid(), title:{display:true,text:"배수"}} })
  });

  new Chart(px, {
    type:"line",
    data:{ labels, datasets:[
      lineDS("KOSPI200 현물", s.index_close, COL.idx),
      lineDS("선물 종가", s.fut_close, COL.fut),
    ]},
    options: baseOpts({ y:{...grid(), title:{display:true,text:"지수"}} }, false)
  });

  // 투자자별 수급 레이어
  if (d.has_foreign_layer && d.foreign && d.foreign.daily && d.foreign.daily.length) {
    document.getElementById("invCard").style.display = "block";
    setupInvestorLayer(d.foreign);
  }

  document.getElementById("foot").innerHTML =
    `데이터: 한국거래소(KRX) 정보데이터시스템 · OHLCV/미결제약은 KRX Open API · 생성: ${m.generated_at}<br>` +
    `투자자별 순매매는 만기일(${fmtD(m.expiry)}) 이후 누적 순매수금액(억원) · 풋/콜 비율은 시장 전체 미결제약/거래량 기준.<br>` +
    `본 대시보드는 정보 제공 목적이며 투자 자문이 아닙니다.`;
}

// ---- 투자자별 수급 레이어 ----
let _invCumChart = null, _invDailyChart = null, _invData = null;
const INV_COL = { foreign:C("--foreign"), inst:C("--inst"), indiv:C("--indiv") };
const PROD_LABEL = { fut:"선물", call:"콜옵션", put:"풋옵션" };

function setupInvestorLayer(f) {
  _invData = f;
  const seg = document.getElementById("invSeg");
  seg.querySelectorAll(".seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      seg.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      drawInvestor(btn.dataset.p);
    });
  });
  drawInvestor("fut");
}

function drawInvestor(prod) {
  const f = _invData;
  const fd = f.daily;
  const UL = f.unit_label || "계약";   // 억원(순매수금액) 또는 계약
  const labels = fd.map(r => fmtD(String(r.date)));
  const dailyKey = { foreign:`foreign_${prod}`, inst:`inst_${prod}`, indiv:`indiv_${prod}` };
  const cumKey   = { foreign:`cum_foreign_${prod}`, inst:`cum_inst_${prod}`, indiv:`cum_indiv_${prod}` };

  // summary chips (latest cumulative per investor)
  const last = fd[fd.length - 1] || {};
  const chips = [
    { who:"외국인", key:cumKey.foreign, col:INV_COL.foreign },
    { who:"기관",   key:cumKey.inst,    col:INV_COL.inst },
    { who:"개인",   key:cumKey.indiv,   col:INV_COL.indiv },
  ];
  document.getElementById("invSummary").innerHTML = chips.map(c => {
    const v = last[c.key];
    const cls = v > 0 ? "up" : (v < 0 ? "down" : "");
    const dir = v > 0 ? "순매수" : (v < 0 ? "순매도" : "중립");
    return `<div class="inv-chip">
      <div class="who"><span class="sw" style="background:${c.col}"></span>${c.who} 누적</div>
      <div class="amt ${cls}">${sign(v)}${UL}</div>
      <div class="who" style="font-weight:500">${PROD_LABEL[prod]} ${dir}</div>
    </div>`;
  }).join("");

  const grid = (c=COL.line) => ({ grid:{color:c}, ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:8} });

  const cumSets = [
    lineDS("외국인", fd.map(r=>r[cumKey.foreign]), INV_COL.foreign),
    lineDS("기관",   fd.map(r=>r[cumKey.inst]),    INV_COL.inst),
    lineDS("개인",   fd.map(r=>r[cumKey.indiv]),   INV_COL.indiv),
  ];
  const dailySets = [
    barDS("외국인", fd.map(r=>r[dailyKey.foreign]), INV_COL.foreign),
    barDS("기관",   fd.map(r=>r[dailyKey.inst]),    INV_COL.inst),
    barDS("개인",   fd.map(r=>r[dailyKey.indiv]),   INV_COL.indiv),
  ];

  if (_invCumChart) _invCumChart.destroy();
  _invCumChart = new Chart(document.getElementById("invCum"), {
    type:"line",
    data:{ labels, datasets:cumSets },
    options: baseOpts({ y:{...grid(), title:{display:true,text:`누적 순매수금액 (${UL})`}} })
  });
  if (_invDailyChart) _invDailyChart.destroy();
  _invDailyChart = new Chart(document.getElementById("invDaily"), {
    type:"bar",
    data:{ labels, datasets:dailySets },
    options: baseOpts({ y:{...grid(), title:{display:true,text:`일별 순매수금액 (${UL})`}} })
  });
}

function baseOpts(scales, legend=true) {
  return {
    responsive:true, maintainAspectRatio:false,
    interaction:{ mode:"index", intersect:false },
    plugins:{ legend:{ display:legend, labels:{ boxWidth:12, boxHeight:12, usePointStyle:true, font:{size:11} } },
      tooltip:{ backgroundColor:"#1b212d", borderColor:COL.line, borderWidth:1, padding:10 } },
    scales:{ x:{ grid:{display:false} }, ...scales }
  };
}
function lineDS(label, data, color, dashOpt=false) {
  return { label, data, borderColor:color, backgroundColor:color,
    tension:.25, pointRadius:2, borderWidth:2, fill:false };
}
function barDS(label, data, color) {
  return { label, data, backgroundColor:color+"cc", borderColor:color, borderWidth:1, borderRadius:2 };
}

// ---- 개별주식선물 레이어 (시세/OI만) ----
let _stkPxChart = null, _stkOiChart = null, _stkData = null;
let _stkOptOiChart = null, _stkOptPcChart = null, _stkOptIvChart = null;
const STK_SPOT_COL = C("--muted") || "#8a93a6";
const STK_FUT_COL  = C("--accent") || "#5da9ff";
const STK_OI_COL   = C("--foreign") || "#4cc38a";
const STK_CALL_COL = "#4cc38a";   // 콜 = 강세(그린)
const STK_PUT_COL  = "#ff6b6b";   // 풋 = 약세(레드)
const STK_PC_COL   = C("--warn") || "#ffb347";

function setupStockFutures(sf) {
  _stkData = sf;
  const keys = Object.keys(sf);   // e.g. ['samsung','skhynix']
  const seg = document.getElementById("stkSeg");
  seg.innerHTML = keys.map((k,i) =>
    `<button class="seg-btn${i===0?" active":""}" data-k="${k}">${sf[k].label}</button>`
  ).join("");
  seg.querySelectorAll(".seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      seg.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      drawStockFuture(btn.dataset.k);
    });
  });
  drawStockFuture(keys[0]);
}

function drawStockFuture(key) {
  const o = _stkData[key];
  if (!o) return;
  const S = o.series, L = o.latest;
  const labels = S.date.map(d => fmtD(String(d)));
  const roll = S.rollover || [];
  const cmSeries = S.contract_month || [];

  // 계약월 표기: 'YYYYMM' → 'YYYY.MM월'
  const cmTxt = (cm) => cm ? `${cm.slice(0,4)}.${cm.slice(4,6)}월물` : "근월물";
  const expTxt = o.final_trade_date
    ? `${fmtD(String(o.final_trade_date))} 만기예정` : "";

  // 요약 칩: 계약월 / 종가 / 베이시스 / OI(증감) / 거래대금
  const basisCls = L.basis > 0 ? "up" : (L.basis < 0 ? "down" : "");
  const oiCls = L.oi_chg > 0 ? "up" : (L.oi_chg < 0 ? "down" : "");
  const chips = [
    { who:"계약월(근월물)", amt:cmTxt(o.contract_month), sub:(expTxt ? expTxt + " · 둘째 목요일" : "둘째 목요일 만기"), cls:"" },
    { who:"선물 종가", amt:`${nf(L.close)}원`, sub:(o.contract || "근월물"), cls:"" },
    { who:"베이시스(선물−현물)", amt:`${sign(L.basis)}원`, sub:(L.basis>=0?"콘탱고":"백워데이션"), cls:basisCls },
    { who:"미결제약정", amt:`${nf(L.oi)}계약`, sub:`전일대비 ${sign(L.oi_chg)}`, cls:oiCls },
  ];
  if (roll.some(Boolean)) {
    const idx = roll.lastIndexOf(true);
    const from = cmTxt(cmSeries[idx-1]||null), to = cmTxt(cmSeries[idx]||null);
    chips.push({ who:"롤오버", amt:`${fmtD(String(S.date[idx]))}`,
                 sub:`${from} → ${to} 전환`, cls:"" });
  }
  document.getElementById("stkSummary").innerHTML = chips.map(c => `
    <div class="inv-chip">
      <div class="who">${c.who}</div>
      <div class="amt ${c.cls}">${c.amt}</div>
      <div class="who" style="font-weight:500">${c.sub}</div>
    </div>`).join("");

  const grid = (c=COL.line) => ({ grid:{color:c}, ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:8} });

  // 계약(근월물) 전환일에는 서로 다른 계약이므로 선을 잇지 않는다.
  //  - segment.borderColor: 롤오버로 끝나는 구간을 투명 처리해 선을 끊고
  //  - 해당 시점 포인트를 강조(크게, 경고색)해 계약 전환을 시각화한다.
  const rollSeg = (col) => ({ borderColor: (ctx) => roll[ctx.p1DataIndex] ? "transparent" : col });
  const rollPtR = (ctx) => roll[ctx.dataIndex] ? 5 : 2;
  const rollPtC = (base) => (ctx) => roll[ctx.dataIndex] ? STK_PC_COL : base;
  const rollTooltip = {
    callbacks: { footer: (items) => {
      const i = items[0].dataIndex, cm = cmSeries[i];
      const base = cm ? `계약월 ${cm.slice(0,4)}.${cm.slice(4,6)}` : "";
      return roll[i] ? (base + " · ⟳ 롤오버(계약 전환)") : base;
    } }
  };

  // 종가 vs 현물
  if (_stkPxChart) _stkPxChart.destroy();
  const pxFut = lineDS("선물 종가", S.close, STK_FUT_COL);
  pxFut.segment = rollSeg(STK_FUT_COL);
  pxFut.pointRadius = rollPtR; pxFut.pointBackgroundColor = rollPtC(STK_FUT_COL);
  pxFut.spanGaps = false;
  const pxOpts = baseOpts({ y:{...grid(), title:{display:true,text:"가격 (원)"}} });
  pxOpts.plugins.tooltip = { ...pxOpts.plugins.tooltip, ...rollTooltip };
  _stkPxChart = new Chart(document.getElementById("stkPx"), {
    type:"line",
    data:{ labels, datasets:[ pxFut, lineDS("현물", S.spot, STK_SPOT_COL, true) ]},
    options: pxOpts
  });
  // 선물 현물 점선 처리
  _stkPxChart.data.datasets[1].borderDash = [5,4];
  _stkPxChart.update();

  // OI 추이 (롤오버 시 계약이 바뀌므로 선을 끊는다)
  if (_stkOiChart) _stkOiChart.destroy();
  const oiDS = lineDS("미결제약정", S.oi, STK_OI_COL);
  oiDS.segment = rollSeg(STK_OI_COL);
  oiDS.pointRadius = rollPtR; oiDS.pointBackgroundColor = rollPtC(STK_OI_COL);
  oiDS.spanGaps = false;
  const oiOpts = baseOpts({ y:{...grid(), title:{display:true,text:"계약"}} }, false);
  oiOpts.plugins.tooltip = { ...oiOpts.plugins.tooltip, ...rollTooltip };
  _stkOiChart = new Chart(document.getElementById("stkOi"), {
    type:"line",
    data:{ labels, datasets:[ oiDS ]},
    options: oiOpts
  });

  // ==== 개별주식옵션 ====
  drawStockOptions(key);

  const expNote = o.final_trade_date
    ? `현재 근월물 ${cmTxt(o.contract_month)} · 예정 최종거래일 ${fmtD(String(o.final_trade_date))}(둘째 목요일, 휴장 시 직전 영업일로 조정될 수 있는 예정치). `
    : "";
  document.getElementById("stkNote").innerHTML =
    `선물: 근월물(거래대금 최대 월물) · 옵션: 전체 월물 콜/풋 합산 · KRX Open API 일별매매정보. ` +
    expNote +
    `단일주식선물은 비분기월 2개 + 분기월(3·6·9·12월) 4개가 상장되어 각 계약월 둘째 목요일에 개별 만기하며, KOSPI200 선물의 분기 만기 주기와 다릅니다. 계약 전환(롤오버) 시점에는 서로 다른 계약이므로 시세·OI 선을 끊어 표시합니다. ` +
    `개별주식 파생상품은 KRX Open API에서 투자자별 수급(외국인/기관/개인)을 제공하지 않아 시세·OI·콜/풋만 표시합니다.`;
}

function drawStockOptions(key) {
  const o = _stkData[key];
  const opt = o && o.options;
  const oiEl = document.getElementById("stkOptOi");
  const pcEl = document.getElementById("stkOptPc");
  const ivEl = document.getElementById("stkOptIv");
  const capEls = document.querySelectorAll(".opt-cap");
  const sumEl = document.getElementById("stkOptSummary");
  const ivSumEl = document.getElementById("stkIvSummary");
  // 옵션 데이터 없으면 옵션 섹션 숨김
  const optBoxes = [oiEl, pcEl, ivEl].map(e => e.closest(".card"));
  if (!opt) {
    sumEl.innerHTML = ""; if (ivSumEl) ivSumEl.innerHTML = "";
    optBoxes.forEach(b => b && (b.style.display = "none"));
    capEls.forEach(c => c.style.display = "none");
    return;
  }
  optBoxes.forEach(b => b && (b.style.display = ""));
  capEls.forEach(c => c.style.display = "");
  const S = opt.series, L = opt.latest;
  const labels = S.date.map(d => fmtD(String(d)));

  // 요약 칩: 콜 OI / 풋 OI / P/C(OI) / P/C(거래대금)
  const pcOiCls = L.pc_oi > 1 ? "down" : (L.pc_oi < 1 ? "up" : "");   // 풋우위=약세(red), 콜우위=강세(green)
  const pcValCls = L.pc_val > 1 ? "down" : (L.pc_val < 1 ? "up" : "");
  const chips = [
    { who:"콜 미결제약정", amt:`${nf(L.call_oi)}`, sub:`거래대금 ${nf(L.call_val_eok)}억`, cls:"" },
    { who:"풋 미결제약정", amt:`${nf(L.put_oi)}`, sub:`거래대금 ${nf(L.put_val_eok)}억`, cls:"" },
    { who:"P/C (OI)", amt:`${L.pc_oi ?? "—"}`, sub:(L.pc_oi==null?"":(L.pc_oi<0.7?"콜 우위(강세)":L.pc_oi>1.3?"풋 우위(방어)":"중립권")), cls:pcOiCls },
    { who:"P/C (거래대금)", amt:`${L.pc_val ?? "—"}`, sub:"풋·콜 거래대금 비율", cls:pcValCls },
  ];
  sumEl.innerHTML = chips.map(c => `
    <div class="inv-chip">
      <div class="who">${c.who}</div>
      <div class="amt ${c.cls}">${c.amt}</div>
      <div class="who" style="font-weight:500">${c.sub}</div>
    </div>`).join("");

  const grid = (c=COL.line) => ({ grid:{color:c}, ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:8} });

  // 콜·풋 OI
  if (_stkOptOiChart) _stkOptOiChart.destroy();
  _stkOptOiChart = new Chart(oiEl, {
    type:"line",
    data:{ labels, datasets:[
      lineDS("콜 OI", S.call_oi, STK_CALL_COL),
      lineDS("풋 OI", S.put_oi, STK_PUT_COL),
    ]},
    options: baseOpts({ y:{...grid(), title:{display:true,text:"계약"}} })
  });

  // P/C 비율 (OI · 거래대금)
  if (_stkOptPcChart) _stkOptPcChart.destroy();
  _stkOptPcChart = new Chart(pcEl, {
    type:"line",
    data:{ labels, datasets:[
      lineDS("P/C (OI)", S.pc_oi, STK_PC_COL),
      lineDS("P/C (거래대금)", S.pc_val, STK_FUT_COL, true),
    ]},
    options: baseOpts({ y:{...grid(), title:{display:true,text:"풋/콜 비율"}} })
  });
  if (_stkOptPcChart.data.datasets[1]) {
    _stkOptPcChart.data.datasets[1].borderDash = [5,4];
    _stkOptPcChart.update();
  }

  // ==== 근월물 ATM 내재변동성 ====
  drawStockIv(opt, labels, grid);
}

const STK_IV_MID = C("--warn") || "#ffb347";

function drawStockIv(opt, labels, grid) {
  const ivEl = document.getElementById("stkOptIv");
  const ivSumEl = document.getElementById("stkIvSummary");
  const ivCap = document.querySelector(".opt-cap-iv");
  const ivBox = ivEl.closest(".card");
  const atm = opt.atm;
  const S = opt.series;
  // ATM IV 미제공(구 데이터/미백필) → IV 서브섹션만 숨김
  if (!atm || !atm.has) {
    if (ivSumEl) ivSumEl.innerHTML = "";
    document.querySelectorAll(".opt-cap-iv").forEach(e => e.style.display = "none");
    if (ivBox) ivBox.style.display = "none";
    return;
  }
  document.querySelectorAll(".opt-cap-iv").forEach(e => e.style.display = "");
  if (ivBox) ivBox.style.display = "";

  const pct = v => (v == null ? "—" : `${nf(v,1)}%`);
  const chg = atm.mid_chg;
  const chgCls = chg == null ? "" : (chg > 0 ? "down" : (chg < 0 ? "up" : ""));  // IV↑=불안(red)
  const skew = atm.skew;
  const skewSub = skew == null ? "" : (skew <= -2 ? "풋 리치(방어적)" : (skew >= 2 ? "콜 리치" : "중립권"));
  const strikeTxt = atm.note === "보간" && atm.strike_lo != atm.strike_hi
    ? `${nf(atm.strike_lo)}~${nf(atm.strike_hi)} 보간`
    : (atm.strike == null ? "—" : `${nf(atm.strike)}`);
  const expTxt = atm.expiry ? `${String(atm.expiry).slice(0,4)}.${String(atm.expiry).slice(4,6)}` : "근월물";
  const chips = [
    { who:"ATM IV(중간)", amt:pct(atm.iv_mid), sub:(chg==null?"근월물 등가격":`전일 ${chg>0?"+":""}${nf(chg,1)}%p`), cls:chgCls },
    { who:"콜 IV", amt:pct(atm.iv_call), sub:"근월물 ATM", cls:"" },
    { who:"풋 IV", amt:pct(atm.iv_put), sub:"근월물 ATM", cls:"" },
    { who:"스큐(콜−풋)", amt:(skew==null?"—":`${skew>0?"+":""}${nf(skew,1)}%p`), sub:skewSub, cls:(skew==null?"":(skew<=-2?"down":(skew>=2?"up":""))) },
  ];
  ivSumEl.innerHTML = chips.map(c => `
    <div class="inv-chip">
      <div class="who">${c.who}</div>
      <div class="amt ${c.cls}">${c.amt}</div>
      <div class="who" style="font-weight:500">${c.sub}</div>
    </div>`).join("") +
    `<div class="inv-chip" style="flex:1 1 100%;background:transparent;border:none;box-shadow:none;padding-top:2px">
       <div class="who" style="font-weight:500;color:var(--muted)">만기 ${expTxt} · 행사가 ${strikeTxt} · KRX 제공 연율화 IV(전체월물 가중 아님)</div>
     </div>`;

  if (_stkOptIvChart) _stkOptIvChart.destroy();
  _stkOptIvChart = new Chart(ivEl, {
    type:"line",
    data:{ labels, datasets:[
      lineDS("ATM IV(중간)", S.atm_iv_mid, STK_IV_MID),
      lineDS("콜 IV", S.atm_iv_call, STK_CALL_COL, true),
      lineDS("풋 IV", S.atm_iv_put, STK_PUT_COL, true),
    ]},
    options: baseOpts({ y:{...grid(), title:{display:true,text:"연율화 %"}} })
  });
  [1,2].forEach(i => { if (_stkOptIvChart.data.datasets[i]) _stkOptIvChart.data.datasets[i].borderDash = [5,4]; });
  _stkOptIvChart.update();
}

main();

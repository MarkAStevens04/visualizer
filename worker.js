// Dashboard-friendly Worker script (no TS, no wrangler.toml)
// Works with either binding name: "DB" or "prod_d1_tutorial" (the tutorial default)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ua  = request.headers.get("user-agent") || "";
    // Best-effort IP (Workers put client IP in cf-connecting-ip)
    const ip  = request.headers.get("cf-connecting-ip") || "";

    // Pick whichever binding you actually created in Settings > Bindings
    const DB = env.TEST_BINDING;

    if (!DB) {
      return new Response("D1 binding not found. Add a D1 binding named 'DB' or 'prod_d1_tutorial' in Settings > Bindings.", { status: 500 });
    }



    








// ---------- Attendance dashboard (first-time vs repeat) ----------
// /api/dashboard (HTML) or /api/dashboard?format=json|csv&days=90
if (url.pathname === "/api/dashboard") {
  // Optional auth (only enforced if you set DASHBOARD_TOKEN in env)
  if (env.DASHBOARD_TOKEN) {
    const bearer = request.headers.get("authorization") || "";
    const headerKey = bearer.toLowerCase().startsWith("bearer ") ? bearer.slice(7).trim() : "";
    const key = headerKey || (url.searchParams.get("key") || "");
    if (key !== env.DASHBOARD_TOKEN) return new Response("Unauthorized", { status: 401 });
  }

  const daysParam = url.searchParams.get("days");
  const days = daysParam ? Math.max(0, Math.min(3650, parseInt(daysParam, 10) || 0)) : 0;

  const format = (url.searchParams.get("format") || "").toLowerCase();
  const accept = request.headers.get("accept") || "";
  const wantCSV = format === "csv" || accept.includes("text/csv");
  const wantHTML = format === "html" || (!wantCSV && format !== "json" && accept.includes("text/html"));

  const windowBind = `-${days} day`;
  const where = days > 0 ? `WHERE a."date" >= date('now', ?)` : "";

  // First-ever attendance date per token (ALL TIME), then daily split within the window
  const dailySQL = `
  WITH firsts AS (
    SELECT token, MIN("date") AS first_date
    FROM attendances
    GROUP BY token
  ),
  events_by_day AS (
    -- ensures we only have one row per date (prevents duplicate counts if events has multiple rows per day)
    SELECT
      "event_date" AS day,
      MAX("event_name") AS event_name
    FROM events
    GROUP BY "event_date"
  )
  SELECT
    a."date" AS day,
    e.event_name AS event_name,
    COUNT(DISTINCT a.token) AS total,
    COUNT(DISTINCT CASE WHEN f.first_date = a."date" THEN a.token END) AS first_time,
    COUNT(DISTINCT CASE WHEN f.first_date < a."date" THEN a.token END) AS repeat
  FROM attendances a
  JOIN firsts f ON f.token = a.token
  LEFT JOIN events_by_day e ON e.day = a."date"
  ${where}
  GROUP BY a."date", e.event_name
  ORDER BY day ASC
`;


  const dailyRes = days > 0
    ? await DB.prepare(dailySQL).bind(windowBind).run()
    : await DB.prepare(dailySQL).run();

  const rows = (dailyRes.results || []).map(r => ({
    day: String(r.day),
    event_name: r.event_name == null ? null : String(r.event_name),
    total: Number(r.total) || 0,
    first_time: Number(r.first_time) || 0,
    repeat: Number(r.repeat) || 0
  }));
    

  // Event days only => days with >=1 attendee
  const eventDays = rows.filter(r => r.total > 0);

  // Rolling avg over last 7 EVENT DAYS (not calendar days)
  let cum = 0;
  let rollSum = 0;
  const q = [];
  for (const x of rows) {
    cum += x.total;
    x.cumulative = cum;

    // only compute rolling average over event days (but keep value attached to that day)
    if (x.total > 0) {
      q.push(x.total);
      rollSum += x.total;
      if (q.length > 7) rollSum -= q.shift();
      x.avg7 = Math.round((rollSum / q.length) * 10) / 10; // 1 decimal
    } else {
      x.avg7 = null;
    }
  }

  const totalSum = eventDays.reduce((a, b) => a + b.total, 0);
  const avgPerEventDay = eventDays.length ? Math.round((totalSum / eventDays.length) * 10) / 10 : 0;

  let peak = { day: null, total: 0, first_time: 0, repeat: 0 };
  for (const x of rows) {
    if (x.total > peak.total) peak = { day: x.day, total: x.total, first_time: x.first_time, repeat: x.repeat };
  }

  // Meta (window + all time)
  const metaWinSQL = `
    SELECT COUNT(DISTINCT token) AS unique_people, COUNT(*) AS total_rows
    FROM attendances
    ${days > 0 ? `WHERE "date" >= date('now', ?)` : ""}
  `;
  const metaAllSQL = `
    SELECT COUNT(DISTINCT token) AS unique_people_all_time
    FROM attendances
  `;

  const metaWinRes = days > 0
    ? await DB.prepare(metaWinSQL).bind(windowBind).run()
    : await DB.prepare(metaWinSQL).run();

  const metaAllRes = await DB.prepare(metaAllSQL).run();

  // ---- Distribution: people by # of event-days attended (within window) ----
  const distWhere = days > 0 ? `WHERE "date" >= date('now', ?)` : "";

  const distSQL = `
    WITH per_person AS (
      SELECT token, COUNT(DISTINCT "date") AS events_attended
      FROM attendances
      ${distWhere}
      GROUP BY token
    )
    SELECT events_attended AS events, COUNT(*) AS people
    FROM per_person
    GROUP BY events_attended
    ORDER BY events ASC
  `;

  const distRes = days > 0
    ? await DB.prepare(distSQL).bind(windowBind).run()
    : await DB.prepare(distSQL).run();

  const distRaw = (distRes.results || []).map(r => ({
    events: Number(r.events) || 0,
    people: Number(r.people) || 0
  })).filter(d => d.events > 0);

  // Cap long tails for readability (bucket into "20+")
  const CAP = 20;
  let dist = distRaw;
  if (distRaw.length) {
    const overflow = distRaw.filter(d => d.events >= CAP).reduce((a, b) => a + b.people, 0);
    dist = distRaw.filter(d => d.events < CAP);
    if (overflow > 0) dist.push({ events: CAP, people: overflow, label: `${CAP}+` });
    dist = dist.map(d => ({ ...d, label: d.label ?? String(d.events) }));
  }
  

  const payload = {
    window_days: days || null,
    summary: {
      from: rows[0]?.day ?? null,
      to: rows[rows.length - 1]?.day ?? null,
      event_days: eventDays.length,
      total_attendances: totalSum,         // sum of daily uniques across event days
      avg_per_event_day: avgPerEventDay,   // excludes 0-attendance days by design
      peak_day: peak.day,
      peak_total: peak.total,
      peak_repeat: peak.repeat,
      peak_first_time: peak.first_time,
      unique_people_in_window: Number(metaWinRes.results?.[0]?.unique_people) || 0,
      unique_people_all_time: Number(metaAllRes.results?.[0]?.unique_people_all_time) || 0
    },
    series: rows,
    distribution: dist
  };

  // JSON
  if (!wantHTML && !wantCSV) {
    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  // CSV
  if (wantCSV) {
    const csvEsc = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    
    const lines = [
      "date,event_name,repeat,first_time,total,avg7_event_days,cumulative",
      ...rows.map(r =>
        `${r.day},${csvEsc(r.event_name)},${r.repeat},${r.first_time},${r.total},${r.avg7 ?? ""},${r.cumulative}`
      )
    ];
    
    return new Response(lines.join("\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="attendance_dashboard${days ? `_last_${days}_days` : ""}.csv"`
      }
    });
  }

  // ---- HTML helpers ----
  const esc = (s) => String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

  const nf = new Intl.NumberFormat("en-US");
  const fmt = (n) => nf.format(Number(n) || 0);

  // For chart readability
  let chartSeries = rows;
  // if (rows.length > 240) {
  //   const tmp = [];
  //   for (let i = 0; i < rows.length; i += 7) {
  //     const chunk = rows.slice(i, i + 7);
  //     const sum = (k) => chunk.reduce((a, b) => a + (b[k] || 0), 0);
  //     tmp.push({
  //       day: chunk[0].day,
  //       label: `${chunk[0].day}…${chunk[chunk.length - 1].day}`,
  //       repeat: sum("repeat"),
  //       first_time: sum("first_time"),
  //       total: sum("total")
  //     });
  //   }
  //   chartSeries = tmp;
  // }

  const svgChart = (() => {
    if (!chartSeries.length) return `<div class="empty">No attendance data yet.</div>`;

    const W = 1100, H = 280, pad = 30, bottom = 56;
    const max = Math.max(1, ...chartSeries.map(d => d.total || 0));
    const plotH = H - pad - bottom;
    const baseY = pad + plotH;
    const barW = (W - pad * 2) / chartSeries.length;

    let bars = "";
    for (let i = 0; i < chartSeries.length; i++) {
      const d = chartSeries[i];
      const total = d.total || 0;
      const rep = d.repeat || 0;
      const fst = d.first_time || 0;

      const repH = Math.round((rep / max) * plotH);
      const fstH = Math.round((fst / max) * plotH);

      const x = pad + i * barW;
      const w = Math.max(1, Math.floor(barW - 2));

      const repY = baseY - repH;
      const fstY = baseY - repH - fstH;

      const label = d.label || (d.event_name ? `${d.event_name} (${d.day})` : d.day);


      bars += `
        <g
          class="barGroup"
          role="button"
          tabindex="0"
          focusable="true"
          aria-label="${esc(label)}"
          data-day="${esc(d.day)}"
          data-label="${esc(label)}"
          data-event-name="${esc(d.event_name || "")}"
          data-total="${total}"
          data-repeat="${rep}"
          data-first-time="${fst}"
        >
          <!-- big invisible click target -->
          <rect x="${x.toFixed(2)}" y="${pad}" width="${w}" height="${plotH}" class="hit"></rect>

          <rect x="${x.toFixed(2)}" y="${repY}" width="${w}" height="${repH}" rx="3" class="barRepeat"></rect>
          <rect x="${x.toFixed(2)}" y="${fstY}" width="${w}" height="${fstH}" rx="3" class="barFirst"></rect>

          <title>${esc(label)}: total ${total} (repeat ${rep}, first-time ${fst})</title>
        </g>`;
    }

    

    // Labels (start / middle / end)
    const mid = Math.floor(chartSeries.length / 2);
    const axisLabels = [
      { i: 0, text: chartSeries[0].day },
      { i: mid, text: chartSeries[mid].day },
      { i: chartSeries.length - 1, text: chartSeries[chartSeries.length - 1].day }
    ].map(({ i, text }) => {
      const x = pad + i * barW;
      return `<text x="${x}" y="${H - 20}" class="axis">${esc(text)}</text>`;
    }).join("");

    return `
    <svg id="attChart" viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Attendance over time (repeat vs first-time)">
        <rect x="0" y="0" width="${W}" height="${H}" rx="16" class="chartBg"></rect>
        <text x="${pad}" y="24" class="chartTitle">Attendance over time • best: ${fmt(max)}</text>
        ${bars}
        ${axisLabels}
      </svg>`;
  })();

  const svgDistChart = (() => {
    if (!dist.length) return `<div class="empty">No per-person distribution data yet.</div>`;

    const W = 1100, H = 240, pad = 30, bottom = 50;
    const maxP = Math.max(1, ...dist.map(d => d.people || 0));
    const plotH = H - pad - bottom;
    const baseY = pad + plotH;
    const barW = (W - pad * 2) / dist.length;

    let bars = "";
    for (let i = 0; i < dist.length; i++) {
      const d = dist[i];
      const h = Math.round(((d.people || 0) / maxP) * plotH);
      const x = pad + i * barW;
      const w = Math.max(1, Math.floor(barW - 2));
      const y = baseY - h;

      bars += `
        <g>
          <rect x="${x.toFixed(2)}" y="${y}" width="${w}" height="${h}" rx="3" class="barDist"></rect>
          <title>attended ${esc(d.label)} events: ${fmt(d.people)} people</title>
        </g>`;
    }

    const mid = Math.floor(dist.length / 2);
    const axisLabels = [
      { i: 0, text: dist[0].label },
      { i: mid, text: dist[mid].label },
      { i: dist.length - 1, text: dist[dist.length - 1].label }
    ].map(({ i, text }) => {
      const x = pad + i * barW;
      return `<text x="${x}" y="${H - 20}" class="axis">${esc(text)}</text>`;
    }).join("");

    return `
      <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Number of events students attend">
        <rect x="0" y="0" width="${W}" height="${H}" rx="16" class="chartBg"></rect>
        <text x="${pad}" y="24" class="chartTitle">How many events our students attend</text>
        ${bars}
        ${axisLabels}
      </svg>`;
  })();




  const quickLinks = (d) => `/api/dashboard?days=${d}`;
  const jsonLink = `/api/dashboard?format=json${days ? `&days=${days}` : ""}`;
  const csvLink  = `/api/dashboard?format=csv${days ? `&days=${days}` : ""}`;

  const tableRows = [...rows].reverse().map(r => `
    <tr>
      <td class="mono">${esc(r.day)}</td>
      <td>${r.event_name ? esc(r.event_name) : ""}</td>
      <td class="num">${fmt(r.repeat)}</td>
      <td class="num">${fmt(r.first_time)}</td>
      <td class="num">${fmt(r.total)}</td>
      <td class="num">${r.avg7 == null ? "" : esc(r.avg7)}</td>
      <td class="num">${fmt(r.cumulative)}</td>
    </tr>
  `).join("");

  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Attendance Dashboard</title>
<style>
  :root{
    --bg1:#0b1220; --bg2:#0f172a;
    --card:rgba(255,255,255,.06);
    --card2:rgba(255,255,255,.08);
    --border:rgba(255,255,255,.12);
    --text:#e5e7eb; --muted:#9ca3af;
    --repeat:#34d399;   /* bottom */
    --first:#60a5fa;    /* top */
    --dist:#a78bfa;     /* distribution bars */
  }
  body{
    margin:0; color:var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    background: radial-gradient(1200px 700px at 20% -10%, rgba(96,165,250,.35), transparent 55%),
                radial-gradient(900px 600px at 80% 10%, rgba(52,211,153,.25), transparent 50%),
                linear-gradient(180deg, var(--bg1), var(--bg2));
  }
  .wrap{max-width:1100px;margin:0 auto;padding:28px 16px 48px}
  .top{display:flex;gap:12px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap}
  h1{margin:0;font-size:26px;letter-spacing:.2px}
  .sub{color:var(--muted);font-size:13px;margin-top:6px}
  .pillrow{display:flex;gap:8px;flex-wrap:wrap}
  .pill{
    display:inline-block;padding:8px 12px;border:1px solid var(--border);
    background:rgba(255,255,255,.04);border-radius:999px;
    color:var(--text);text-decoration:none;font-size:13px
  }
  .chartTitle{fill:rgba(229,231,235,.90);font-size:16px;font-weight:600}
  .pill:hover{background:rgba(255,255,255,.07)}
  .cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:16px}
  @media (max-width: 920px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
  @media (max-width: 520px){.cards{grid-template-columns:1fr}}
  .card{
    border:1px solid var(--border);background:var(--card);border-radius:16px;
    padding:14px 14px 12px
  }
  .k{color:var(--muted);font-size:12px}
  .v{font-size:22px;margin-top:6px}
  .chart{width:100%;height:auto;margin-top:14px;display:block}
  .chartBg{fill:rgba(255,255,255,.04);stroke:rgba(255,255,255,.10);stroke-width:1}
  .barRepeat{fill: color-mix(in srgb, var(--repeat) 85%, transparent)}
  .barFirst{fill: color-mix(in srgb, var(--first) 85%, transparent)}
  .barDist{fill: color-mix(in srgb, var(--dist) 85%, transparent)}
  .axis{fill:rgba(229,231,235,.75);font-size:14px}
  .note{color:var(--muted);font-size:12px;margin-top:8px}
  .legend{display:flex;gap:14px;align-items:center;margin-top:10px;color:var(--muted);font-size:13px}
  .dot{width:10px;height:10px;border-radius:4px;display:inline-block;margin-right:8px}
  .tableWrap{
    margin-top:16px;border:1px solid var(--border);background:var(--card);
    border-radius:16px;overflow:hidden
  }
  table{width:100%;border-collapse:collapse}
  thead th{
    position:sticky;top:0;background:rgba(15,23,42,.92);backdrop-filter: blur(8px);
    text-align:left;font-size:12px;color:rgba(229,231,235,.85);
    padding:12px;border-bottom:1px solid var(--border)
  }
  tbody td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);font-size:13px}
  tbody tr:hover{background:var(--card2)}
  .num{text-align:right}
  .mono{font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}
  .empty{
    border:1px dashed var(--border);border-radius:16px;padding:18px;color:var(--muted);margin-top:14px
  }
  /* Make bars feel clickable */
  .barGroup { cursor: pointer; }
  .barGroup .hit { fill: transparent; }
  .barGroup.isSelected .barRepeat,
  .barGroup.isSelected .barFirst {
    stroke: rgba(229,231,235,.85);
    stroke-width: 1.5;
  }

  /* Right-side drawer */
  .backdrop{
    position: fixed; inset: 0;
    background: rgba(0,0,0,.35);
    opacity: 0;
    transition: opacity .18s ease;
    pointer-events: none;
  }
  .backdrop.open{ opacity: 1; pointer-events: auto; }

  .drawer{
    position: fixed;
    top: 16px; right: 16px; bottom: 16px;
    width: min(390px, calc(100vw - 32px));
    border: 1px solid var(--border);
    background: rgba(15,23,42,.92);
    backdrop-filter: blur(10px);
    border-radius: 16px;
    box-shadow: 0 18px 60px rgba(0,0,0,.45);

    transform: translateX(110%);
    opacity: 0;
    transition: transform .18s ease, opacity .18s ease;
    pointer-events: none;
    display: flex;
    flex-direction: column;
  }
  .drawer.open{
    transform: translateX(0);
    opacity: 1;
    pointer-events: auto;
  }

  .drawerHead{
    padding: 14px 14px 10px;
    border-bottom: 1px solid rgba(255,255,255,.08);
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: flex-start;
  }
  .drawerTitle{ font-size: 16px; font-weight: 650; color: rgba(229,231,235,.95); }
  .drawerSub{ margin-top: 4px; font-size: 12px; color: var(--muted); }

  .iconBtn{
    width: 34px; height: 34px;
    border-radius: 10px;
    border: 1px solid rgba(255,255,255,.12);
    background: rgba(255,255,255,.05);
    color: rgba(229,231,235,.95);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }
  .iconBtn:hover{ background: rgba(255,255,255,.08); }

  .drawerBody{
    padding: 14px;
    overflow: auto;
  }
  .drawerHint{
    color: var(--muted);
    font-size: 13px;
    border: 1px dashed rgba(255,255,255,.14);
    border-radius: 14px;
    padding: 12px;
    background: rgba(255,255,255,.03);
  }
  .kv{ border: 1px solid rgba(255,255,255,.10); background: rgba(255,255,255,.04); border-radius: 14px; padding: 12px; }
  .kv .k{ color: var(--muted); font-size: 12px; }
  .kv .v{ margin-top: 6px; font-size: 22px; }
  .kvRow{ display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
  .kv.small .v{ font-size: 18px; }
  .hint2{ margin-top: 12px; font-size: 12px; color: var(--muted); }

</style>

<div class="wrap">
  <div class="top">
    <div>
      <h1>Attendance Dashboard</h1>
      <div class="sub">
        Window: ${days ? `last ${esc(days)} days` : "all time"}
        • Range: <span class="mono">${esc(payload.summary.from || "—")}</span> → <span class="mono">${esc(payload.summary.to || "—")}</span>
        • Event days: ${fmt(payload.summary.event_days)}
      </div>
    </div>
    <div class="pillrow">
      <a class="pill" href="${esc(quickLinks(30))}">Last 30</a>
      <a class="pill" href="${esc(quickLinks(90))}">Last 90</a>
      <a class="pill" href="${esc(quickLinks(365))}">Last 365</a>
      <a class="pill" href="/api/dashboard">All time</a>
      <a class="pill" href="${esc(jsonLink)}">JSON</a>
      <a class="pill" href="${esc(csvLink)}">CSV</a>
    </div>
  </div>

  <div class="cards">
    <div class="card"><div class="k">Total (sum of daily uniques)</div><div class="v">${fmt(payload.summary.total_attendances)}</div></div>
    <div class="card"><div class="k">Average / event day</div><div class="v">${esc(payload.summary.avg_per_event_day)}</div></div>
    <div class="card"><div class="k">Peak day (total)</div><div class="v mono">${esc(payload.summary.peak_day || "—")} <span style="opacity:.75;font-size:14px">(${fmt(payload.summary.peak_total)})</span></div></div>
    <div class="card"><div class="k">Unique people (window / all-time)</div><div class="v">${fmt(payload.summary.unique_people_in_window)} <span style="opacity:.7;font-size:14px">/ ${fmt(payload.summary.unique_people_all_time)}</span></div></div>
  </div>

  ${svgChart}
  <div class="legend">
    <span><span class="dot" style="background:var(--repeat)"></span>Repeat</span>
    <span><span class="dot" style="background:var(--first)"></span>First-time</span>
  </div>


${svgDistChart}
<div class="legend">
  <span><span class="dot" style="background:var(--dist)"></span># of people</span>
</div>


  <div class="tableWrap">
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Event</th>
          <th class="num">Repeat</th>
          <th class="num">First-time</th>
          <th class="num">Total</th>
          <th class="num">Avg (last 7 event days)</th>
          <th class="num">Cumulative</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows || `<tr><td colspan="7" style="color:var(--muted);padding:14px">No data yet.</td></tr>`}
      </tbody>
    </table>
  </div>
</div>

<div id="drawerBackdrop" class="backdrop" hidden></div>
<aside id="detailDrawer" class="drawer" aria-hidden="true">
  <div class="drawerHead">
    <div>
      <div class="drawerTitle" id="dTitle">Event details</div>
      <div class="drawerSub mono" id="dSub">Click a bar to inspect a day</div>
    </div>
    <button class="iconBtn" id="dClose" aria-label="Close details">×</button>
  </div>

  <div class="drawerBody" id="dBody">
    <div class="drawerHint">Click a bar in the attendance chart to see details here.</div>
  </div>
</aside>

<script>
(() => {
  const svg = document.getElementById('attChart');
  if (!svg) return;

  const drawer = document.getElementById('detailDrawer');
  const backdrop = document.getElementById('drawerBackdrop');
  const btnClose = document.getElementById('dClose');

  const titleEl = document.getElementById('dTitle');
  const subEl = document.getElementById('dSub');
  const bodyEl = document.getElementById('dBody');

  let selected = null;

  function openDrawer() {
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.hidden = false;
    requestAnimationFrame(() => backdrop.classList.add('open'));
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.classList.remove('open');
    if (selected) selected.classList.remove('isSelected');
    selected = null;
    window.setTimeout(() => { backdrop.hidden = true; }, 200);
  }

  function makeEl(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function kvCard(k, v, extraClass) {
    const wrap = makeEl('div', extraClass ? ('kv ' + extraClass) : 'kv');
    wrap.appendChild(makeEl('div', 'k', k));
    const vEl = makeEl('div', 'v', v);
    wrap.appendChild(vEl);
    return wrap;
  }

  function render(ds) {
    const eventName = (ds.eventName || '').trim();
    const label = (ds.label || '').trim();
    const start = ds.dayStart || ds.day || '';
    const end = ds.dayEnd || start;
    const isAgg = ds.agg === '1';

    titleEl.textContent = eventName || (isAgg ? 'Multiple days' : 'Event');
    subEl.textContent = isAgg ? (start + ' \u2192 ' + end) : start;

    // clear body
    while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);

    const top = kvCard(eventName ? 'Event' : 'Label', eventName || label || '—', '');
    top.querySelector('.v').style.fontSize = '16px';
    top.querySelector('.v').style.marginTop = '6px';
    top.querySelector('.v').style.opacity = '.95';
    bodyEl.appendChild(top);

    bodyEl.appendChild(kvCard('Total attendees', String(ds.total || 0), ''));

    const row = makeEl('div', 'kvRow', null);
    row.appendChild(kvCard('Repeat', String(ds.repeat || 0), 'small'));
    row.appendChild(kvCard('First-time', String(ds.firstTime || 0), 'small'));
    bodyEl.appendChild(row);

    if (!eventName) {
      bodyEl.appendChild(makeEl('div', 'hint2', 'No event name stored for this day yet.'));
    }
  }

  function selectBar(g) {
    if (selected === g) { closeDrawer(); return; } // toggle
    if (selected) selected.classList.remove('isSelected');
    selected = g;
    g.classList.add('isSelected');
    render(g.dataset);
    openDrawer();
  }

  svg.addEventListener('click', (e) => {
    const g = e.target.closest('.barGroup');
    if (g && svg.contains(g)) selectBar(g);
  });

  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const g = e.target.closest('.barGroup');
    if (g && svg.contains(g)) {
      e.preventDefault();
      selectBar(g);
    }
  });

  btnClose.addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
})();
</script>


`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}


















// ---------- Mascot leaderboard ----------
// /leaderboard -> HTML (if Accept includes text/html)
// /api/leaderboard -> JSON

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

if (url.pathname === "/leaderboard" || url.pathname === "/api/leaderboard") {
  const sql = `
    SELECT
      p.mascot AS mascot_name,
      m.emoji_1 AS emoji_1,
      COUNT(a.token) AS attendees,
      m.population,
      ROUND(1000.0 * COUNT(a.token) / NULLIF(m.population, 0), 2) AS points
    FROM attendances a
    JOIN people p ON p.token = a.token
    JOIN mascots m ON m.mascot_name = p.mascot
    GROUP BY p.mascot, m.population, m.emoji_1
    ORDER BY points DESC;
  `;

  const { results = [] } = await DB.prepare(sql).run();

  // Normalize numbers (D1 can return strings depending on query/driver)
  const rows = results.map(r => ({
    mascot_name: r.mascot_name,
    emoji_1: r.emoji_1 ?? "",
    attendees: Number(r.attendees ?? 0),
    population: Number(r.population ?? 0),
    points: Number(r.points ?? 0)
  }));

  const accept = request.headers.get("accept") || "";
  const wantsHtml = url.pathname === "/leaderboard" && accept.includes("text/html");

  if (!wantsHtml) {
    return new Response(JSON.stringify({ updated_at: new Date().toISOString(), rows }, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      }
    });
  }

  const maxPoints = Math.max(1, ...rows.map(r => r.points || 0));
  const updated = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date());

  const medal = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`);

  const podium = rows.slice(0, 3).map((r, i) => {
    const pct = Math.max(0, Math.min(100, (r.points / maxPoints) * 100));
    const coverage = r.population ? (100 * r.attendees / r.population) : 0;

    return `
      <div class="card"> 
        ${r.emoji_1 ? `<div class="emojiCorner" aria-hidden="true">${escapeHtml(r.emoji_1)}</div>` : ""}
        <div class="cardTop">
          <div class="rank">${medal(i)}</div>
          <div class="name">${escapeHtml(r.mascot_name)} ${escapeHtml(r.emoji)}</div>
        </div>
        <div class="big">${r.points.toFixed(2)} <span class="unit">pts</span></div>
        <div class="meta">
          <span><b>${r.attendees}</b> attendees</span>
          <span>·</span>
          <span><b>${r.population}</b> population</span>
          <span>·</span>
          <span><b>${coverage.toFixed(1)}%</b> coverage</span>
        </div>
        <div class="bar" role="img" aria-label="Points relative to the leader">
          <div class="fill" style="width:${pct}%;"></div>
        </div>
      </div>
    `;
  }).join("");

  const tableRows = rows.map((r, i) => {
    const pct = Math.max(0, Math.min(100, (r.points / maxPoints) * 100));
    const coverage = r.population ? (100 * r.attendees / r.population) : 0;
    return `
      <tr>
        <td class="rankCell">${medal(i)}</td>
        <td class="nameCell">${escapeHtml(r.mascot_name)}</td>
        <td class="num">${r.points.toFixed(2)}</td>
        <td class="num">${r.attendees}</td>
        <td class="num">${r.population}</td>
        <td class="num">${coverage.toFixed(1)}%</td>
        <td class="barCell">
          <div class="bar sm"><div class="fill" style="width:${pct}%;"></div></div>
        </td>
      </tr>
    `;
  }).join("");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Mascot Leaderboard</title>
  <style>
    :root{
      --bg0:#0b1020;
      --bg1:#0e1630;
      --card:rgba(255,255,255,.06);
      --card2:rgba(255,255,255,.09);
      --text:rgba(255,255,255,.92);
      --muted:rgba(255,255,255,.68);
      --line:rgba(255,255,255,.10);
      --shadow:0 10px 30px rgba(0,0,0,.25);
      --r:18px;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      color:var(--text);
      font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;
      background:
        radial-gradient(1200px 700px at 20% 10%, #253cff33, transparent 60%),
        radial-gradient(900px 600px at 80% 0%, #ff2bd433, transparent 55%),
        linear-gradient(160deg, var(--bg0), var(--bg1));
      min-height:100vh;
    }
    .wrap{max-width:1060px;margin:0 auto;padding:28px 18px 44px}
    header{display:flex;gap:14px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap}
    h1{margin:0;font-size:28px;letter-spacing:.2px}
    .sub{color:var(--muted);font-size:14px;margin-top:6px}
    .pill{
      display:inline-flex;gap:8px;align-items:center;
      padding:8px 12px;border-radius:999px;
      background:rgba(255,255,255,.07);
      border:1px solid var(--line);
      color:var(--muted);font-size:13px
    }
    .grid{display:grid;gap:14px;margin-top:16px}
    @media(min-width:820px){ .grid{grid-template-columns:repeat(3,1fr)} }
    .card{
      padding:14px 14px 12px;border-radius:var(--r);
      background:linear-gradient(180deg,var(--card),transparent);
      border:1px solid var(--line);
      box-shadow:var(--shadow);
      backdrop-filter: blur(8px);
      position:relative;
    }
    .cardTop{display:flex;align-items:center;gap:10px}
    .emojiCorner{
      position:absolute;
      top:12px;
      right:12px;

      width:42px;
      height:42px;
      display:grid;
      place-items:center;
    
      font-size:28px;     /* bigger emoji */
      line-height:1;

      background:rgba(255,255,255,.10);
      border:1px solid var(--line);
      border-radius:14px;
      box-shadow:0 8px 18px rgba(0,0,0,.18);
      backdrop-filter: blur(8px);
    }
    .rank{
      font-size:18px;min-width:40px;
      padding:6px 10px;border-radius:12px;
      background:rgba(255,255,255,.08);
      border:1px solid var(--line);
      text-align:center
    }
    .name{font-weight:700;font-size:16px}
    .big{margin-top:10px;font-size:34px;font-weight:800;letter-spacing:-.6px}
    .unit{font-size:14px;color:var(--muted);font-weight:700;margin-left:6px}
    .meta{margin-top:6px;color:var(--muted);font-size:13px;display:flex;gap:10px;flex-wrap:wrap}
    .bar{
      margin-top:12px;height:10px;border-radius:999px;
      background:rgba(255,255,255,.10);
      overflow:hidden;border:1px solid var(--line)
    }
    .bar.sm{height:8px;margin:0}
    .fill{
      height:100%;
      background:linear-gradient(90deg,#7c5cff,#ff4fd8);
      border-radius:999px;
    }
    .tableWrap{
      margin-top:16px;padding:12px;border-radius:var(--r);
      background:rgba(0,0,0,.14);
      border:1px solid var(--line);
      box-shadow:var(--shadow);
      overflow:auto
    }
    table{width:100%;border-collapse:collapse;min-width:740px}
    th,td{padding:10px 10px;border-bottom:1px solid var(--line);font-size:14px}
    th{color:var(--muted);text-align:left;font-weight:700}
    td.num{text-align:right;font-variant-numeric:tabular-nums}
    td.rankCell{width:70px}
    td.barCell{width:180px}
    tr:hover td{background:rgba(255,255,255,.03)}
    footer{margin-top:14px;color:var(--muted);font-size:12px}
    a{color:inherit}
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Mascot Leaderboard</h1>
        <div class="sub">Points = 1000 × attendees / population</div>
      </div>
      <div class="pill">Last updated: <b style="color:var(--text)">${escapeHtml(updated)}</b></div>
    </header>

    <section class="grid" aria-label="Top 3 mascots">
      ${podium || `<div class="card">No data yet.</div>`}
    </section>

    <section class="tableWrap" aria-label="Full rankings">
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Mascot</th>
            <th style="text-align:right">Points</th>
            <th style="text-align:right">Attendees</th>
            <th style="text-align:right">Population</th>
            <th style="text-align:right">Coverage</th>
            <th>Relative</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </section>

    <footer>
      JSON available at <a href="/api/leaderboard">/api/leaderboard</a>
    </footer>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "max-age=60",
      "vary": "accept",
    }
  });
}
























    // Quick sanity endpoint
    if (url.pathname === "/health") {
      const { results } = await DB.prepare("SELECT COUNT(*) AS n FROM clicks").run();
      return new Response(JSON.stringify({ ok: true, clicks: results?.[0]?.n ?? 0 }), {
        headers: { "content-type": "application/json" }
      });
    }

    return new Response("ok");
  }
};

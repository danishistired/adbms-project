// QueryLens front end
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), data);
  return data;
}

// ---------- Sample queries ----------
const SAMPLES = [
  ['Loans per category (join + group)', `SELECT c.name AS category, count(*) AS loans
FROM loans l
JOIN books b ON b.book_id = l.book_id
JOIN categories c ON c.category_id = b.category_id
GROUP BY c.name
ORDER BY loans DESC;`],
  ['Top 10 most borrowed books', `SELECT b.title, count(*) AS times_borrowed
FROM loans l JOIN books b USING (book_id)
GROUP BY b.book_id, b.title
ORDER BY times_borrowed DESC
LIMIT 10;`],
  ['Loan history of one member (no index → seq scan)', `SELECT l.loan_id, b.title, l.loaned_on, l.returned_on
FROM loans l JOIN books b USING (book_id)
WHERE l.member_id = 1234
ORDER BY l.loaned_on DESC;`],
  ['Fines collected by city and tier', `SELECT m.city, m.tier, round(sum(l.fine), 2) AS total_fines, count(*) FILTER (WHERE l.fine > 0) AS late_returns
FROM loans l JOIN members m USING (member_id)
GROUP BY m.city, m.tier
ORDER BY total_fines DESC;`],
  ['Monthly loans with running total (window function)', `SELECT to_char(month, 'YYYY-MM') AS month, loans,
       sum(loans) OVER (ORDER BY month) AS running_total,
       round(avg(loans) OVER (ORDER BY month ROWS 2 PRECEDING), 0) AS moving_avg_3m
FROM (SELECT date_trunc('month', loaned_on) AS month, count(*) AS loans
      FROM loans GROUP BY 1) t
ORDER BY month;`],
  ['Overdue loans (view)', `SELECT * FROM overdue_loans ORDER BY days_late DESC LIMIT 50;`],
  ['Popular books per category (materialized view)', `SELECT category, title, times_borrowed
FROM popular_books
WHERE rank_in_category <= 3
ORDER BY category, rank_in_category;`],
  ['Members who never borrowed (anti-join)', `SELECT m.member_id, m.full_name, m.joined_on
FROM members m
WHERE NOT EXISTS (SELECT 1 FROM loans l WHERE l.member_id = m.member_id);`],
  ['Most prolific author per country (CTE + DISTINCT ON)', `WITH author_books AS (
  SELECT a.author_id, a.full_name, a.country, count(*) AS books
  FROM authors a JOIN book_authors ba USING (author_id)
  GROUP BY a.author_id
)
SELECT DISTINCT ON (country) country, full_name, books
FROM author_books
ORDER BY country, books DESC;`],
  ['Fine owed on open loans (stored function)', `SELECT l.loan_id, b.title, l.due_on, calc_fine(l.loan_id) AS fine_owed
FROM loans l JOIN books b USING (book_id)
WHERE l.returned_on IS NULL AND l.due_on < CURRENT_DATE
ORDER BY fine_owed DESC
LIMIT 20;`],
  ['Borrow a book (INSERT fires trigger)', `INSERT INTO loans (book_id, member_id, loaned_on, due_on)
VALUES (42, 7, CURRENT_DATE, CURRENT_DATE + 14)
RETURNING *;`],
  ['Check book copies (after trigger)', `SELECT book_id, title, total_copies, available_copies FROM books WHERE book_id = 42;`],
  ['Refresh materialized view', `REFRESH MATERIALIZED VIEW popular_books;`],
  ['Members by email domain (LIKE)', `SELECT split_part(email, '@', 2) AS domain, tier, count(*) AS members
FROM members GROUP BY 1, 2 ORDER BY 1, 2;`],
];

const sel = $('#samples');
SAMPLES.forEach(([name], i) => sel.add(new Option(name, i)));
sel.onchange = () => { if (sel.value !== '') $('#sql').value = SAMPLES[sel.value][1]; sel.value = ''; };

// ---------- Navigation ----------
$$('.tab').forEach(b => b.onclick = () => showView(b.dataset.view));
function showView(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'schema') loadSchema();
  if (name === 'history') loadHistory();
  if (name === 'lab') loadIndexes();
}
$$('.subtab').forEach(b => b.onclick = () => showPane(b.dataset.pane));
function showPane(name) {
  $$('.subtab').forEach(t => t.classList.toggle('active', t.dataset.pane === name));
  $$('.pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + name));
  if (name === 'chart' && lastResult) drawResultChart(lastResult);
}

// ---------- Console ----------
let lastResult = null;
$('#run').onclick = runQuery;
$('#sql').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runQuery(); }
  if (e.key === 'Tab') {
    e.preventDefault();
    const t = e.target, s = t.selectionStart;
    t.value = t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd);
    t.selectionStart = t.selectionEnd = s + 2;
  }
});

async function runQuery() {
  const ta = $('#sql');
  // Run the selected text if there is a selection, else everything
  const sql = ta.selectionStart !== ta.selectionEnd ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : ta.value;
  const btn = $('#run');
  btn.disabled = true; btn.textContent = 'Running…';
  $('#error').classList.add('hidden');
  try {
    const data = await api('/api/query', { method: 'POST', body: { sql } });
    const result = data.results[data.results.length - 1];
    lastResult = result;
    renderStats(data, result);
    renderResults(data.results);
    $('#raw').textContent = data.plan ? JSON.stringify(data.plan, null, 2) : (data.planError || 'No plan for this statement.');
    if (data.plan) {
      PlanViz.render('#plan-tree', data.plan, { onSelect: n => $('#plan-detail').innerHTML = PlanViz.details(n) });
      if (!$('#pane-results').classList.contains('active') && !$('#pane-chart').classList.contains('active')) showPane('plan');
    } else {
      $('#plan-tree').innerHTML = `<p class="muted center">No execution plan for this statement${data.planError ? ': ' + esc(data.planError) : ' (only single SELECT / INSERT / UPDATE / DELETE statements have plans)'}.</p>`;
      $('#plan-detail').innerHTML = '';
      showPane('results');
    }
    if ($('#pane-chart').classList.contains('active')) drawResultChart(result);
  } catch (e) {
    const el = $('#error');
    el.textContent = e.message + (e.hint ? `\nHint: ${e.hint}` : '');
    el.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = '▶ Run';
  }
}

function renderStats(data, result) {
  const p = data.plan;
  const stats = [
    ['Rows', result.rowCount ?? result.rows.length],
    ['Round trip', PlanViz.fmtMs(data.duration)],
  ];
  if (p) {
    stats.push(['Planning', PlanViz.fmtMs(p['Planning Time'])]);
    stats.push(['Execution', PlanViz.fmtMs(p['Execution Time'])]);
    stats.push(['Est. cost', p.Plan['Total Cost'].toLocaleString()]);
    const b = p.Plan['Shared Hit Blocks'] ?? 0, r = p.Plan['Shared Read Blocks'] ?? 0;
    stats.push(['Buffers hit / read', `${b.toLocaleString()} / ${r.toLocaleString()}`]);
    if (p.Triggers?.length) stats.push(['Triggers fired', p.Triggers.map(t => `${t['Trigger Name']}×${t.Calls}`).join(', ')]);
  }
  $('#stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><span>${k}</span><b>${esc(v)}</b></div>`).join('');
}

const isNum = v => v !== null && v !== '' && typeof v !== 'boolean' && !isNaN(Number(v)) && !/^\d{4}-\d\d-\d\d/.test(v);

function renderResults(results) {
  $('#results').innerHTML = results.map(r => {
    if (!r.fields.length) return `<p><b>${esc(r.command)}</b> — ${r.rowCount ?? 0} row(s) affected.</p>`;
    const head = r.fields.map(f => `<th>${esc(f)}</th>`).join('');
    const body = r.rows.map(row => '<tr>' + r.fields.map(f => {
      const v = row[f];
      if (v === null) return '<td class="null">null</td>';
      const shown = v instanceof Object ? JSON.stringify(v) : String(v).replace(/T00:00:00\.000Z$/, '');
      return `<td class="${isNum(v) ? 'num' : ''}">${esc(shown)}</td>`;
    }).join('') + '</tr>').join('');
    const note = r.truncated ? `<p class="muted">Showing first ${r.rows.length} of ${r.rowCount} rows.</p>` : `<p class="muted">${r.rowCount} row(s)</p>`;
    return `${note}<table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }).join('<hr>');
}

// ---------- Result chart ----------
function drawResultChart(r) {
  const el = $('#chart');
  if (!r || !r.rows.length) { el.innerHTML = '<p class="muted center">No rows to chart.</p>'; return; }
  const numeric = r.fields.filter(f => r.rows.every(row => row[f] === null || isNum(row[f])));
  const labels = r.fields.filter(f => !numeric.includes(f));
  if (!numeric.length) { el.innerHTML = '<p class="muted center">The result has no numeric column to chart.</p>'; return; }

  const prev = { x: $('#chart-x')?.value, y: $('#chart-y')?.value };
  const xField = r.fields.includes(prev.x) ? prev.x : (labels[0] || r.fields[0]);
  const yField = numeric.includes(prev.y) && prev.y !== xField ? prev.y : (numeric.find(f => f !== xField) || numeric[0]);
  const fmtLabel = v => String(v ?? 'null').replace(/T00:00:00\.000Z$/, '');

  el.innerHTML = `<div class="chart-controls">
    Label <select id="chart-x">${r.fields.map(f => `<option ${f === xField ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
    Value <select id="chart-y">${numeric.map(f => `<option ${f === yField ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
    <span>${r.rows.length > 60 ? 'first 60 rows' : ''}</span></div>`;
  $('#chart-x').onchange = $('#chart-y').onchange = () => drawResultChart(r);

  // Group rows that share a label (e.g. city with several tiers)
  const grouped = d3.rollups(r.rows.slice(0, 200), v => d3.sum(v, d => Number(d[yField])), d => fmtLabel(d[xField])).slice(0, 60);
  const W = Math.max(el.clientWidth - 24, 500), H = 380, m = { t: 10, r: 10, b: 110, l: 70 };
  const x = d3.scaleBand().domain(grouped.map(d => d[0])).range([m.l, W - m.r]).padding(0.2);
  const y = d3.scaleLinear().domain([0, d3.max(grouped, d => d[1]) || 1]).nice().range([H - m.b, m.t]);
  const svg = d3.select(el).append('svg').attr('width', W).attr('height', H);
  svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x))
    .selectAll('text').attr('transform', 'rotate(-40)').style('text-anchor', 'end')
    .text(d => d.length > 22 ? d.slice(0, 21) + '…' : d);
  svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6, 's'));
  svg.selectAll('.bar').data(grouped).join('rect').attr('class', 'bar')
    .attr('x', d => x(d[0])).attr('width', x.bandwidth())
    .attr('y', d => y(d[1])).attr('height', d => y(0) - y(d[1])).attr('rx', 2)
    .on('mousemove', (e, d) => tip(e, `<b>${esc(d[0])}</b><br>${esc(yField)}: ${d[1].toLocaleString()}`))
    .on('mouseleave', hideTip);
}

const tipEl = $('#tooltip');
function tip(e, html) { tipEl.innerHTML = html; tipEl.classList.remove('hidden'); tipEl.style.left = e.clientX + 12 + 'px'; tipEl.style.top = e.clientY + 12 + 'px'; }
function hideTip() { tipEl.classList.add('hidden'); }

// ---------- Index Lab ----------
const LAB = [
  ['Find one member\'s loans (B-tree)', `SELECT * FROM loans WHERE member_id = 1234`, `CREATE INDEX ON loans (member_id)`],
  ['Loans in a date range', `SELECT count(*) FROM loans WHERE loaned_on BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE`, `CREATE INDEX ON loans (loaned_on)`],
  ['Latest 5 loans of a book (composite index)', `SELECT * FROM loans WHERE book_id = 10 ORDER BY loaned_on DESC LIMIT 5`, `CREATE INDEX ON loans (book_id, loaned_on DESC)`],
  ['Open loans only (partial index)', `SELECT loan_id, book_id, due_on FROM loans WHERE returned_on IS NULL AND due_on < CURRENT_DATE`, `CREATE INDEX ON loans (due_on) WHERE returned_on IS NULL`],
  ['Case-insensitive email lookup (expression index)', `SELECT * FROM members WHERE lower(email) = 'member4321@example.com'`, `CREATE INDEX ON members (lower(email))`],
  ['Covering index (index-only scan)', `SELECT member_id, count(*) FROM loans WHERE member_id BETWEEN 100 AND 200 GROUP BY member_id`, `CREATE INDEX ON loans (member_id) INCLUDE (loan_id)`],
  ['Index that does not help (low selectivity)', `SELECT count(*) FROM members WHERE tier = 'basic'`, `CREATE INDEX ON members (tier)`],
];
const labSel = $('#lab-presets');
LAB.forEach(([n], i) => labSel.add(new Option(n, i)));
labSel.onchange = () => { const [, q, ix] = LAB[labSel.value]; $('#lab-sql').value = q; $('#lab-index').value = ix; };
labSel.onchange();

$('#lab-run').onclick = async () => {
  const btn = $('#lab-run');
  btn.disabled = true; btn.textContent = 'Comparing…';
  $('#lab-error').classList.add('hidden');
  try {
    const { before, after } = await api('/api/compare', { method: 'POST', body: { sql: $('#lab-sql').value, indexSql: $('#lab-index').value } });
    PlanViz.render('#lab-before', before);
    PlanViz.render('#lab-after', after);
    renderLabSummary(before, after);
  } catch (e) {
    $('#lab-error').textContent = e.message;
    $('#lab-error').classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.textContent = '⇄ Compare';
  }
};

function renderLabSummary(before, after) {
  const tb = before['Execution Time'], ta = after['Execution Time'];
  const speed = tb / Math.max(ta, 0.001);
  const scanTypes = p => { const s = new Set(); (function w(n) { if (/Scan/.test(n['Node Type'])) s.add(n['Node Type']); (n.Plans || []).forEach(w); })(p.Plan); return [...s].join(', '); };
  const metrics = [
    ['Execution time (ms)', tb, ta],
    ['Estimated cost', before.Plan['Total Cost'], after.Plan['Total Cost']],
    ['Buffers touched', (before.Plan['Shared Hit Blocks'] || 0) + (before.Plan['Shared Read Blocks'] || 0), (after.Plan['Shared Hit Blocks'] || 0) + (after.Plan['Shared Read Blocks'] || 0)],
  ];
  const el = $('#lab-summary');
  el.innerHTML = `<div class="summary-cards">
    <div class="stat"><span>Result</span><b class="speedup ${speed < 1 ? 'slower' : ''}">${speed >= 1 ? speed.toFixed(1) + '× faster' : (1 / speed).toFixed(1) + '× slower'}</b></div>
    <div class="stat"><span>Scan before</span><b>${esc(scanTypes(before))}</b></div>
    <div class="stat"><span>Scan after</span><b>${esc(scanTypes(after))}</b></div>
    <div id="lab-bars"></div></div>`;
  // Small grouped bar chart: before vs after, each metric scaled to its own max
  const W = 500, rowH = 30, H = metrics.length * rowH * 2 + 10, L = 140;
  const svg = d3.select('#lab-bars').append('svg').attr('width', W).attr('height', H);
  metrics.forEach(([name, b, a], i) => {
    const max = Math.max(b, a) || 1, top = i * rowH * 2;
    svg.append('text').attr('x', 0).attr('y', top + 20).attr('fill', 'var(--muted)').style('font-size', '12px').text(name);
    [[b, 'var(--heat-4)', 'before'], [a, 'var(--ok)', 'after']].forEach(([v, color, label], j) => {
      const y = top + j * 22 + 6, w = (W - L - 80) * v / max;
      svg.append('rect').attr('x', L).attr('y', y).attr('width', Math.max(w, 2)).attr('height', 16).attr('rx', 3).attr('fill', color);
      svg.append('text').attr('x', L + Math.max(w, 2) + 6).attr('y', y + 12).attr('fill', 'var(--text)').style('font-size', '11px')
        .text(`${label}: ${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    });
  });
}

// Index manager
let schemaCache = null;
async function getSchema(force) {
  if (!schemaCache || force) schemaCache = await api('/api/schema');
  return schemaCache;
}

async function loadIndexes(force) {
  const s = await getSchema(force);
  const tSel = $('#idx-table');
  if (!tSel.options.length) {
    s.tables.filter(t => t.name !== 'query_log').forEach(t => tSel.add(new Option(t.name, t.name)));
    tSel.onchange = () => fillCols();
  }
  const fillCols = () => {
    const t = schemaCache.tables.find(t => t.name === tSel.value);
    $('#idx-cols').innerHTML = t.columns.map(c => `<option>${esc(c.column_name)}</option>`).join('');
  };
  if (!$('#idx-cols').options.length) fillCols();

  const rows = s.tables.flatMap(t => t.indexes.map(i => ({ ...i, table: t.name })));
  $('#index-list').innerHTML = `<table class="grid"><thead><tr><th>Table</th><th>Index</th><th>Definition</th><th>Size</th><th>Times used</th><th></th></tr></thead><tbody>
    ${rows.map(i => `<tr><td>${esc(i.table)}</td><td>${esc(i.index_name)} ${i.is_constraint ? '<span class="badge">constraint</span>' : ''}</td>
      <td>${esc(i.indexdef.replace(/^CREATE (UNIQUE )?INDEX \S+ ON library\.\S+ USING /, ''))}</td><td>${esc(i.size)}</td><td class="num">${i.scans}</td>
      <td>${i.is_constraint ? '' : `<button class="small danger" data-drop="${esc(i.index_name)}">Drop</button>`}</td></tr>`).join('')}
  </tbody></table>`;
  $$('[data-drop]').forEach(b => b.onclick = async () => {
    if (!confirm(`Drop index ${b.dataset.drop}?`)) return;
    try { await api('/api/indexes/' + encodeURIComponent(b.dataset.drop), { method: 'DELETE' }); loadIndexes(true); }
    catch (e) { alert(e.message); }
  });
}
$('#idx-create').onclick = async () => {
  const columns = [...$('#idx-cols').selectedOptions].map(o => o.value);
  if (!columns.length) return alert('Pick at least one column.');
  try { await api('/api/indexes', { method: 'POST', body: { table: $('#idx-table').value, columns } }); loadIndexes(true); }
  catch (e) { alert(e.message); }
};

// ---------- Schema (ER diagram) ----------
const ER_POS = {
  categories: [20, 20], books: [300, 20], book_authors: [580, 20], authors: [840, 20],
  loans: [300, 330], members: [20, 330], query_log: [840, 300],
};
async function loadSchema() {
  const s = await getSchema(true);
  const el = $('#er');
  el.innerHTML = '';
  const BOX_W = 230, ROW = 17, HEAD = 26;
  const boxes = {};
  let fallback = 0;
  s.tables.forEach(t => {
    const [x, y] = ER_POS[t.name] || [20 + (fallback++ % 4) * 270, 620];
    boxes[t.name] = { x, y, w: BOX_W, h: HEAD + t.columns.length * ROW + 8, t };
  });
  const W = Math.max(...Object.values(boxes).map(b => b.x + b.w)) + 20;
  const H = Math.max(...Object.values(boxes).map(b => b.y + b.h)) + 20;
  const svg = d3.select(el).append('svg').attr('width', W).attr('height', H);

  const colY = (b, col) => b.y + HEAD + b.t.columns.findIndex(c => c.column_name === col) * ROW + ROW / 2 + 2;
  const linkG = svg.append('g');
  s.foreignKeys.forEach(fk => {
    const a = boxes[fk.from_table.replace(/^library\./, '')], b = boxes[fk.to_table.replace(/^library\./, '')];
    if (!a || !b) return;
    const ay = colY(a, fk.from_col), by = colY(b, fk.to_col);
    const aRight = a.x < b.x;
    const ax = aRight ? a.x + a.w : a.x, bx = aRight ? b.x : b.x + b.w;
    const sameCol = Math.abs(a.x - b.x) < 10;
    const d = sameCol
      ? `M${a.x + a.w},${ay} C${a.x + a.w + 60},${ay} ${b.x + b.w + 60},${by} ${b.x + b.w},${by}`
      : `M${ax},${ay} C${(ax + bx) / 2},${ay} ${(ax + bx) / 2},${by} ${bx},${by}`;
    linkG.append('path').attr('class', 'er-link').attr('d', d);
    linkG.append('circle').attr('cx', sameCol ? b.x + b.w : bx).attr('cy', by).attr('r', 3.5).attr('fill', 'var(--accent)');
  });

  Object.values(boxes).forEach(b => {
    const g = svg.append('g').attr('class', 'er-table').attr('transform', `translate(${b.x},${b.y})`);
    g.append('rect').attr('class', 'box').attr('width', b.w).attr('height', b.h);
    g.append('rect').attr('class', 'head').attr('width', b.w).attr('height', HEAD).attr('rx', 8);
    g.append('rect').attr('class', 'head').attr('y', HEAD - 8).attr('width', b.w).attr('height', 8);
    g.append('text').attr('class', 'tname').attr('x', 10).attr('y', 17).text(b.t.name);
    g.append('text').attr('x', b.w - 10).attr('y', 17).attr('text-anchor', 'end').style('font-size', '10px')
      .text(`${(b.t.row_count ?? 0).toLocaleString()} rows · ${b.t.size || ''}`);
    const fkCols = new Set(s.foreignKeys.filter(f => f.from_table.replace(/^library\./, '') === b.t.name).map(f => f.from_col));
    b.t.columns.forEach((c, i) => {
      const y = HEAD + i * ROW + 14;
      g.append('text').attr('x', 10).attr('y', y).text((c.is_pk ? '🔑 ' : fkCols.has(c.column_name) ? '🔗 ' : '   ') + c.column_name);
      g.append('text').attr('class', 'type').attr('x', b.w - 10).attr('y', y).attr('text-anchor', 'end')
        .text(c.data_type.replace('character varying', 'varchar').replace('timestamp with time zone', 'timestamptz'));
    });
  });

  $('#objects').innerHTML = `<div class="objects">${s.objects.map(o => `<div class="object"><span class="badge">${esc(o.kind)}</span> ${esc(o.name)}</div>`).join('')}</div>`;
}

// ---------- History ----------
async function loadHistory() {
  const rows = await api('/api/history');
  const el = $('#history-chart');
  el.innerHTML = '';
  if (!rows.length) { el.innerHTML = '<p class="muted center">No queries yet.</p>'; $('#history-list').innerHTML = ''; return; }
  const data = rows.slice(0, 50).reverse();
  const W = Math.max(el.clientWidth - 16, 500), H = 200, m = { t: 20, r: 10, b: 24, l: 60 };
  const x = d3.scaleBand().domain(data.map(d => d.log_id)).range([m.l, Math.min(W - m.r, m.l + data.length * 40)]).padding(0.15);
  const y = d3.scaleLinear().domain([0, d3.max(data, d => d.duration_ms) || 1]).nice().range([H - m.b, m.t]);
  const svg = d3.select(el).append('svg').attr('width', W).attr('height', H);
  svg.append('text').attr('x', m.l).attr('y', 12).attr('fill', 'var(--muted)').style('font-size', '12px').text('Round-trip time of the last 50 queries (ms)');
  svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5));
  svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).tickValues([]));
  svg.selectAll('rect.h').data(data).join('rect').attr('class', 'h')
    .attr('x', d => x(d.log_id)).attr('width', x.bandwidth())
    .attr('y', d => y(d.duration_ms)).attr('height', d => y(0) - y(d.duration_ms)).attr('rx', 2)
    .attr('fill', d => d.success ? 'var(--accent-2)' : 'var(--err)')
    .on('mousemove', (e, d) => tip(e, `<code>${esc(d.sql_text.slice(0, 160))}</code><br>${d.duration_ms.toFixed(1)} ms`))
    .on('mouseleave', hideTip)
    .on('click', (_e, d) => loadIntoConsole(d.sql_text));

  $('#history-list').innerHTML = `<table class="grid"><thead><tr><th>#</th><th>When</th><th>Status</th><th>Time</th><th>Rows</th><th>Cost</th><th>SQL (click to reopen)</th></tr></thead><tbody>
    ${rows.map(r => `<tr data-id="${r.log_id}"><td>${r.log_id}</td><td>${new Date(r.ran_at).toLocaleString()}</td>
      <td class="${r.success ? 'ok' : 'bad'}" title="${esc(r.error_message || '')}">${r.success ? 'ok' : 'error'}</td>
      <td class="num">${r.duration_ms.toFixed(1)} ms</td><td class="num">${r.row_count ?? ''}</td><td class="num">${r.total_cost ?? ''}</td>
      <td class="sqlcell">${esc(r.sql_text.replace(/\s+/g, ' ').slice(0, 140))}</td></tr>`).join('')}
  </tbody></table>`;
  $$('#history-list tr[data-id]').forEach(tr => tr.onclick = () => loadIntoConsole(rows.find(r => r.log_id == tr.dataset.id).sql_text));
}
function loadIntoConsole(sql) { $('#sql').value = sql; showView('console'); }
$('#history-clear').onclick = async () => { if (confirm('Delete all query history?')) { await api('/api/history', { method: 'DELETE' }); loadHistory(); } };

runQuery();

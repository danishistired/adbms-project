// Draws an EXPLAIN (FORMAT JSON) plan as a tree with D3.
const PlanViz = (() => {
  const NODE_W = 230, NODE_H = 70;
  const HEAT = ['--heat-0', '--heat-1', '--heat-2', '--heat-3', '--heat-4']
    .map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());

  // Total time spent in a node including its children (ms), across loops
  const inclusive = n => (n['Actual Total Time'] ?? 0) * (n['Actual Loops'] ?? 1);

  // Add computed fields: own time, share of total, estimate error
  function annotate(plan) {
    const rootTime = inclusive(plan) || 1;
    const rootCost = plan['Total Cost'] || 1;
    const walk = n => {
      const kids = n.Plans || [];
      kids.forEach(walk);
      const childTime = kids.reduce((s, k) => s + inclusive(k), 0);
      const childCost = kids.reduce((s, k) => s + (k['Total Cost'] || 0), 0);
      n._self = Math.max(inclusive(n) - childTime, 0);
      n._selfCost = Math.max((n['Total Cost'] || 0) - childCost, 0);
      n._share = n['Actual Total Time'] != null ? n._self / rootTime : n._selfCost / rootCost;
      const est = n['Plan Rows'], act = n['Actual Rows'];
      if (act != null && est != null) {
        const ratio = Math.max(act, 1) / Math.max(est, 1);
        n._misestimate = ratio >= 10 || ratio <= 0.1 ? ratio : null;
      }
    };
    walk(plan);
    return plan;
  }

  function heatColor(share) {
    const i = share > 0.6 ? 4 : share > 0.35 ? 3 : share > 0.15 ? 2 : share > 0.05 ? 1 : 0;
    return HEAT[i];
  }

  function title(n) {
    let t = n['Node Type'];
    if (n['Join Type'] && n['Join Type'] !== 'Inner') t = `${n['Join Type']} ${t}`;
    if (n['Strategy'] && n['Node Type'] === 'Aggregate') t = `${n['Strategy']} Aggregate`;
    if (n['Parent Relationship'] === 'InitPlan' || n['Parent Relationship'] === 'SubPlan') t += ` (${n['Subplan Name'] || n['Parent Relationship']})`;
    return t;
  }

  function subtitle(n) {
    if (n['Index Name']) return `${n['Relation Name'] || ''} using ${n['Index Name']}`.trim();
    if (n['Relation Name']) return `on ${n['Relation Name']}${n.Alias && n.Alias !== n['Relation Name'] ? ' ' + n.Alias : ''}`;
    if (n['Hash Cond']) return n['Hash Cond'];
    if (n['Merge Cond']) return n['Merge Cond'];
    if (n['Sort Key']) return 'by ' + n['Sort Key'].join(', ');
    if (n['Group Key']) return 'by ' + n['Group Key'].join(', ');
    if (n['CTE Name']) return 'CTE ' + n['CTE Name'];
    return '';
  }

  const fmtMs = v => v >= 1000 ? (v / 1000).toFixed(2) + ' s' : v >= 10 ? v.toFixed(0) + ' ms' : v.toFixed(2) + ' ms';
  const fmtN = v => v == null ? '?' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e4 ? (v / 1e3).toFixed(0) + 'k' : String(v);
  const clip = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;

  function render(container, rawPlan, opts = {}) {
    const el = typeof container === 'string' ? document.querySelector(container) : container;
    el.innerHTML = '';
    const plan = annotate(rawPlan.Plan || rawPlan);
    const root = d3.hierarchy(plan, d => d.Plans);
    d3.tree().nodeSize([NODE_W + 24, NODE_H + 46])(root);

    let x0 = Infinity, x1 = -Infinity, y1 = 0;
    root.each(d => { x0 = Math.min(x0, d.x); x1 = Math.max(x1, d.x); y1 = Math.max(y1, d.y); });
    const pad = 20;
    const width = x1 - x0 + NODE_W + pad * 2;
    const height = y1 + NODE_H + pad * 2;
    const offX = -x0 + NODE_W / 2 + pad;

    const svg = d3.select(el).append('svg').attr('width', Math.max(width, el.clientWidth || 0)).attr('height', height);
    const shift = Math.max(((el.clientWidth || 0) - width) / 2, 0);
    const g = svg.append('g').attr('transform', `translate(${offX + shift},${pad})`);

    const maxRows = d3.max(root.descendants(), d => d.data['Actual Rows'] ?? d.data['Plan Rows']) || 1;
    const linkWidth = d3.scaleSqrt().domain([0, maxRows]).range([1.5, 12]);

    g.selectAll('.link').data(root.links()).join('path')
      .attr('class', 'link')
      .attr('stroke-width', d => linkWidth(d.target.data['Actual Rows'] ?? d.target.data['Plan Rows'] ?? 0))
      .attr('d', d => `M${d.source.x},${d.source.y + NODE_H} C${d.source.x},${(d.source.y + NODE_H + d.target.y) / 2} ${d.target.x},${(d.source.y + NODE_H + d.target.y) / 2} ${d.target.x},${d.target.y}`);

    const node = g.selectAll('.node').data(root.descendants()).join('g')
      .attr('class', 'node')
      .attr('transform', d => `translate(${d.x - NODE_W / 2},${d.y})`)
      .on('click', function (_e, d) {
        g.selectAll('.node').classed('selected', false);
        d3.select(this).classed('selected', true);
        opts.onSelect && opts.onSelect(d.data);
      });

    node.append('rect').attr('width', NODE_W).attr('height', NODE_H)
      .attr('fill', d => heatColor(d.data._share));
    // share-of-time bar along the bottom
    node.append('rect').attr('x', 0).attr('y', NODE_H - 5).attr('height', 5)
      .attr('width', d => Math.max(NODE_W * Math.min(d.data._share, 1), 2))
      .attr('fill', '#ffffffaa').attr('rx', 2).style('stroke', 'none');

    node.append('text').attr('class', 'title').attr('x', 10).attr('y', 18).text(d => clip(title(d.data), 30));
    node.append('text').attr('class', 'sub').attr('x', 10).attr('y', 34).text(d => clip(subtitle(d.data), 36));
    node.append('text').attr('x', 10).attr('y', 52).text(d => {
      const n = d.data;
      const rows = n['Actual Rows'] != null
        ? `rows ${fmtN(n['Actual Rows'])} (est ${fmtN(n['Plan Rows'])})`
        : `est rows ${fmtN(n['Plan Rows'])}`;
      const t = n['Actual Total Time'] != null ? `${fmtMs(n._self)} · ` : `cost ${n['Total Cost']} · `;
      return t + rows;
    });
    node.filter(d => d.data._misestimate).append('text')
      .attr('x', NODE_W - 20).attr('y', 18).attr('fill', 'var(--warn)').style('font-size', '14px').text('⚠');

    // Scroll so the top node is centred when the tree is wider than the view
    el.scrollLeft = Math.max(root.x + offX + shift - el.clientWidth / 2, 0);

    // Select the most expensive node by default
    if (opts.onSelect) {
      const hottest = root.descendants().reduce((a, b) => (b.data._share > a.data._share ? b : a));
      node.filter(d => d === hottest).classed('selected', true);
      opts.onSelect(hottest.data);
    }
    return plan;
  }

  // Key/value detail table for a plan node
  function details(n) {
    const skip = new Set(['Plans']);
    const rows = [
      ['Own time', n['Actual Total Time'] != null ? fmtMs(n._self) : '—'],
      ['Share of query', (n._share * 100).toFixed(1) + '%'],
    ];
    if (n._misestimate) rows.push(['⚠ Estimate error', `actual rows are ${n._misestimate >= 1 ? n._misestimate.toFixed(0) + '× more' : (1 / n._misestimate).toFixed(0) + '× fewer'} than estimated`]);
    for (const [k, v] of Object.entries(n)) {
      if (skip.has(k) || k.startsWith('_')) continue;
      rows.push([k, Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)]);
    }
    const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return `<h4>${esc(title(n))}</h4><p class="muted">${esc(explainNode(n))}</p><table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
  }

  // Plain-language description of common node types
  function explainNode(n) {
    const map = {
      'Seq Scan': 'Reads every row of the table and filters them. Fine for small tables or when most rows match.',
      'Index Scan': 'Walks a B-tree index to find matching rows, then fetches each row from the table.',
      'Index Only Scan': 'Answers the query from the index alone, without visiting the table.',
      'Bitmap Heap Scan': 'Fetches table pages flagged by a bitmap index scan, in physical order.',
      'Bitmap Index Scan': 'Builds a bitmap of matching row locations from an index.',
      'Hash Join': 'Builds a hash table from one input, then probes it with rows from the other.',
      'Hash': 'Builds the in-memory hash table used by a Hash Join.',
      'Merge Join': 'Joins two inputs that are already sorted on the join key.',
      'Nested Loop': 'For each row of the outer input, looks up matching rows in the inner input.',
      'Sort': 'Sorts rows, in memory or on disk if they do not fit in work_mem.',
      'Aggregate': 'Computes aggregates such as count, sum or avg.',
      'Limit': 'Stops after the requested number of rows.',
      'Gather': 'Collects rows from parallel worker processes.',
      'Gather Merge': 'Collects already-sorted rows from parallel workers, keeping the order.',
      'WindowAgg': 'Computes window functions (OVER ...) across groups of rows.',
      'Materialize': 'Caches its input so it can be re-read cheaply.',
      'Memoize': 'Caches inner lookups of a nested loop by key.',
      'ModifyTable': 'Performs the INSERT, UPDATE or DELETE.',
      'CTE Scan': 'Reads rows produced by a WITH (common table expression).',
      'Subquery Scan': 'Reads the output of a subquery.',
      'Incremental Sort': 'Sorts using an order that is already partly present in its input.',
      'Result': 'Computes values without reading a table.',
    };
    return map[n['Node Type']] || '';
  }

  return { render, details, annotate, fmtMs };
})();

// Token Radar's plain dashboard. It reads window.RADAR (written beside dashboard/
// by main.ts) and renders the ranked board, a filterable table, a per-protocol
// detail view with the model's own inputs and the protocol's farm plan, and the
// model itself, in full, so a reader can recompute any row. No network: every
// byte it shows is in data.js. The address hash drives the view, so a link can
// open the board, a category, or one protocol's detail: #/detail/<slug>,
// #/category/<name>, #/chain/<name>, #/tab/live, #/q/<text>.
(function () {
  'use strict';

  var DATA = window.RADAR;
  var app = document.getElementById('board');
  if (!DATA || !app) return;

  var state = { q: '', category: 'all', chain: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // The model in one function: the page recomputes a row from the snapshot
  // figures and checks the number board.json carries, so the page's code and
  // the board's data are visibly the same arithmetic.
  function impliedOf(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = age <= model.maturity_peak_days
      ? model.maturity_floor + (1 - model.maturity_floor) * (age / model.maturity_peak_days)
      : 1 - model.maturity_decay * (Math.min(age - model.maturity_peak_days, model.maturity_decay_days) / model.maturity_decay_days);
    var breadth = 1 + model.breadth_per_chain * Math.min(Math.max(row.chains.length - 1, 0), model.breadth_max_chains);
    return Math.max(1, Math.round(row.tvl_usd * model.base_multiple * growthMult * maturity * breadth * row.model.category_prior));
  }

  function addChild(node, child) {
    if (child === null || child === undefined) return;
    if (Array.isArray(child)) { child.forEach(function (c) { addChild(node, c); }); return; }
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) addChild(node, arguments[i]);
    return node;
  }

  function readHash() {
    var h = location.hash.replace(/^#\/?/, '');
    var parts = h.split('/').map(function (p) { return decodeURIComponent(p); });
    state.selected = null; state.category = 'all'; state.chain = 'all'; state.tab = 'pre-token'; state.q = '';
    if (parts[0] === 'detail' && parts[1]) state.selected = parts[1];
    else if (parts[0] === 'category' && parts[1]) state.category = parts[1];
    else if (parts[0] === 'chain' && parts[1]) state.chain = parts[1];
    else if (parts[0] === 'tab' && parts[1] === 'live') state.tab = 'live';
    else if (parts[0] === 'q' && parts[1]) state.q = parts[1];
  }
  function setHash() {
    var h = '#/';
    if (state.selected) h += 'detail/' + encodeURIComponent(state.selected);
    else if (state.category !== 'all') h += 'category/' + encodeURIComponent(state.category);
    else if (state.chain !== 'all') h += 'chain/' + encodeURIComponent(state.chain);
    else if (state.tab === 'live') h += 'tab/live';
    else if (state.q) h += 'q/' + encodeURIComponent(state.q);
    if (location.hash !== h) history.replaceState(null, '', h === '#/' ? location.pathname : h);
  }

  function visibleRows() {
    var rows = DATA.rows.filter(function (r) {
      if (state.q) {
        var q = state.q.toLowerCase();
        if ((r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) === -1) return false;
      }
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) === -1) return false;
      return true;
    });
    var key = state.sort;
    rows.sort(function (a, b) {
      var av = key === 'tvl' ? a.tvl_usd : key === 'growth' ? (a.change_7d || 0) : key === 'age' ? (a.age_days || 0) : a.implied_value_usd;
      var bv = key === 'tvl' ? b.tvl_usd : key === 'growth' ? (b.change_7d || 0) : key === 'age' ? (b.age_days || 0) : b.implied_value_usd;
      return (av - bv) * state.dir || (a.slug < b.slug ? -1 : 1);
    });
    return rows;
  }

  function sortHeader(label, key) {
    var arrow = state.sort === key ? (state.dir === -1 ? ' ↓' : ' ↑') : '';
    return el('th', { 'class': 'num' }, el('button', {
      text: label + arrow, 'aria-label': 'Sort by ' + label,
      onclick: function () {
        if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; }
        render();
      }
    }));
  }

  function render() {
    app.setAttribute('aria-busy', 'false');
    app.innerHTML = '';
    var wrap = el('div', { 'class': 'wrap' });
    app.appendChild(wrap);

    var header = el('header', {},
      el('h1', {}, el('span', { 'class': 'radar', text: 'Token Radar' }), ' — pre-token protocols, ranked'),
      el('p', { 'class': 'lede', text: 'Every protocol in the sealed DefiLlama snapshot that records no token and could still launch one of its own, ranked by implied launch value. The whole watchlist is in here; the rest is the early radar below the floor.' })
    );
    wrap.appendChild(header);

    var stats = el('div', { 'class': 'stats' });
    [
      [String(DATA.board_size), 'ranked protocols'],
      [String(DATA.watchlist_size), 'on the watchlist'],
      [String(DATA.early_size), 'early radar, below the floor'],
      [String(DATA.live_size), 'live-token, shown apart'],
      [fmtUsd(DATA.floor_usd), 'watchlist floor (TVL)'],
      [DATA.as_of, 'snapshot date'],
    ].forEach(function (s) { stats.appendChild(el('div', { 'class': 'stat' }, el('b', { text: s[0] }), el('span', { text: s[1] }))); });
    wrap.appendChild(stats);

    var categories = [];
    DATA.rows.forEach(function (r) { if (r.category && categories.indexOf(r.category) === -1) categories.push(r.category); });
    categories.sort();
    var chains = [];
    DATA.rows.forEach(function (r) { r.chains.forEach(function (c) { if (chains.indexOf(c) === -1) chains.push(c); }); });
    chains.sort();

    var controls = el('div', { 'class': 'controls' });
    var search = el('input', { type: 'search', placeholder: 'Search a protocol…', value: state.q, 'aria-label': 'Search protocols' });
    search.addEventListener('input', function () { state.q = search.value; state.selected = null; setHash(); renderTable(); });
    controls.appendChild(search);
    var catSel = el('select', { 'aria-label': 'Filter by category' });
    catSel.appendChild(el('option', { value: 'all', text: 'All categories' }));
    categories.forEach(function (c) { catSel.appendChild(el('option', { value: c, text: c })); });
    catSel.value = state.category;
    catSel.addEventListener('change', function () { state.category = catSel.value; state.selected = null; setHash(); renderTable(); });
    controls.appendChild(catSel);
    var chainSel = el('select', { 'aria-label': 'Filter by chain' });
    chainSel.appendChild(el('option', { value: 'all', text: 'All chains' }));
    chains.forEach(function (c) { chainSel.appendChild(el('option', { value: c, text: c })); });
    chainSel.value = state.chain;
    chainSel.addEventListener('change', function () { state.chain = chainSel.value; state.selected = null; setHash(); renderTable(); });
    controls.appendChild(chainSel);
    var tabs = el('div', { 'class': 'tabs' });
    [['pre-token', 'Pre-token'], ['live', 'Live token']].forEach(function (t) {
      tabs.appendChild(el('button', {
        text: t[1], 'aria-pressed': String(state.tab === t[0]),
        onclick: function () { state.tab = t[0]; state.selected = null; setHash(); render(); }
      }));
    });
    controls.appendChild(tabs);
    wrap.appendChild(controls);

    var detailHost = el('div', { id: 'detail' });
    wrap.appendChild(detailHost);
    var tableHost = el('div', { id: 'table' });
    wrap.appendChild(tableHost);

    var method = el('section', { 'class': 'method' },
      el('h2', { text: 'How the model works' }),
      el('p', { text: 'Implied value follows only from the snapshot\'s own figures — TVL, seven-day growth, age with no token, chain count and category. No protocol name is special-cased; the same function scores every row.' }),
      el('div', { 'class': 'formula', text:
        'base       = TVL × 0.30\n' +
        'growth     = clamp(7d change, −50%, +150%)\n' +
        'growthMult = 1 + growth × 0.60\n' +
        'maturity   = 0.70 + 0.30 × min(age, 730d) / 730d, easing down 0.15 over the next 1,095 days\n' +
        'breadth    = 1 + 0.03 × min(chains − 1, 5)\n' +
        'category   = stated prior, 0.90–1.15 (see the model)\n' +
        'implied    = max(1, round(base × growthMult × maturity × breadth × category))' }),
      el('ul', {},
        el('li', { text: 'TVL is the anchor: a token\'s launch value scales with the value already locked in the protocol.' }),
        el('li', { text: 'Seven-day growth is momentum: a protocol gaining TVL is gaining the users a launch would pay.' }),
        el('li', { text: 'Maturity rewards survival up to two years with no token, then eases: a protocol that has run for years without launching is less likely to.' }),
        el('li', { text: 'Breadth rewards distribution: a protocol live on more chains reaches more farmers.' }),
        el('li', { text: 'The category prior is a stated assumption, kept small (at most 15%) so it reorders neighbours, never the board.' }),
        el('li', { text: 'Live-token protocols are shown apart with the market\'s own values, never mixed into the ranked board.' })
      ),
      el('p', { text: 'Farm plans are derived from each protocol\'s own record — its category, its chain, its TVL and its age — and every step states its cost and its time. Never pay a fee to claim a reward, and never enter a seed phrase or a private key anywhere.' })
    );
    wrap.appendChild(method);
    wrap.appendChild(el('footer', { text: 'Source: ' + DATA.source + ' · Snapshot as of ' + DATA.as_of + ' · Model ' + DATA.model_version + ' · Built from the sealed snapshot only; no live prices, no network.' }));

    renderTable();

    function renderTable() {
      tableHost.innerHTML = '';
      detailHost.innerHTML = '';
      var selected = null;
      if (state.selected) {
        selected = DATA.rows.filter(function (r) { return r.slug === state.selected; })[0] || null;
      }
      if (selected) renderDetail(detailHost, selected, !!state.scrollToDetail);
      state.scrollToDetail = false;

      if (state.tab === 'live') {
        var live = DATA.live.slice();
        var note = el('p', { 'class': 'note', text: 'These protocols already trade a token, so the board does not rank them. Their market capitalisation is the market\'s own verdict, shown here for comparison.' });
        tableHost.appendChild(note);
        var lt = el('table', {},
          el('thead', {}, el('tr', {},
            el('th', { text: 'Protocol' }), el('th', { text: 'Category' }),
            el('th', { 'class': 'num', text: 'TVL' }), el('th', { 'class': 'num', text: 'Market cap' }),
            el('th', { 'class': 'num', text: '7d' }))),
          el('tbody', {}, live.map(function (r) {
            return el('tr', {},
              el('td', {}, el('span', { 'class': 'name', text: r.name }), el('div', { 'class': 'sub', text: r.slug })),
              el('td', { text: r.category || '—' }),
              el('td', { 'class': 'num', text: fmtUsd(r.tvl_usd) }),
              el('td', { 'class': 'num', text: fmtUsd(r.mcap_usd) }),
              el('td', { 'class': 'num', text: fmtPct(r.change_7d), 'class': 'num ' + ((r.change_7d || 0) >= 0 ? 'up' : 'down') }));
          }))
        );
        tableHost.appendChild(lt);
        return;
      }

      var rows = visibleRows();
      var count = el('p', { 'class': 'note', text: rows.length + ' of ' + DATA.rows.length + ' ranked protocols' + (state.category !== 'all' ? ' in ' + state.category : '') + (state.chain !== 'all' ? ' on ' + state.chain : '') + (state.q ? ' matching "' + state.q + '"' : '') + '. Click a row for its model breakdown and farm plan.' });
      tableHost.appendChild(count);
      if (rows.length === 0) {
        tableHost.appendChild(el('div', { 'class': 'empty', text: 'Nothing matches. Clear the search or the filters.' }));
        return;
      }
      var table = el('table', {},
        el('thead', {}, el('tr', {},
          el('th', { text: '#' }),
          el('th', { text: 'Protocol' }),
          el('th', { text: 'Category' }),
          sortHeader('TVL', 'tvl'),
          sortHeader('7d', 'growth'),
          sortHeader('Age', 'age'),
          sortHeader('Implied value', 'implied'))),
        el('tbody', {}, rows.map(function (r) {
          var onWatch = isOnWatch(r.slug);
          return el('tr', {
            'aria-selected': String(state.selected === r.slug),
            onclick: function () { state.selected = r.slug; state.scrollToDetail = true; setHash(); renderTable(); }
          },
            el('td', { text: String(r.rank) }),
            el('td', {}, el('span', { 'class': 'name', text: r.name }),
              el('div', { 'class': 'sub' }, el('span', { text: r.slug + ' · ' + r.chains.join(', ') + ' ' }),
                onWatch ? el('span', { 'class': 'pill watch', text: 'watchlist' }) : null)),
            el('td', { text: r.category || '—' }),
            el('td', { 'class': 'num', text: fmtUsd(r.tvl_usd) }),
            el('td', { 'class': 'num ' + ((r.change_7d || 0) >= 0 ? 'up' : 'down'), text: fmtPct(r.change_7d) }),
            el('td', { 'class': 'num', text: fmtAge(r.age_days) }),
            el('td', { 'class': 'num', text: fmtUsd(r.implied_value_usd) }));
        }))
      );
      tableHost.appendChild(table);
    }

    function isOnWatch(slug) {
      // The watchlist is the snapshot's own list; the first 40 ranks are not
      // the watchlist. This set is rebuilt from the data the page was given.
      return (DATA.watchlist_slugs || []).indexOf(slug) !== -1;
    }

    function renderDetail(host, row, scroll) {
      var m = row.model;
      var recomputed = impliedOf(row, DATA.model);
      var check = recomputed === row.implied_value_usd ? 'matches the board' : 'differs from the board';
      var panel = el('section', { 'class': 'detail', 'aria-label': 'Detail for ' + row.name },
        el('h2', { text: row.name + ' — rank #' + row.rank }),
        el('p', { 'class': 'meta', text: (row.category || 'Uncategorised') + ' · ' + row.chains.join(', ') + ' · snapshot ' + DATA.as_of + ' · watchlist: ' + (isOnWatch(row.slug) ? 'yes' : 'no') }),
        el('h3', { text: 'Implied launch value' }),
        el('dl', {},
          el('div', {}, el('dt', { text: 'Implied value' }), el('dd', { text: fmtUsd(row.implied_value_usd) })),
          el('div', {}, el('dt', { text: 'TVL × 0.30 (base)' }), el('dd', { text: fmtUsd(m.base_usd) })),
          el('div', {}, el('dt', { text: '7d growth' }), el('dd', { text: fmtPct(m.growth_pct) + ' → ×' + m.growth_multiplier.toFixed(2) })),
          el('div', {}, el('dt', { text: 'Maturity (' + fmtAge(m.age_days) + ')' }), el('dd', { text: '×' + m.maturity_multiplier.toFixed(2) })),
          el('div', {}, el('dt', { text: 'Breadth (' + row.chains.length + ' chain' + (row.chains.length === 1 ? '' : 's') + ')' }), el('dd', { text: '×' + m.breadth_multiplier.toFixed(2) })),
          el('div', {}, el('dt', { text: 'Category prior' }), el('dd', { text: '×' + m.category_prior.toFixed(2) }))
        ),
        el('p', { 'class': 'note', text: 'Recomputed from the snapshot figures on this page: ' + fmtUsd(recomputed) + ' — ' + check + '.' }),
        el('h3', { text: 'Farm plan' }),
        el('ol', {}, row.farm_steps.map(function (s) { return el('li', { text: s }); }))
      );
      host.appendChild(panel);
      if (scroll) panel.scrollIntoView({ block: 'nearest' });
    }
  }

  readHash();
  render();
  window.addEventListener('hashchange', function () { readHash(); render(); });
})();

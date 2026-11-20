'use strict';

const $ = (id) => document.getElementById(id);
const escape = (value) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = new Intl.NumberFormat('en-US');
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 });
const usd = (value) => value == null ? 'Not recorded' : dollars.format(value).replace('-', '−');
const brief = (value) => value == null ? '—' : compact.format(value);
const fixed = (value, digits = 3) => value.toFixed(digits).replace('-', '−');
const pct = (value) => `${number.format(Math.round(value * 10) / 10).replace('-', '−')}%`;
const movement = (value) => value == null ? '—' : `${value > 0 ? '+' : ''}${pct(value)}`;
const detailHash = (slug) => `#detail=${encodeURIComponent(slug)}`;

function start(data) {
  const { rows, live, excluded, meta, model, watchlist } = data;
  const views = { ranked: rows, live, excluded };
  const universe = [...rows, ...live, ...excluded];
  const lookup = new Map(universe.map(peer => [peer.slug, peer]));
  const onWatch = new Set(watchlist);
  const covered = watchlist.filter(slug => rows.some(peer => peer.slug === slug)).length;
  const { counts, model_tests: tests, assumptions, coefficients } = meta;
  const splitA = tests.A_to_B;
  const splitB = tests.B_to_A;
  const walk = tests.walk_forward;
  const perPage = 12;
  const state = { view: 'ranked', page: 1, sort: 'rank', direction: 1, returnHash: '#' };
  const defaultSort = { ranked: ['rank', 1], live: ['value', -1], excluded: ['tvl', -1] };

  function renderEvidence() {
    $('edition').textContent = meta.as_of;
    $('watch-cover').textContent = `WATCHLIST / ${covered} OF ${watchlist.length}`;
    const kpi = (label, value, note) => `<div><p class="kpi-label">${label}</p><strong>${value}</strong><small>${note}</small></div>`;
    $('kpi').innerHTML = [
      kpi('01 / Coverage', `${universe.length}/${counts.total} accounted for`, `${counts.ranked} ranked · ${counts.live} live · ${counts.excluded} excluded with reasons`),
      kpi('02 / Comps fit', `R² = ${fixed(meta.r2_in_sample)}`, `${counts.comps_training} market-cap comps · snapshot ${escape(meta.as_of)}`),
      kpi('03 / Held-out MdAPE — A→B / B→A', `${pct(splitA.mdape_pct)} / ${pct(splitB.mdape_pct)}`, `Log R² ${fixed(splitA.r2)} / ${fixed(splitB.r2)}`),
      kpi('04 / Walk-forward MdAPE', pct(walk.mdape_pct), `Log R² ${fixed(walk.r2)} · ${walk.n_test} test rows`),
      `<div class="aux">Odds AUC ${fixed(meta.odds_auc)} in sample · ${fixed(tests.odds.A_to_B.auc)} A→B / ${fixed(tests.odds.B_to_A.auc)} B→A held out · final log loss ${fixed(meta.odds_final_loss)}</div>`,
      '<div class="aux">MdAPE is the typical error; MAPE is dominated by a few 100x outliers — both are reported in the comparison table below.</div>',
    ].join('');
    $('integrity').innerHTML = `<span><b>SOURCE</b> DefiLlama snapshot · ${escape(meta.as_of)}</span>
      <span><b>FORMULA</b> fitted market cap × P(token on record)</span>
      <span>No protocol name is hardcoded — every row is scored by the same fitted functions.</span>
      <span>Deterministic: two runs write identical bytes.</span>`;

    const { a, b, c, d } = coefficients;
    const coefficient = (value) => `${value >= 0 ? '+' : '−'} ${Math.abs(value).toFixed(6)}`;
    const cohorts = [['A→B', 'A_to_B'], ['B→A', 'B_to_A'], ['Walk-forward', 'walk_forward']];
    const metrics = result => `<td class="num">${fixed(result.r2)}</td><td class="num">${pct(result.mape_pct)}</td><td class="num">${pct(result.mdape_pct)}</td>`;
    const { fastest_quartile: fast, remaining } = meta.growth_context;
    const gas = Object.entries(assumptions.round_trip_gas_usd).map(([chain, cost]) => `<span>${escape(chain)} ${usd(cost)}</span>`).join('');
    $('method-content').innerHTML = `<div class="method-grid">
      <article class="sheet"><h3>01. Fit a market-cap curve</h3>
      <p class="formula">log₁₀(cap) = ${fixed(a, 6)} ${coefficient(b)} × log₁₀(TVL) ${coefficient(c)} × (growth / 100) ${coefficient(d)} × log₁₀(age + 1) + category offset</p>
      <p>OLS on ${counts.comps_training} token records with positive reported cap and TVL. Growth is clipped to [−60%, +120%]; missing growth is 0%. Missing listing age uses ${assumptions.missing_age_days} days. Category offsets use half the median residual of categories with at least five fit rows, capped at ±0.3 log points.</p>
      <p>The fitted growth coefficient is negative. In this snapshot the fastest-growing quartile of comps is younger and has smaller token caps: median ${number.format(fast.median_age_days)} vs. ${number.format(remaining.median_age_days)} days, and ${brief(fast.median_mcap_usd)} vs. ${brief(remaining.median_mcap_usd)}. This is an association, not a causal explanation.</p>
      <p>Exponentiate and clamp market cap to $1–$100T. Multiply by unrounded token odds, round to whole dollars, and floor at $1.</p></article>
      <article class="sheet"><h3>02. Fit token odds</h3>
      <p>Logistic regression classifies whether market cap, symbol or coin ID is recorded. It uses standardized log TVL, log(age + 1), clipped growth and category indicators with at least 30 fit rows. It starts from zero and runs ${number.format(model.odds.iterations)} batch steps at rate ${model.odds.learning_rate}.</p>
      <p>Full-snapshot AUC ${fixed(meta.odds_auc)}; final mean log loss ${fixed(meta.odds_final_loss)}. Held-out AUC: ${fixed(tests.odds.A_to_B.auc)} on ${tests.odds.A_to_B.n_test} rows (A→B); ${fixed(tests.odds.B_to_A.auc)} on ${tests.odds.B_to_A.n_test} rows (B→A). These odds describe token records, not future issuance or its timing.</p></article>
      <article class="sheet"><h3>03. Test on unseen peers</h3>
      <p>A = even slug character-code sum; B = odd. Reverse train and test, refitting every term. Walk-forward separates before vs. on/after ${escape(walk.cutoff)}, omitting ${walk.n_unknown} unknown dates. Both sides still use features from the sealed snapshot; this is a cohort test, not a historical backtest.</p>
      <p>Pooled split-half MAPE: ${pct(tests.split_pooled_mape_pct)}; MdAPE: ${pct(tests.split_pooled_mdape_pct)}. A few extreme relative errors on small caps pull up the mean; the median describes a typical error. Negative log R² means worse than the held-out mean baseline.</p></article>
      <article class="sheet"><h3>04. Budget the farm</h3>
      <p>Assume a ${pct(assumptions.airdrop_share * 100)} farmer allocation shared pro rata against ${usd(assumptions.farmed_capital_usd)} total farmed capital. Expected value = round(implied value × allocation × deposit ÷ total capital). Subtract assumed round-trip gas and any cover premium allowance. Trading, price and principal risk are not included.</p>
      <p>$50 / $100 / $150 / $250 deposit tiers start below $100M / at $100M / at $1B / at $5B TVL. Hold 60 days below age 180, 45 below age 365, otherwise 30 (also 30 if age is unknown).</p>
      <div class="gas-list" aria-label="Assumed round-trip gas by chain">${gas}</div></article>
    </div><article class="sheet comparison"><h3>Four models, identical holdouts</h3>
      <p>All models refit on each training partition. TVL-only uses no category adjustments; the category ratio uses at least five fit rows or falls back to the global median. All predictions use the same cap bounds.</p>
      <div class="table-wrap"><table aria-label="Held-out model comparison"><thead><tr><th rowspan="2" scope="col">Model</th>${cohorts.map(([label, key]) => `<th colspan="3" scope="colgroup">${label} · ${tests[key].n_train} fit / ${tests[key].n_test} test</th>`).join('')}</tr>
      <tr>${cohorts.map(() => '<th class="num" scope="col">Log R²</th><th class="num" scope="col">MAPE</th><th class="num" scope="col">MdAPE</th>').join('')}</tr></thead>
      <tbody>${meta.model_comparison.map(variant => `<tr><th scope="row">${escape(variant.model)}${variant.primary ? ' · primary' : ''}</th>${cohorts.map(([, key]) => metrics(variant[key])).join('')}</tr>`).join('')}</tbody></table></div>
      <p>TVL-only leads on log R² across all three holdouts. OLS-full has the lowest MdAPE in both split halves, not in the walk-forward cohort. It remains primary because it includes TVL, growth and age, not because it wins every metric. Treat these values as research scenarios, not forecasts.</p></article>
    <p class="caution">Sealed source: ${escape(meta.source)}. Snapshot labels can be incomplete. Excluded: ${counts.cex} CEX, ${counts.versioned} versioned, ${counts.bridge_wrapped_staked} bridge/wrapped/staked, ${counts.exchange_named} exchange-named.</p>`;
  }

  const defaults = { category: 'All categories', chain: 'All chains' };
  function populateFilters() {
    for (const id of Object.keys(defaults)) {
      const values = [...new Set(universe.flatMap(peer => id === 'chain' ? peer.chains : [peer.category].filter(Boolean)))].sort();
      $(id).replaceChildren(new Option(defaults[id], ''), ...values.map(value => new Option(value, value)));
    }
  }

  const filterIds = ['category', 'chain', 'band', 'search'];
  function clearFilters() {
    for (const id of filterIds) $(id).value = '';
  }
  function setView(view) {
    state.view = view;
    state.page = 1;
    [state.sort, state.direction] = defaultSort[view];
  }

  const columns = {
    rank: ['Rank', peer => peer.rank, peer => `<td class="num">${String(peer.rank).padStart(2, '0')}</td>`],
    name: ['Protocol', peer => peer.name, peer => `<td class="protocol"><a href="${escape(detailHash(peer.slug))}">${escape(peer.name)}</a>${onWatch.has(peer.slug) ? '<span class="tag">WATCH</span>' : ''}<small class="chain-summary">${escape(peer.chains[0] ?? 'Unlisted chain')}${peer.chains.length > 1 ? ` +${peer.chains.length - 1}` : ''}</small></td>`],
    category: ['Category', peer => peer.category, peer => `<td>${escape(peer.category ?? 'Uncategorized')}</td>`],
    value: ['Implied value', peer => peer.implied_value_usd ?? peer.mcap_usd, peer => `<td class="num value" title="${escape(usd(peer.implied_value_usd ?? peer.mcap_usd))}">${brief(peer.implied_value_usd ?? peer.mcap_usd)}</td>`],
    tvl: ['TVL', peer => peer.tvl_usd, peer => `<td class="num" title="${usd(peer.tvl_usd)}">${brief(peer.tvl_usd)}</td>`],
    growth: ['7D growth', peer => peer.change_7d, peer => `<td class="num ${peer.change_7d > 0 ? 'up' : peer.change_7d < 0 ? 'down' : ''}">${movement(peer.change_7d)}</td>`],
    age: ['Age', peer => peer.listed_at ? peer.age_days : null, peer => `<td class="num">${peer.listed_at ? `${number.format(peer.age_days)}d` : '—'}</td>`],
    odds: ['Token odds', peer => peer.model?.token_odds, peer => `<td class="num">${pct(peer.model.token_odds * 100)}</td>`],
    reason: ['Exclusion reason', peer => peer.reason, peer => `<td class="value">${escape(peer.reason)}</td>`],
  };
  const rankedColumns = ['rank', 'name', 'category', 'value', 'tvl', 'growth', 'age', 'odds'];
  const otherColumns = ['name', 'category', 'tvl', 'growth', 'age'];
  const columnSets = { ranked: rankedColumns, live: [...otherColumns.slice(0, 2), 'value', ...otherColumns.slice(2)], excluded: [...otherColumns, 'reason'] };
  const textColumns = new Set(['name', 'category', 'reason']);
  const tier = tvl => tvl < 1e8 ? '0' : tvl < 1e9 ? '1' : tvl < 5e9 ? '2' : '3';

  function renderBoard(focusSort) {
    const [category, chain, band, rawSearch] = filterIds.map(id => $(id).value);
    const query = rawSearch.trim().toLowerCase();
    const pool = views[state.view];
    const matches = pool.filter(peer => (!category || peer.category === category) && (!chain || peer.chains.includes(chain)) &&
      (!band || tier(peer.tvl_usd) === band) && (!query || `${peer.name} ${peer.slug}`.toLowerCase().includes(query)));
    const sortValue = columns[state.sort][1];
    matches.sort((left, right) => {
      const a = sortValue(left), b = sortValue(right);
      if (a == null && b != null) return 1;
      if (a != null && b == null) return -1;
      if (a < b) return -state.direction;
      if (a > b) return state.direction;
      return (left.rank ?? 0) - (right.rank ?? 0) || (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0);
    });
    for (const tab of document.querySelectorAll('[data-view]')) {
      tab.setAttribute('aria-pressed', tab.dataset.view === state.view);
      tab.querySelector('span').textContent = views[tab.dataset.view].length;
    }
    const active = [category && `Category: ${category}`, chain && `Chain: ${chain}`, band && $('band').selectedOptions[0].text, query && `Search: ${rawSearch.trim()}`].filter(Boolean);
    $('result').textContent = `${matches.length} of ${pool.length} protocols${active.length ? ` · ${active.join(' · ')}` : ''}`;
    $('table-note').textContent = state.view === 'ranked' ? `Snapshot watchlist: ${covered}/${watchlist.length} ranked · Select a protocol to open its farm plan` :
      state.view === 'live' ? 'Market cap as recorded · A dash means no reported cap' : 'Not scored · CEX, versioned, bridge/wrapped/staked, or exchange-named';
    const visible = columnSets[state.view];
    $('board').tHead.innerHTML = `<tr>${visible.map(key => {
      const label = state.view === 'live' && key === 'value' ? 'Market cap' : columns[key][0];
      const sorted = key === state.sort;
      const direction = state.direction === 1 ? 'ascending' : 'descending';
      const arrow = sorted ? (state.direction === 1 ? '↑' : '↓') : '↕';
      return `<th scope="col" class="${textColumns.has(key) ? '' : 'num'}"${sorted ? ` aria-sort="${direction}"` : ''}><button type="button" data-sort="${key}">${label} <span aria-hidden="true">${arrow}</span></button></th>`;
    }).join('')}</tr>`;
    const start = (state.page - 1) * perPage;
    const page = matches.slice(start, start + perPage);
    $('board').tBodies[0].innerHTML = page.length ? page.map(peer => `<tr data-slug="${escape(peer.slug)}">${visible.map(key => columns[key][2](peer)).join('')}</tr>`).join('') :
      `<tr><td colspan="${visible.length}">No matches. Reset filters or switch status.</td></tr>`;
    $('page-info').textContent = page.length ? `Showing ${start + 1}–${start + page.length} of ${matches.length} · Page ${state.page} of ${Math.ceil(matches.length / perPage)}` : 'No rows to display';
    $('prev').disabled = state.page === 1;
    $('next').disabled = start + perPage >= matches.length;
    if (focusSort) $('board').querySelector(`[data-sort="${focusSort}"]`).focus();
  }

  function renderDetail(peer) {
    const { model: fit, farm } = peer;
    const reasonText = {
      CEX: 'Centralized exchange without a token on record.',
      versioned: 'Name ends with a version marker; not ranked as a standalone launch.',
      'exchange-named': 'Name begins with an exchange name; not ranked as a standalone launch.',
      'bridge-wrapped-staked': 'Category or name matches the bridge, wrapped or staking-product exclusion.',
    };
    const pairs = items => items.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('');
    const status = fit ? `RANK ${String(peer.rank).padStart(3, '0')} / ${counts.ranked} · PRE-TOKEN RECORD${onWatch.has(peer.slug) ? ' · WATCHLIST' : ''}` : peer.reason ? 'EXCLUDED RECORD' : 'LIVE TOKEN RECORD';
    const headline = fit ? usd(peer.implied_value_usd) : peer.reason ?? usd(peer.mcap_usd);
    const facts = [ ['Snapshot TVL', usd(peer.tvl_usd)], ['7D TVL change', movement(peer.change_7d)],
      ['First tracked', peer.listed_at ?? 'Not recorded'], ['Age', peer.listed_at ? `${number.format(peer.age_days)} days` : 'Not recorded'] ];
    $('record').innerHTML = `<nav class="record-nav" aria-label="Record navigation"><a href="${escape(state.returnHash)}">← Back to launch board</a><span class="eyebrow">PROTOCOL RECORD / ${escape(peer.slug)}</span></nav>
      <header class="record-hero"><div><p class="eyebrow">${status}</p><h1 id="record-name" tabindex="-1">${escape(peer.name)}</h1><p>${escape(peer.category ?? 'Uncategorized')} · ${escape(peer.chains.join(', ') || 'Chain not recorded')} · TVL ${usd(peer.tvl_usd)}</p></div>
      <div class="record-value"><p class="eyebrow">${fit ? 'IMPLIED VALUE' : peer.reason ? 'EXCLUSION REASON' : 'MARKET CAP'}</p><strong>${escape(headline)}</strong><small>${fit ? 'Fitted cap × token odds' : 'As recorded in the snapshot'}</small></div></header>
      ${fit ? `<section><header class="section-head"><div><p class="eyebrow">01 / VALUATION</p><h2>Inside the estimate</h2></div></header>
      <dl class="breakdown">${pairs([['Fitted market cap', usd(fit.fitted_mcap_usd)], ['Token odds', `${fixed(fit.token_odds * 100, 2)}%`], ['7D TVL change', movement(peer.change_7d)], ['Growth used', movement(fit.growth_pct)], ['Age used', `${number.format(fit.age_days)} days`], ['Category offset (log₁₀)', fixed(fit.category_offset, 4)]])}</dl>
      <p class="record-caption">First tracked: ${escape(peer.listed_at ?? 'not recorded; age imputed')}. Odds classify existing token records. Comps errors on unseen peers were large; this rank is not a price forecast.</p></section>
      <section><header class="section-head"><div><p class="eyebrow">02 / FARM PLAN</p><h2>Entry, hold &amp; exit</h2></div><span class="eyebrow">${escape(peer.chains[0] ?? 'CHAIN UNLISTED')}</span></header>
      <dl class="budget">${pairs([['Deposit budget', usd(farm.deposit_usd)], ['Round-trip gas', usd(farm.gas_usd)], ['Hold window', `${farm.hold_days} days`], ['Expected value', usd(farm.expected_value_usd)], ['Net after costs', usd(farm.net_value_usd)]])}</dl>
      ${farm.premium_budget_usd ? `<p class="record-caption">Premium allowance: ${usd(farm.premium_budget_usd)} · Total cost: ${usd(farm.total_cost_usd)}</p>` : ''}
      <ol class="steps">${peer.farm_steps.map((step, index) => `<li><div><strong>${['Verify the route', 'Enter the position', 'Check the receipt', 'Monitor the hold', 'Exit the position', 'Net the budget'][index]}</strong><p>${escape(step)}</p></div></li>`).join('')}</ol>
      <p class="caution">Scenario only. No airdrop, eligibility, deposit support or fees are verified by this snapshot. Principal losses, slippage and taxes are not modeled.</p></section>` :
      `<section><header class="section-head"><div><p class="eyebrow">01 / SNAPSHOT FACTS</p><h2>What’s on record</h2></div></header><dl class="breakdown">${pairs(facts)}</dl>
      <p class="record-caption">${reasonText[peer.reason] ?? 'The snapshot records a token identifier, symbol or market cap. This protocol is not scored as a pre-token launch.'}</p></section>`}`;
  }

  function route() {
    const hash = location.hash;
    const decode = (value) => { try { return decodeURIComponent(value); } catch { return value; } };
    const peer = hash.startsWith('#detail=') ? lookup.get(decode(hash.slice(8))) : null;
    $('overview').hidden = Boolean(peer);
    $('record').hidden = !peer;
    if (peer) {
      renderDetail(peer);
      window.scrollTo(0, 0);
      $('record-name').focus({ preventScroll: true });
      return;
    }
    if (hash.startsWith('#filter=')) {
      const filter = decode(hash.slice(8));
      const divider = filter.indexOf(':');
      const key = divider < 0 ? 'search' : filter.slice(0, divider);
      const value = divider < 0 ? filter : filter.slice(divider + 1);
      if (state.returnHash !== hash) {
        clearFilters();
        setView('ranked');
        if (key === 'status' && Object.hasOwn(views, value)) setView(value);
        else if (filterIds.includes(key)) $(key).value = value;
      }
    }
    if (hash !== '#method') state.returnHash = hash.startsWith('#filter=') ? hash : '#';
    renderBoard();
    if (hash === '#method') $('method').scrollIntoView();
  }

  function clearFilterHash() {
    if (location.hash.startsWith('#filter=')) history.replaceState(null, '', '#');
    state.returnHash = '#';
  }

  renderEvidence();
  populateFilters();
  document.querySelector('.views').addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    setView(button.dataset.view);
    clearFilterHash();
    renderBoard();
  });
  const filterChanged = () => { clearFilterHash(); state.page = 1; renderBoard(); };
  for (const id of filterIds) $(id).addEventListener(id === 'search' ? 'input' : 'change', filterChanged);
  $('reset').onclick = () => { clearFilters(); filterChanged(); };
  $('prev').onclick = () => { state.page--; renderBoard(); };
  $('next').onclick = () => { state.page++; renderBoard(); };
  $('board').addEventListener('click', event => {
    const key = event.target.closest('[data-sort]')?.dataset.sort;
    if (key) {
      state.direction = state.sort === key ? -state.direction : key === 'rank' || textColumns.has(key) ? 1 : -1;
      state.sort = key;
      state.page = 1;
      renderBoard(key);
    } else if (!event.target.closest('a')) {
      const row = event.target.closest('tr[data-slug]');
      if (row) location.hash = detailHash(row.dataset.slug);
    }
  });
  document.querySelector('.brand').onclick = () => { clearFilters(); setView('ranked'); clearFilterHash(); renderBoard(); window.scrollTo(0, 0); };
  window.addEventListener('hashchange', route);
  route();
}

if (window.RADAR) start(window.RADAR);
else $('load-error').hidden = false;

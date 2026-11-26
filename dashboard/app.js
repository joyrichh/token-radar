(() => {
  'use strict';

  const data = window.RADAR;
  if (!data) throw new Error('Radar data is missing. Run main.ts to generate data.js.');
  const { rows, live, excluded, meta, model } = data;
  const rankedTests = meta.model_tests.selected;
  const odds = model.token_odds;
  const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const oneDecimal = value => Number(value).toFixed(1);
  const signed = (value, digits = 3) => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(digits)}`;
  const money = value => value === null || value === undefined ? '—' : `$${number.format(value)}`;
  const percent = value => `${Number(value * 100).toFixed(2)}%`;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const state = { view: 'ranked', category: '', chain: '', band: '', query: '', page: 0, sort: 'value', direction: -1 };
  const pageSize = 15;
  const allRecords = [...rows, ...live, ...excluded];
  const bySlug = new Map(allRecords.map(row => [row.slug, row]));
  const labelByView = { ranked: 'ranked', live: 'live-token', excluded: 'excluded' };

  function setOptions(select, values, firstLabel) {
    select.replaceChildren(new Option(firstLabel, ''));
    for (const value of values) select.add(new Option(value, value));
  }

  const categories = [...new Set(allRecords.map(row => row.category || 'Uncategorized'))].sort();
  const chains = [...new Set(allRecords.flatMap(row => row.chains || []))].sort();
  setOptions(document.querySelector('#category'), categories, 'All categories');
  setOptions(document.querySelector('#chain'), chains, 'All chains');

  function populateSummary() {
    const { counts } = meta;
    const scoreline = `${counts.total}/${counts.total} protocols accounted for · ${counts.ranked} ranked · ${counts.live} live · ${counts.excluded} excluded · comps R²=${rankedTests.in_sample_r2.toFixed(2)} · held-out MAPE A→B ${oneDecimal(rankedTests.A_to_B.mape_pct)}% / B→A ${oneDecimal(rankedTests.B_to_A.mape_pct)}% · walk-forward MAPE ${oneDecimal(rankedTests.walk_forward.mape_pct)}% · snapshot ${meta.as_of}`;
    document.querySelector('#scoreline').textContent = scoreline;
    document.querySelector('#coverage-kpi').textContent = `${counts.total} / ${counts.total}`;
    document.querySelector('#partitions-kpi').textContent = `${counts.ranked} / ${counts.live} / ${counts.excluded}`;
    document.querySelector('#r2-kpi').textContent = rankedTests.in_sample_r2.toFixed(2);
    document.querySelector('#auc-kpi').textContent = `${odds.in_sample_auc.toFixed(3)} / ${odds.held_out_auc.pooled_out_of_fold.toFixed(3)}`;
    document.querySelector('#date-kpi').textContent = meta.as_of;
    document.querySelector('#heldout-kpi').innerHTML = `<b>Held-out Log R²</b> A→B ${signed(rankedTests.A_to_B.log_r2)} &nbsp;·&nbsp; B→A ${signed(rankedTests.B_to_A.log_r2)} &nbsp;·&nbsp; walk-forward ${signed(rankedTests.walk_forward.log_r2)} &nbsp;·&nbsp; <b>token-odds AUC</b> in-sample ${odds.in_sample_auc.toFixed(3)} / out-of-fold ${odds.held_out_auc.pooled_out_of_fold.toFixed(3)}`;
    document.querySelector('#source-line').textContent = `${meta.source} · as of ${meta.as_of}`;
    document.querySelector('#formula-line').textContent = model.formula;
    document.querySelector('#ranked-tab').textContent = `(${counts.ranked})`;
    document.querySelector('#live-tab').textContent = `(${counts.live})`;
    document.querySelector('#excluded-tab').textContent = `(${counts.excluded})`;
    document.querySelector('#method-formula').textContent = model.formula;
    const exclusions = meta.exclusions;
    document.querySelector('#coverage-note').textContent = `${counts.ranked} ranked + ${counts.live} live + ${counts.excluded} excluded = ${counts.total}; watchlist ${counts.watchlist}. Exclusions: ${exclusions.cex} CEX, ${exclusions.versioned} versioned, ${exclusions.bridge_wrapped_staked} bridge/wrapped/staked, ${exclusions.exchange_named} exchange-named. Of ${meta.audited_count} previously re-included audit rows, ${meta.audited_re_included} remain re-included and ${meta.audited_still_excluded} are excluded again. Rounded-value tie adjustments: ${meta.tie_adjustments}.`;
    document.querySelector('#eligibility-rules').innerHTML = meta.eligibility_rules.map(rule => `<li>${escapeHtml(rule)}</li>`).join('');
  }

  function rangeMatches(value) {
    switch (state.band) {
      case 'under-10': return value < 10_000_000;
      case '10-50': return value >= 10_000_000 && value < 50_000_000;
      case '50-250': return value >= 50_000_000 && value < 250_000_000;
      case '250-1000': return value >= 250_000_000 && value < 1_000_000_000;
      case 'over-1000': return value >= 1_000_000_000;
      default: return true;
    }
  }

  function valueFor(row) {
    if (state.view === 'ranked') return row.implied_value_usd;
    return row.mcap_usd;
  }

  function filteredRows() {
    const source = state.view === 'ranked' ? rows : state.view === 'live' ? live : excluded;
    const query = state.query.trim().toLowerCase();
    return source.filter(row => {
      const category = row.category || 'Uncategorized';
      return (!state.category || category === state.category) &&
        (!state.chain || (row.chains || []).includes(state.chain)) &&
        rangeMatches(row.tvl_usd) &&
        (!query || `${row.name} ${row.slug}`.toLowerCase().includes(query));
    }).sort((left, right) => {
      let first;
      let second;
      if (state.sort === 'rank') {
        first = left.rank ?? Number.MAX_SAFE_INTEGER;
        second = right.rank ?? Number.MAX_SAFE_INTEGER;
      } else if (state.sort === 'tvl') {
        first = left.tvl_usd;
        second = right.tvl_usd;
      } else {
        first = valueFor(left) ?? -1;
        second = valueFor(right) ?? -1;
      }
      if (first !== second) return (first < second ? -1 : 1) * state.direction;
      return left.slug.localeCompare(right.slug);
    });
  }

  function makeTableRow(row) {
    const kind = state.view === 'ranked' ? 'ranked' : state.view === 'live' ? 'live' : 'excluded';
    const viewValue = kind === 'ranked' ? row.implied_value_usd : row.mcap_usd;
    const status = kind === 'ranked' ? 'Ranked' : kind === 'live' ? 'Live token' : 'Excluded';
    const chainText = (row.chains || []).length ? row.chains.join(', ') : '—';
    const valueLabel = viewValue === null || viewValue === undefined ? 'No market cap recorded' : money(viewValue);
    const rank = kind === 'ranked' ? row.rank : '—';
    return `<tr data-slug="${escapeHtml(row.slug)}"><td class="rank-cell">${rank}</td><td class="protocol"><a href="#detail=${encodeURIComponent(row.slug)}">${escapeHtml(row.name)}</a><small>${escapeHtml(row.slug)} · <span class="status-chip ${kind}">${status}</span></small></td><td class="category-cell">${escapeHtml(row.category || 'Uncategorized')}</td><td class="chain-cell">${escapeHtml(chainText)}</td><td>${money(row.tvl_usd)}</td><td class="value-cell">${valueLabel}</td></tr>`;
  }

  function updateList() {
    const filtered = filteredRows();
    const maxPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
    state.page = Math.min(state.page, maxPage);
    const start = state.page * pageSize;
    const pageRows = filtered.slice(start, start + pageSize);
    const tbody = document.querySelector('#board tbody');
    tbody.innerHTML = pageRows.map(makeTableRow).join('');
    document.querySelector('#empty-state').hidden = filtered.length !== 0;
    const viewRows = state.view === 'ranked' ? rows : state.view === 'live' ? live : excluded;
    const filterNote = [
      `Category: ${state.category || 'all'}`,
      `Chain: ${state.chain || 'all'}`,
      `TVL: ${document.querySelector('#tvl-band').selectedOptions[0].textContent}`,
    ].join(' · ');
    document.querySelector('#result').textContent = `${filtered.length} of ${viewRows.length} ${labelByView[state.view]} · ${filterNote}`;
    document.querySelector('#page-info').textContent = `Page ${state.page + 1} of ${Math.max(1, maxPage + 1)}`;
    document.querySelector('#previous').disabled = state.page === 0;
    document.querySelector('#next').disabled = state.page >= maxPage;
    document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === state.view));
    document.querySelector('#status').value = state.view;
  }

  function metric(label, value) {
    return `<div class="record-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  }

  function showDetail(row) {
    document.querySelector('#overview').hidden = true;
    const panel = document.querySelector('#record');
    panel.hidden = false;
    const rankRow = row.rank !== undefined;
    const liveRow = row.mcap_usd !== null || row.gecko_id !== null || row.symbol !== null;
    document.querySelector('#record-name').textContent = row.name;
    document.querySelector('#record-kind').textContent = rankRow ? `Rank ${row.rank} · eligible pre-token record` : liveRow ? 'Live token record · not in the launch ranking' : 'Excluded from the ranked list';
    document.querySelector('#record-subline').textContent = `${row.slug} · ${row.category || 'Uncategorized'} · ${(row.chains || []).join(', ') || 'chain not listed'} · TVL ${money(row.tvl_usd)}`;
    const content = document.querySelector('#record-content');
    if (rankRow) {
      const values = [
        metric('Implied value', money(row.implied_value_usd)),
        metric('Fitted market cap', money(row.model.fitted_mcap_usd)),
        metric('Token odds', percent(row.model.token_odds)),
        metric('Observed growth · 7d', `${row.model.growth_pct.toFixed(1)}%`),
        metric('Listing age', `${Math.round(row.model.age_days)} days`),
        metric('Category offset', `${row.model.category_offset} · TVL-only`),
      ].join('');
      const farm = row.farm;
      const costs = [
        metric('Deposit', money(farm.deposit_usd)), metric('Gas budget', money(farm.gas_usd)),
        metric('Planned hold', `${farm.hold_days} days`), metric('Expected value', money(farm.expected_value_usd)),
        metric('Net value', money(farm.net_value_usd)),
      ].join('');
      const steps = row.farm_steps.map(step => `<li>${escapeHtml(step)}</li>`).join('');
      content.innerHTML = `<div class="record-grid">${values}</div><div class="record-copy"><p><b>Same fitted function for every row:</b> ${escapeHtml(model.formula)}.</p><p>Implied value = fitted market cap × token odds, rounded to whole dollars. TVL-only fit: category offset is exactly zero.</p></div><h3>Costed position</h3><div class="farm-summary">${costs}</div><h3>Six-step farm plan</h3><ol class="steps">${steps}</ol>`;
    } else if (liveRow) {
      const facts = [
        metric('Recorded market cap', row.mcap_usd === null ? 'Not supplied' : money(row.mcap_usd)),
        metric('Symbol', row.symbol || 'Not supplied'),
        metric('Gecko record', row.gecko_id || 'Not supplied'),
        metric('Seven-day TVL change', row.change_7d === null ? 'Not supplied' : `${row.change_7d.toFixed(1)}%`),
      ].join('');
      content.innerHTML = `<div class="record-grid">${facts}</div><div class="record-copy"><p>This row is in the live-token partition because the sealed source records a non-null market-cap field, Gecko ID, or symbol. The board shows reported market cap when present; it is not a modeled launch value.</p></div>`;
    } else {
      content.innerHTML = `<div class="record-grid">${metric('Recorded market cap', 'None')}${metric('Seven-day TVL change', row.change_7d === null ? 'Not supplied' : `${row.change_7d.toFixed(1)}%`)}${metric('Listing age', row.listed_at ? `${Math.round((Date.parse(meta.as_of) - Date.parse(row.listed_at)) / 86_400_000)} days` : 'Unknown')}${metric('Eligibility', 'Excluded')}</div><div class="record-copy"><p><b>Reason:</b> ${escapeHtml(row.reason)}</p><p>Excluded rows remain visible in the full 758-protocol partition and do not receive a launch rank or farm plan.</p></div>`;
    }
    window.scrollTo(0, 0);
  }

  function renderComparison() {
    document.querySelector('#comparison').innerHTML = meta.model_tests.comparison.map(variant => {
      const cell = result => `${signed(result.log_r2)} / ${oneDecimal(result.mape_pct)}% / ${oneDecimal(result.mdape_pct)}%<small>n=${result.n_train}→${result.n_test}</small>`;
      return `<tr class="${variant.model === 'OLS TVL-only' ? 'primary' : ''}"><td>${escapeHtml(variant.model)}</td><td>${variant.in_sample_r2.toFixed(3)}</td><td>${cell(variant.A_to_B)}</td><td>${cell(variant.B_to_A)}</td><td>${cell(variant.walk_forward)}<small>cutoff ${escapeHtml(variant.walk_forward.cutoff)}</small></td><td>${signed(variant.mean_held_out_log_r2)}</td></tr>`;
    }).join('');
    const baseline = meta.model_tests.iteration_2_baseline;
    document.querySelector('#baseline-note').innerHTML = `<strong>Iteration 2 baseline (OLS-full):</strong> R² ${baseline.in_sample_r2.toFixed(3)}; A→B ${signed(baseline.A_to_B.log_r2)}, B→A ${signed(baseline.B_to_A.log_r2)}, walk-forward ${signed(baseline.walk_forward.log_r2)}. Iteration 3 improves all three directional Log R² scores; walk-forward remains negative and outlier-driven.`;
    document.querySelector('#odds-note').innerHTML = `<strong>Token-odds validation:</strong> in-sample AUC ${odds.in_sample_auc.toFixed(4)}; held-out A→B ${odds.held_out_auc.A_to_B.toFixed(4)}, B→A ${odds.held_out_auc.B_to_A.toFixed(4)}, pooled out-of-fold ${odds.held_out_auc.pooled_out_of_fold.toFixed(4)}. Batch logistic fit: ${odds.iterations} iterations, learning rate ${odds.learning_rate}, zero initialization, ${odds.large_categories.length} category indicators (category threshold ${odds.large_category_min_count}).`;
  }

  function encodeFilter() {
    const parts = [['status', state.view], ['category', state.category], ['chain', state.chain], ['tvl', state.band], ['q', state.query]]
      .filter(([, value]) => value)
      .map(([key, value]) => `${key}:${encodeURIComponent(value)}`);
    const hash = `#filter=${parts.join('&')}`;
    if (location.hash !== hash) location.hash = hash;
    updateList();
  }

  function parseHash() {
    const hash = location.hash.slice(1);
    if (hash.startsWith('detail=')) {
      const row = bySlug.get(decodeURIComponent(hash.slice(7)));
      if (row) showDetail(row);
      return;
    }
    document.querySelector('#record').hidden = true;
    document.querySelector('#overview').hidden = false;
    state.category = '';
    state.chain = '';
    state.band = '';
    state.query = '';
    state.view = 'ranked';
    if (hash.startsWith('filter=')) {
      for (const pair of hash.slice(7).split('&')) {
        const separator = pair.indexOf(':');
        if (separator < 0) continue;
        const key = decodeURIComponent(pair.slice(0, separator));
        const value = decodeURIComponent(pair.slice(separator + 1));
        if (key === 'status' && ['ranked', 'live', 'excluded'].includes(value)) state.view = value;
        if (key === 'category') state.category = value;
        if (key === 'chain') state.chain = value;
        if (key === 'tvl') state.band = value;
        if (key === 'q') state.query = value;
      }
    }
    document.querySelector('#category').value = state.category;
    document.querySelector('#chain').value = state.chain;
    document.querySelector('#tvl-band').value = state.band;
    document.querySelector('#search').value = state.query;
    state.page = 0;
    updateList();
  }

  populateSummary();
  renderComparison();
  updateList();
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
    state.view = button.dataset.view;
    state.page = 0;
    encodeFilter();
  }));
  document.querySelector('#status').addEventListener('change', event => {
    state.view = event.target.value;
    state.page = 0;
    encodeFilter();
  });
  for (const [selector, key] of [['#category', 'category'], ['#chain', 'chain'], ['#tvl-band', 'band']]) {
    document.querySelector(selector).addEventListener('change', event => {
      state[key] = event.target.value;
      state.page = 0;
      encodeFilter();
    });
  }
  document.querySelector('#search').addEventListener('input', event => {
    state.query = event.target.value;
    state.page = 0;
    encodeFilter();
  });
  document.querySelector('#reset').addEventListener('click', () => {
    state.view = 'ranked';
    state.category = '';
    state.chain = '';
    state.band = '';
    state.query = '';
    state.page = 0;
    encodeFilter();
  });
  document.querySelector('#previous').addEventListener('click', () => {
    state.page = Math.max(0, state.page - 1);
    updateList();
  });
  document.querySelector('#next').addEventListener('click', () => {
    state.page++;
    updateList();
  });
  document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => {
    if (state.sort === button.dataset.sort) state.direction *= -1;
    else {
      state.sort = button.dataset.sort;
      state.direction = button.dataset.sort === 'rank' ? 1 : -1;
    }
    state.page = 0;
    updateList();
  }));
  window.addEventListener('hashchange', parseHash);
  parseHash();
})();

// value-line-card
// A Lovelace card that draws a sensor's history as a line whose colour follows the
// value against configurable thresholds, with an auto-scaling Y axis. The colour
// gradient is recomputed against the live data range on every refresh, so the line
// is always value-coloured AND never clipped by a fixed ceiling.
//
// Rendered as hand-written SVG (no charting library) so it never clashes with other
// chart cards on the same dashboard and stays tiny. The gradient is a userSpaceOnUse
// linearGradient pinned to the plot area, so each colour stop maps to a real value
// regardless of the line's shape.

const VERSION = '1.0.0';
const DEFAULTS = { height: 230, hours: 24, curve: 'smooth', stroke_width: 3 };
const HOUR = 36e5, DAY = 864e5;

class ValueLineCard extends HTMLElement {
  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error('value-line-card: "entity" is required');
    }
    if (!Array.isArray(config.thresholds) || config.thresholds.length < 2) {
      throw new Error('value-line-card: "thresholds" must be a list of at least two {value, color}');
    }
    const thresholds = [...config.thresholds].sort((a, b) => a.value - b.value);
    this._config = { ...DEFAULTS, ...config, thresholds };
    this._gid = 'vlc-' + Math.floor(Math.random() * 1e9).toString(36);
    this._fetchedOnce = false;
    this._points = null;
    this._built = false;
    this._build();
    if (this._hass) { this._fetchedOnce = true; this._refresh(); }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    if (!this._fetchedOnce) { this._fetchedOnce = true; this._refresh(); }
    this._updateHeader();
  }

  connectedCallback() {
    this._timer = setInterval(() => this._refresh(), 60000);
    if (this._els && window.ResizeObserver) {
      this._ro = new ResizeObserver(() => { if (this._points) this._renderChart(); });
      this._ro.observe(this._els.chart);
    }
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
  }

  // --- data -----------------------------------------------------------------

  _spanMs() {
    const c = this._config;
    if (c.days != null) return c.days * DAY;
    if (c.span != null) {
      const m = String(c.span).match(/^(\d+)\s*([hdw])/i);
      if (m) {
        const n = +m[1], u = m[2].toLowerCase();
        return n * (u === 'h' ? HOUR : u === 'd' ? DAY : 7 * DAY);
      }
    }
    return (c.hours || 24) * HOUR;
  }

  async _fetchData() {
    const c = this._config, ent = c.entity;
    const end = new Date();
    const start = new Date(end.getTime() - this._spanMs());
    if (c.statistics) {
      const res = await this._hass.callWS({
        type: 'recorder/statistics_during_period',
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        statistic_ids: [ent],
        period: c.period || 'hour',
        types: [c.statistics],
      });
      const arr = (res && res[ent]) || [];
      return arr
        .map((r) => [typeof r.start === 'number' ? r.start : new Date(r.start).getTime(), r[c.statistics]])
        .filter((p) => p[1] != null && !isNaN(p[1]));
    }
    const res = await this._hass.callWS({
      type: 'history/history_during_period',
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      entity_ids: [ent],
      minimal_response: true,
      no_attributes: true,
    });
    const arr = (res && res[ent]) || [];
    return arr
      .map((p) => {
        const t = p.lu != null ? p.lu * 1000
          : p.last_updated != null ? new Date(p.last_updated).getTime()
          : p.lc != null ? p.lc * 1000 : null;
        return [t, parseFloat(p.s != null ? p.s : p.state)];
      })
      .filter((p) => p[0] != null && !isNaN(p[1]));
  }

  async _refresh() {
    if (!this._hass || !this._config || !this._els) return;
    try {
      this._points = await this._fetchData();
      this._renderChart();
      this._updateHeader();
    } catch (e) {
      console.warn('value-line-card: refresh failed', e);
    }
  }

  // --- scale + colours ------------------------------------------------------

  _axis(points) {
    const c = this._config;
    const vals = points.map((p) => p[1]);
    let lo = c.y_min != null ? c.y_min : Math.min(...vals);
    let hi = c.y_max != null ? c.y_max : Math.max(...vals);
    if (lo === hi) { lo -= 1; hi += 1; }
    else {
      const pad = (hi - lo) * 0.08;
      if (c.y_min == null) lo -= pad;
      if (c.y_max == null) hi += pad;
    }
    return [lo, hi];
  }

  _colorForValue(v) {
    let color = this._config.thresholds[0].color;
    for (const t of this._config.thresholds) { if (v >= t.value) color = t.color; }
    return color;
  }

  // Thresholds -> gradient stops along the plot's vertical span: 0% = top (high
  // value / red), 100% = bottom (low value / green). Values outside clamp to an edge.
  _stops(lo, hi) {
    const span = hi - lo || 1;
    const stops = this._config.thresholds
      .map((t) => ({ off: Math.max(0, Math.min(1, (hi - t.value) / span)), color: t.color }))
      .sort((a, b) => a.off - b.off);
    if (stops[0].off > 0) stops.unshift({ off: 0, color: stops[0].color });
    if (stops[stops.length - 1].off < 1) stops.push({ off: 1, color: stops[stops.length - 1].color });
    return stops;
  }

  _niceTicks(lo, hi, count) {
    const span = hi - lo;
    if (span <= 0) return [lo];
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
    const ticks = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      ticks.push(Math.round(v * 1e6) / 1e6);
    }
    return ticks;
  }

  _xTicks(tMin, tMax, approx) {
    const span = tMax - tMin;
    const steps = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
    const step = steps.find((s) => span / s <= approx) || 90 * DAY;
    const d = new Date(tMin);
    if (step < DAY) d.setMinutes(0, 0, 0); else d.setHours(0, 0, 0, 0);
    const ticks = [];
    for (let t = d.getTime(); t <= tMax; t += step) if (t >= tMin) ticks.push(t);
    return ticks;
  }

  _timeFmt(span) {
    if (span <= 2 * DAY) {
      return (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    }
    if (span <= 120 * DAY) return (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return (t) => new Date(t).toLocaleDateString(undefined, { month: 'short' });
  }

  _smoothPath(pts) {
    if (pts.length < 2) return '';
    const f = (n) => n.toFixed(1);
    if (this._config.curve === 'straight' || pts.length < 3) {
      return 'M' + pts.map((p) => `${f(p[0])} ${f(p[1])}`).join(' L');
    }
    let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C${f(c1x)} ${f(c1y)}, ${f(c2x)} ${f(c2y)}, ${f(p2[0])} ${f(p2[1])}`;
    }
    return d;
  }

  _unit() {
    if (this._config.unit != null) return this._config.unit;
    const st = this._hass && this._hass.states[this._config.entity];
    return (st && st.attributes && st.attributes.unit_of_measurement) || '';
  }

  _title() {
    if (this._config.title != null) return this._config.title;
    const st = this._hass && this._hass.states[this._config.entity];
    return (st && st.attributes && st.attributes.friendly_name) || this._config.entity;
  }

  _fmt(v) {
    if (v == null || isNaN(v)) return '';
    return Math.abs(v) >= 100 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString();
  }

  _esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // --- DOM + chart ----------------------------------------------------------

  _build() {
    if (this._built) return;
    this.innerHTML = '';
    const card = document.createElement('ha-card');
    card.style.cssText =
      'padding:14px 16px;box-shadow:none;' +
      'background:var(--ha-card-background,var(--card-background-color,rgba(255,255,255,0.03)));';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:baseline;gap:10px;margin-bottom:2px;';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:13px;font-weight:600;letter-spacing:0.01em;opacity:0.8;';
    const vwrap = document.createElement('div');
    vwrap.style.cssText = 'margin-left:auto;display:flex;align-items:baseline;gap:3px;';
    const value = document.createElement('span');
    value.style.cssText = 'font-size:24px;font-weight:700;line-height:1;letter-spacing:-0.02em;';
    const unit = document.createElement('span');
    unit.style.cssText = 'font-size:11px;font-weight:500;opacity:0.5;';
    vwrap.append(value, unit);
    header.append(title, vwrap);
    const chart = document.createElement('div');
    chart.style.cssText = `width:100%;height:${this._config.height}px;`;
    card.append(header, chart);
    this.appendChild(card);
    this._els = { card, title, value, unit, chart };
    this._built = true;
    this._updateHeader();
    if (this._ro) { this._ro.disconnect(); this._ro.observe(chart); }
  }

  _updateHeader() {
    if (!this._els || !this._hass) return;
    const st = this._hass.states[this._config.entity];
    const raw = st ? parseFloat(st.state) : NaN;
    this._els.title.textContent = this._title();
    this._els.unit.textContent = this._unit();
    if (isNaN(raw)) {
      this._els.value.textContent = '—';
      this._els.value.style.color = 'var(--primary-text-color)';
    } else {
      this._els.value.textContent = this._fmt(raw);
      this._els.value.style.color = this._colorForValue(raw);
    }
  }

  _renderChart() {
    if (!this._els) return;
    const el = this._els.chart;
    const points = this._points || [];
    const W = Math.round(el.clientWidth || 760);
    const H = this._config.height;
    if (points.length < 2) { el.innerHTML = ''; return; }
    const [lo, hi] = this._axis(points);
    const mL = 42, mR = 10, mT = 8, mB = 20;
    const tMin = points[0][0], tMax = points[points.length - 1][0];
    const tSpan = tMax - tMin || 1, vSpan = hi - lo || 1;
    const X = (t) => mL + ((t - tMin) / tSpan) * (W - mL - mR);
    const Y = (v) => (H - mB) - ((v - lo) / vSpan) * (H - mT - mB);

    const path = this._smoothPath(points.map((p) => [X(p[0]), Y(p[1])]));
    const stops = this._stops(lo, hi)
      .map((s) => `<stop offset="${(s.off * 100).toFixed(1)}%" stop-color="${s.color}"/>`).join('');
    const yticks = this._niceTicks(lo, hi, 4);
    const xticks = this._xTicks(tMin, tMax, 6);
    const fmtT = this._timeFmt(tSpan);

    let svg = `<svg width="${W}" height="${H}" style="display:block;font-family:inherit">`;
    svg += `<defs><linearGradient id="${this._gid}" gradientUnits="userSpaceOnUse" x1="0" y1="${mT}" x2="0" y2="${H - mB}">${stops}</linearGradient></defs>`;
    for (const yt of yticks) {
      const y = Y(yt).toFixed(1);
      svg += `<line x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}" stroke="rgba(255,255,255,0.08)" stroke-dasharray="3 3"/>`;
      svg += `<text x="${mL - 6}" y="${(Y(yt) + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#9aa0ad">${this._esc(this._fmt(yt))}</text>`;
    }
    for (const xt of xticks) {
      svg += `<text x="${X(xt).toFixed(1)}" y="${H - 5}" text-anchor="middle" font-size="10" fill="#9aa0ad">${this._esc(fmtT(xt))}</text>`;
    }
    svg += `<path d="${path}" fill="none" stroke="url(#${this._gid})" stroke-width="${this._config.stroke_width}" stroke-linecap="round" stroke-linejoin="round"/>`;
    svg += `</svg>`;
    el.innerHTML = svg;
  }

  getCardSize() { return Math.ceil((this._config.height || 230) / 50) + 1; }

  static getStubConfig() {
    return { entity: '', thresholds: [{ value: 0, color: '#8FD08A' }, { value: 100, color: '#E0607A' }] };
  }
}

customElements.define('value-line-card', ValueLineCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'value-line-card',
  name: 'Value Line Card',
  description: 'An auto-scaling line chart whose colour follows the value against thresholds.',
  preview: false,
});

console.info(`%c value-line-card %c v${VERSION} `,
  'color:#fff;background:#5AA6E8;border-radius:3px 0 0 3px;padding:1px 4px',
  'color:#fff;background:#3a3f4a;border-radius:0 3px 3px 0;padding:1px 4px');

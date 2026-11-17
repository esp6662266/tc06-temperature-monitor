'use strict';
(() => {
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const minute = 60000;
  const clock = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const colors = {
    measured: '#00594a', average5: '#1769ae', average30: '#744397',
    band: '#517590', macd: '#146aac', signal: '#a6591e',
    increase: '#168174', decrease: '#b64456', ink: '#46586d', grid: '#dce5ee',
  };

  function svg(tag, attributes, content) {
    const node = document.createElementNS(svgNamespace, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function exponentialAverage(period) {
    let count = 0;
    let sum = 0;
    let value = null;
    const weight = 2 / (period + 1);
    return input => {
      if (count < period) {
        sum += input;
        if (++count === period) value = sum / period;
      } else {
        value += (input - value) * weight;
      }
      return value;
    };
  }

  function indicatorPoints(series) {
    const points = [];
    const window = [];
    let lastTime = NaN;
    let fast;
    let slow;
    let signal;
    for (const entry of series) {
      const time = Date.parse(entry.time);
      if (!Number.isFinite(time)) continue;
      const measured = Number.isFinite(entry.value_c) ? entry.value_c : null;
      const breakBefore = time - lastTime !== minute || entry.break_before === true;
      if (breakBefore || measured === null) {
        window.length = 0;
        fast = exponentialAverage(12);
        slow = exponentialAverage(26);
        signal = exponentialAverage(9);
      }
      lastTime = time;
      const point = { time, measured, breakBefore };
      points.push(point);
      if (measured === null) continue;
      window.push(measured);
      if (window.length > 30) window.shift();
      if (window.length >= 5) {
        point.average5 = window.slice(-5).reduce((sum, value) => sum + value, 0) / 5;
      }
      if (window.length === 30) {
        point.average30 = window.reduce((sum, value) => sum + value, 0) / 30;
        const variance = window.reduce((sum, value) => sum + (value - point.average30) ** 2, 0) / 30;
        const spread = 2 * Math.sqrt(variance);
        point.upperBand = point.average30 + spread;
        point.lowerBand = point.average30 - spread;
      }
      const fastValue = fast(measured);
      const slowValue = slow(measured);
      if (slowValue !== null) {
        point.macd = fastValue - slowValue;
        point.signal = signal(point.macd);
        if (point.signal !== null) point.histogram = point.macd - point.signal;
      }
    }
    return points;
  }

  function chartSize(element, width, compact = false) {
    const height = compact ? 158 : width < 460 ? 252 : 300;
    const size = { width, height, left: 57, right: width - 16, top: 17, bottom: height - 30 };
    element.setAttribute('viewBox', `0 0 ${width} ${height}`);
    element.replaceChildren();
    return size;
  }

  function drawGrid(element, plot, from, to, min, max, unit, digits) {
    const { left, right, top, bottom, width } = plot;
    const x = time => left + (time - from) / (to - from) * (right - left);
    const y = value => bottom - (value - min) / (max - min) * (bottom - top);
    const grid = svg('g', { fill: colors.ink, 'font-size': width < 460 ? 10 : 12 });
    grid.append(svg('text', { x: left - 8, y: top - 6, 'text-anchor': 'end' }, unit));
    for (let i = 0; i <= 4; i++) {
      const value = min + (max - min) * i / 4;
      const row = y(value);
      grid.append(
        svg('line', { x1: left, x2: right, y1: row, y2: row, stroke: colors.grid }),
        svg('text', { x: left - 8, y: row + 4, 'text-anchor': 'end' }, value.toFixed(digits)),
      );
    }
    const ticks = width < 460 ? 3 : 6;
    for (let i = 0; i < ticks; i++) {
      const at = from + (to - from) * i / (ticks - 1);
      const anchor = i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle';
      grid.append(svg('text', { x: x(at), y: bottom + 20, 'text-anchor': anchor }, clock.format(at)));
    }
    element.append(grid);
    return { x, y };
  }

  function eventHighlight(element, event, plot, from, to, x) {
    if (!event) return;
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < from || start >= to) return;
    const left = x(Math.max(from, start));
    const width = Math.min(plot.right - left, Math.max(3, x(Math.min(end, to)) - left));
    element.append(svg('rect', {
      x: left, y: plot.top, width, height: plot.bottom - plot.top,
      fill: '#d38b25', opacity: 0.18, class: 'analysis-chart-event',
    }));
  }

  function runs(points, key) {
    const result = [];
    let segment = [];
    for (const point of points) {
      if (!Number.isFinite(point[key]) || point.breakBefore || (segment.length && point.time - segment.at(-1).time !== minute)) {
        if (segment.length) result.push(segment);
        segment = [];
      }
      if (Number.isFinite(point[key])) segment.push(point);
    }
    if (segment.length) result.push(segment);
    return result;
  }

  function drawLine(element, points, key, { x, y }, ink, className, width = 1.5, dash, markers = false) {
    const segments = runs(points, key);
    const d = segments.filter(segment => segment.length > 1).map(segment =>
      segment.map((point, i) => `${i ? 'L' : 'M'}${x(point.time).toFixed(2)},${y(point[key]).toFixed(2)}`).join('')
    ).join('');
    if (d) {
      const attributes = {
        d, fill: 'none', stroke: ink, 'stroke-width': width,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: className,
      };
      if (dash) attributes['stroke-dasharray'] = dash;
      element.append(svg('path', attributes));
    }
    if (markers) {
      for (const [point] of segments.filter(segment => segment.length === 1)) {
        element.append(svg('circle', { cx: x(point.time), cy: y(point[key]), r: 2.5, fill: ink, class: 'analysis-temp-point' }));
      }
    }
  }

  function drawBands(element, points, axes) {
    const { x, y } = axes;
    for (const segment of runs(points, 'upperBand')) {
      if (segment.length < 2) continue;
      const top = segment.map(point => `${x(point.time)},${y(point.upperBand)}`).join(' ');
      const bottom = [...segment].reverse().map(point => `${x(point.time)},${y(point.lowerBand)}`).join(' ');
      element.append(svg('polygon', {
        points: `${top} ${bottom}`, fill: '#cedeea', opacity: 0.57, class: 'analysis-bollinger-band',
      }));
    }
    drawLine(element, points, 'upperBand', axes, colors.band, 'analysis-bollinger-upper', 1.2, '4 3');
    drawLine(element, points, 'lowerBand', axes, colors.band, 'analysis-bollinger-lower', 1.2, '4 3');
  }

  function extent(points, keys) {
    let min = Infinity;
    let max = -Infinity;
    for (const point of points) {
      for (const key of keys) {
        if (!Number.isFinite(point[key])) continue;
        min = Math.min(min, point[key]);
        max = Math.max(max, point[key]);
      }
    }
    return { min, max };
  }

  function drawTemperature(element, plot, points, from, to, indicators, event) {
    if (!points.some(point => point.measured !== null)) return false;
    const keys = ['measured'];
    if (indicators.average) keys.push('average5', 'average30');
    if (indicators.bands) keys.push('upperBand', 'lowerBand');
    const { min, max } = extent(points, keys);
    const pad = Math.max(0.4, (max - min) * 0.1);
    const axes = drawGrid(element, plot, from, to, min - pad, max + pad, '℃', 1);
    eventHighlight(element, event, plot, from, to, axes.x);
    if (indicators.bands) drawBands(element, points, axes);
    if (indicators.average) {
      drawLine(element, points, 'average5', axes, colors.average5, 'analysis-ma-short', 1.6, '5 3');
      drawLine(element, points, 'average30', axes, colors.average30, 'analysis-ma-long', 1.6, '8 3');
    }
    drawLine(element, points, 'measured', axes, colors.measured, 'analysis-temp-line', 2, undefined, true);
    return true;
  }

  function drawMacd(element, plot, points, from, to, event) {
    if (!points.some(point => Number.isFinite(point.signal))) return false;
    const { min, max } = extent(points, ['macd', 'signal', 'histogram']);
    const limit = Math.max(0.05, Math.abs(min) * 1.1, Math.abs(max) * 1.1);
    const axes = drawGrid(element, plot, from, to, -limit, limit, '℃', 2);
    eventHighlight(element, event, plot, from, to, axes.x);
    const zero = axes.y(0);
    element.append(svg('line', { x1: plot.left, x2: plot.right, y1: zero, y2: zero, stroke: '#65778b' }));
    const barWidth = Math.max(0.6, Math.min(9, (plot.right - plot.left) * minute / (to - from) * 0.76));
    for (const point of points) {
      if (!Number.isFinite(point.histogram) || point.histogram === 0) continue;
      const height = axes.y(point.histogram) - zero;
      const left = Math.max(plot.left, axes.x(point.time) - barWidth / 2);
      element.append(svg('rect', {
        x: left, y: zero + Math.min(0, height),
        width: Math.min(barWidth, plot.right - left), height: Math.abs(height),
        fill: point.histogram > 0 ? colors.increase : colors.decrease,
        opacity: 0.66, class: 'analysis-macd-histogram',
      }));
    }
    drawLine(element, points, 'macd', axes, colors.macd, 'analysis-macd-line', 1.7);
    drawLine(element, points, 'signal', axes, colors.signal, 'analysis-macd-signal', 1.7, '5 3');
    return true;
  }

  function draw({ temperature, macd, series, from, to, indicators, event }) {
    const width = Math.max(240, Math.round(temperature.getBoundingClientRect().width || 760));
    const main = chartSize(temperature, width);
    const lower = chartSize(macd, width, true);
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (!(end > start)) return { measured: false, macdReady: false };
    const points = indicatorPoints(series).filter(point => point.time >= start && point.time < end);
    return {
      measured: drawTemperature(temperature, main, points, start, end, indicators, event),
      averageReady: points.some(point => Number.isFinite(point.average5)),
      longAverageReady: points.some(point => Number.isFinite(point.average30)),
      bandsReady: points.some(point => Number.isFinite(point.upperBand)),
      macdReady: Boolean(indicators.macd && drawMacd(macd, lower, points, start, end, event)),
    };
  }

  window.TC06AnalysisChart = { draw };
})();

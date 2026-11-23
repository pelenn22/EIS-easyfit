// Impedance Spectrum Fitter
// Fully client-side. Plotly is loaded via CDN in index.html; the
// Levenberg-Marquardt solver below is self-contained (no external
// dependency), so the only thing this page needs is a network
// connection for the Plotly script.
//
// Data convention:
//   Col 1: frequency (Hz)
//   Col 2: Re(Z)  (Ohm)
//   Col 3: -Im(Z) (Ohm) as reported by the source (positive for
//          capacitive data). We keep this as `minusImZ`: the Nyquist
//          y-axis plots it directly, while Bode phase and fit
//          residuals use the true Zimag = -minusImZ.
//
// Circuit notation (custom Ersatzschaltbild):
//   Elements: R (resistor), C (capacitor), I (inductor), P (CPE),
//             W (Warburg)
//   Series connection: '-' (or '+')
//   Parallel connection: elements/parentheses directly adjacent,
//                        e.g. (R)(C)
//   Grouping: ( )
//   Example: R-(R)(C) = R in series with (R parallel C)
(function () {
  'use strict';

  let loadedData = null;   // {freq, zreal, minusImZ}
  let lastFit = null;      // {names, values, modelKey, node}
  let freqRange = null;    // {min, max} in Hz, or null for the full range
  let customCircuit = null;// {root, params: [{name, unit, guess}]}

  // ---------- Parsing (data file) ----------

  function parseImpedanceData(text) {
    const lines = text.split(/\r?\n/);
    const freq = [], zreal = [], minusImZ = [];
    for (const line of lines) {
      const tokens = line.trim().split(/[\s,;]+/);
      if (tokens.length < 3) continue;
      const f = Number(tokens[0]);
      const zr = Number(tokens[1]);
      const mi = Number(tokens[2]);
      if (!isFinite(f) || !isFinite(zr) || !isFinite(mi) || f <= 0) continue;
      freq.push(f);
      zreal.push(zr);
      minusImZ.push(mi);
    }
    return {freq, zreal, minusImZ};
  }

  // ---------- Circuit models ----------

  function complexDiv(aRe, aIm, bRe, bIm) {
    const d = bRe * bRe + bIm * bIm;
    return {
      real: (aRe * bRe + aIm * bIm) / d,
      imag: (aIm * bRe - aRe * bIm) / d
    };
  }

  function modelZ(params, freq, includeWarburg) {
    const Rs = params[0], Rct = params[1], Cdl = params[2];
    const sigma = includeWarburg ? params[3] : 0;
    return freq.map((f) => {
      const w = 2 * Math.PI * f;
      const Zp = complexDiv(1, 0, 1 / Rct, w * Cdl); // parallel Rct||Cdl
      let re = Rs + Zp.real;
      let im = Zp.imag;
      if (includeWarburg) {
        const fw = sigma / Math.sqrt(w);
        re += fw;
        im -= fw;
      }
      return {real: re, imag: im};
    });
  }

  // ---------- Custom circuits ----------

  // Per-element parameter spec: [nameTemplate, unit, initialGuess]
  const ELEMENT_PARAMS = {
    R: [['R', 'Ω', 10]],
    C: [['C', 'F', 1e-5]],
    I: [['I', 'H', 1e-2]],
    P: [['Q', 'Ω⁻¹·sⁿ', 1e-5], ['n', '–', 1]],
    W: [['W', 'Ω·s^-1/2', 1]]
  };

  function parseCircuitText(input) {
    const s = String(input).trim();
    if (!s) throw new Error('Please enter a circuit description, e.g. R-(R)(C).');
    const toks = [];
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (/\s/.test(ch)) continue;
      if (ch === '(' || ch === ')') { toks.push(ch); continue; }
      if (ch === '-' || ch === '+') { toks.push('-'); continue; }
      const up = ch.toUpperCase();
      if ('RCIPW'.includes(up)) { toks.push(up); continue; }
      throw new Error('Invalid character "' + ch + '" (position ' + (i + 1) + '). Allowed: R, C, I, P, W, ( ), -');
    }
    let pos = 0;
    const peek = () => toks[pos];
    const isElement = (t) => t && 'RCIPW'.includes(t);

    function parseSeries() {
      const children = [parseParallel()];
      while (peek() === '-') { pos++; children.push(parseParallel()); }
      return children.length === 1 ? children[0] : {type: 'series', children};
    }
    function parseParallel() {
      const units = [parseUnit()];
      while (isElement(peek()) || peek() === '(') units.push(parseUnit());
      return units.length === 1 ? units[0] : {type: 'parallel', branches: units};
    }
    function parseUnit() {
      const t = peek();
      if (t === '(') {
        pos++;
        const node = parseSeries();
        if (peek() !== ')') throw new Error('Missing closing parenthesis ")" in the circuit description.');
        pos++;
        return node;
      }
      if (isElement(t)) { pos++; return {type: 'element', kind: t}; }
      throw new Error('Unexpected ' + (t === undefined ? 'end of input' : '"' + t + '"') + ' in the circuit description.');
    }
    const root = parseSeries();
    if (pos < toks.length) throw new Error('Unexpected "' + toks[pos] + '" at the end of the circuit description.');
    return root;
  }

  // Walk the tree, assign element IDs and collect ordered parameters.
  function buildCircuit(root) {
    const counters = {R:0,C:0,I:0,P:0,W:0};
    const params = [];
    (function walk(n) {
      if (n.type === 'element') {
        const k = n.kind;
        counters[k]++;
        n._label = k + counters[k];
        n._pidx = params.length;
        ELEMENT_PARAMS[k].forEach((spec) => {
          const name = spec[0] + counters[k];
          params.push({name, unit: spec[1], guess: spec[2]});
        });
      } else if (n.type === 'series') {
        n.children.forEach(walk);
      } else if (n.type === 'parallel') {
        n.branches.forEach(walk);
      }
    })(root);
    return params;
  }

  function circuitZ(root, values, w) {
    function evalNode(n) {
      if (n.type === 'element') {
        const idx = n._pidx;
        switch (n.kind) {
          case 'R': return {real: values[idx], imag: 0};
          case 'C': return {real: 0, imag: -1 / (w * values[idx])};
          case 'I': return {real: 0, imag: w * values[idx]};
          case 'P': {
            const Q = values[idx];
            const nexp = values[idx + 1];
            const ang = nexp * Math.PI / 2;
            const mag = 1 / (Q * Math.pow(w, nexp));
            return {real: mag * Math.cos(ang), imag: -mag * Math.sin(ang)};
          }
          case 'W': {
            const v = values[idx] / Math.sqrt(w);
            return {real: v, imag: -v};
          }
        }
      }
      if (n.type === 'series') {
        let re = 0, im = 0;
        for (const c of n.children) { const z = evalNode(c); re += z.real; im += z.imag; }
        return {real: re, imag: im};
      }
      // parallel
      let crec = 0, cim = 0;
      for (const b of n.branches) {
        const z = evalNode(b);
        const y = complexDiv(1, 0, z.real, z.imag);
        crec += y.real; cim += y.imag;
      }
      return complexDiv(1, 0, crec, cim);
    }
    return evalNode(root);
  }

  function circuitInitialGuesses(params, data) {
    const maxRe = Math.max.apply(null, data.zreal);
    const rCount = params.filter(p => p.name[0] === 'R').length;
    return params.map(p => {
      if (p.name[0] === 'R') return Math.max(maxRe / (rCount || 1), 1);
      return p.guess;
    });
  }

  // ---------- Levenberg-Marquardt (built-in) ----------

  function lmSolveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      }
      if (Math.abs(M[pivot][col]) < 1e-14) continue;
      const tmp = M[col]; M[col] = M[pivot]; M[pivot] = tmp;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const factor = M[r][col] / M[col][col];
        if (factor === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = 0; i < n; i++) x[i] = Math.abs(M[i][i]) > 1e-14 ? M[i][n] / M[i][i] : 0;
    return x;
  }

  function levenbergMarquardt(residualFunc, initialValues, options) {
    const opt = Object.assign({
      damping: 1.5,
      gradientDifference: 1e-6,
      maxIterations: 100,
      errorTolerance: 1e-3
    }, options || {});
    const n = initialValues.length;
    let p = initialValues.slice();
    let r = residualFunc(p);
    let err = r.reduce((s, v) => s + Math.abs(v), 0) / r.length;
    let lambda = opt.damping;
    let iterations = 0;
    let success = err <= opt.errorTolerance;
    let stopReason = 'converged';
    while (iterations < opt.maxIterations && !success) {
      const J = [];
      for (let k = 0; k < n; k++) {
        const h = opt.gradientDifference * (Math.abs(p[k]) > 1e-12 ? Math.abs(p[k]) : 1);
        const pPlus = p.slice(); pPlus[k] += h;
        const rPlus = residualFunc(pPlus);
        J.push(r.map((v, i) => (rPlus[i] - v) / h));
      }
      const A = [], g = new Array(n).fill(0);
      for (let i = 0; i < n; i++) A.push(new Array(n).fill(0));
      for (let i = 0; i < r.length; i++) {
        for (let a = 0; a < n; a++) {
          g[a] += J[a][i] * r[i];
          for (let b = 0; b < n; b++) A[a][b] += J[a][i] * J[b][i];
        }
      }
      let accepted = false;
      for (let tries = 0; tries < 20 && !accepted; tries++) {
        const Ad = A.map((row, i) =>
          row.map((v, j) => (i === j ? v + lambda * v : v))
        );
        for (let i = 0; i < n; i++) if (Math.abs(Ad[i][i]) < 1e-14) Ad[i][i] = 1e-14;
        const delta = lmSolveLinear(Ad, g.map(v => -v));
        if (!delta.every(v => isFinite(v))) { lambda *= 10; continue; }
        const pNew = p.map((v, i) => v + delta[i]);
        const rNew = residualFunc(pNew);
        if (rNew.some(v => !isFinite(v))) { lambda *= 10; continue; }
        const errNew = rNew.reduce((s, v) => s + Math.abs(v), 0) / rNew.length;
        if (errNew < err) {
          p = pNew; r = rNew; err = errNew;
          lambda = Math.max(lambda / 10, 1e-12);
          accepted = true;
        } else {
          lambda *= 10;
        }
      }
      iterations++;
      if (!accepted) { stopReason = 'stuck'; break; }
      success = err <= opt.errorTolerance;
    }
    if (success) stopReason = 'converged';
    else if (iterations >= opt.maxIterations) stopReason = 'maxIterations';
    return {parameterValues: p, parameterError: err, iterations, success, stopReason};
  }

  function fitData(modelKey, data) {
    const {freq, zreal, minusImZ} = data;
    const zimag = minusImZ.map(v => -v);
    const includeWarburg = modelKey === 'RandlesWarburg';

    const zCalc = (p) => (modelKey === 'Custom'
      ? freq.map(f => circuitZ(customCircuit.root, p, 2 * Math.PI * f))
      : modelZ(p, freq, includeWarburg));

    const residual = (p) => {
      const zc = zCalc(p);
      const res = [];
      for (let i = 0; i < freq.length; i++) {
        res.push(zc[i].real - zreal[i]);
        res.push(zc[i].imag - zimag[i]);
      }
      return res;
    };

    const initial = modelKey === 'Custom'
      ? circuitInitialGuesses(customCircuit.params, data)
      : includeWarburg
        ? [0, Math.max.apply(null, zreal), 1e-5, 1]
        : [0, Math.max.apply(null, zreal), 1e-5];

    const result = levenbergMarquardt(residual, initial, {
      damping: 1.5,
      gradientDifference: 1e-6,
      maxIterations: 100,
      errorTolerance: 1e-3
    });
    return {values: result.parameterValues, error: result.parameterError, iterations: result.iterations, success: result.success, stopReason: result.stopReason};
  }

  // ---------- Frequency range helpers ----------

  function rangeBounds() {
    const fmin = Math.min.apply(null, loadedData.freq);
    const fmax = Math.max.apply(null, loadedData.freq);
    const min = freqRange ? freqRange.min : fmin;
    const max = freqRange ? freqRange.max : fmax;
    return {min, max, fmin, fmax};
  }

  function rangeRestricted() {
    const b = rangeBounds();
    return b.min > b.fmin || b.max < b.fmax;
  }

  function rangeData() {
    const b = rangeBounds();
    const mask = loadedData.freq.map(f => f >= b.min && f <= b.max);
    return {
      freq: loadedData.freq.filter((_, i) => mask[i]),
      zreal: loadedData.zreal.filter((_, i) => mask[i]),
      minusImZ: loadedData.minusImZ.filter((_, i) => mask[i])
    };
  }

  function formatFreq(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'e6';
    if (v >= 1e3) return (v / 1e3).toFixed(2) + 'e3';
    if (v >= 1) return v.toFixed(2);
    return v.toExponential(2);
  }

  // ---------- Circuit diagram (SVG) ----------

  const EL_W = 44, EL_H = 18, BRANCH_GAP = 18, PAD_X = 26, PAD_TOP = 22, PAD_BOTTOM = 14;

  function measure(node) {
    if (node.type === 'element') {
      return {w: EL_W, h: EL_H};
    }
    if (node.type === 'series') {
      const children = node.children.map(measure);
      const w = children.reduce((sum, c) => sum + c.w, 0);
      const h = Math.max.apply(null, children.map(c => c.h));
      return {w, h, children};
    }
    // parallel
    const branches = node.branches.map(measure);
    const w = Math.max.apply(null, branches.map(b => b.w));
    const hs = branches.map(b => b.h);
    const ys = [];
    let y = 0;
    for (let i = 0; i < hs.length; i++) {
      if (i > 0) y += hs[i-1]/2 + BRANCH_GAP + hs[i]/2;
      ys.push(y);
    }
    const mid = (ys[0] + ys[ys.length-1]) / 2;
    const ysC = ys.map(v => v - mid);
    const half = Math.max.apply(null, ysC.map((yy,i) => Math.abs(yy) + branches[i].h/2));
    return {w, h: 2*half, ys: ysC, branches};
  }

  function wire(x1,y1,x2,y2,out) { out.push('<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" class="cwire"/>'); }
  function dot(cx,cy,out) { out.push('<circle cx="' + cx + '" cy="' + cy + '" r="2.5" class="cdot"/>'); }

  function drawSymbol(kind, label, cx, cy, out) {
    switch (kind) {
      case 'R':
        out.push('<polyline points="' +
          [cx-10, cx-8, cx-4, cx, cx+4, cx+8, cx+10].map((px,i) => px + ',' + (cy + (i===0||i===6?0:(i%2? -5 : 5)))).join(' ') +
          '" class="csym"/>');
        break;
      case 'C':
        wire(cx-10, cy, cx-2.5, cy, out);
        wire(cx+2.5, cy, cx+10, cy, out);
        wire(cx-2.5, cy-8, cx-2.5, cy+8, out);
        wire(cx+2.5, cy-8, cx+2.5, cy+8, out);
        break;
      case 'I':
        out.push('<path d="M ' + (cx-10) + ' ' + cy + ' A 2.5 2.5 0 0 1 ' + (cx-5) + ' ' + cy + ' A 2.5 2.5 0 0 1 ' + cx + ' ' + cy + ' A 2.5 2.5 0 0 1 ' + (cx+5) + ' ' + cy + ' A 2.5 2.5 0 0 1 ' + (cx+10) + ' ' + cy + '" class="csym"/>');
        break;
      case 'P':
        // treat same as capacitor for shape
        wire(cx-10, cy, cx-2.5, cy, out);
        wire(cx+2.5, cy, cx+10, cy, out);
        wire(cx-2.5, cy-8, cx-2.5, cy+8, out);
        wire(cx+2.5, cy-8, cx+2.5, cy+8, out);
        break;
      case 'W':
        out.push('<rect x="' + (cx-10) + '" y="' + (cy-6) + '" width="20" height="12" class="csym"/>');
        break;
    }
    out.push('<text x="' + cx + '" y="' + (cy-13) + '" class="clabel" text-anchor="middle">' + label + '</text>');
  }

  function drawNode(node, x, y, out) {
    const m = measure(node);
    if (node.type === 'element') {
      const cx = x + EL_W/2;
      wire(x, y, cx-10, y, out);
      drawSymbol(node.kind, node._label, cx, y, out);
      wire(cx+10, y, x+EL_W, y, out);
      return;
    }
    if (node.type === 'series') {
      let cx = x;
      node.children.forEach((c) => {
        drawNode(c, cx, y, out);
        cx += measure(c).w;
      });
      return;
    }
    // parallel
    const n = node.branches.length;
    const ys = m.ys;
    // left vertical line
    wire(x, y + ys[0], x, y + ys[n-1], out);
    // right vertical line
    wire(x + m.w, y + ys[0], x + m.w, y + ys[n-1], out);
    for (let i = 0; i < n; i++) {
      const by = y + ys[i];
      drawNode(node.branches[i], x, by, out);
      const bw = measure(node.branches[i]).w;
      if (bw < m.w) wire(x + bw, by, x + m.w, by, out);
      dot(x, by, out); dot(x + m.w, by, out);
    }
  }

  function buildCircuitSVG(root) {
    const m = measure(root);
    const W = m.w + 2*PAD_X;
    const H = m.h + PAD_TOP + PAD_BOTTOM;
    const out = [];
    out.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" style="max-width:100%;height:auto;">');
    const y0 = PAD_TOP + m.h/2;
    drawNode(root, PAD_X, y0, out);
    // terminals
    const leftX = PAD_X;
    const rightX = PAD_X + m.w;
    dot(leftX, y0, out); out.push('<text x="' + leftX + '" y="' + (y0-8) + '" class="clabel" text-anchor="middle">a</text>');
    dot(rightX, y0, out); out.push('<text x="' + rightX + '" y="' + (y0-8) + '" class="clabel" text-anchor="middle">b</text>');
    out.push('</svg>');
    return out.join('');
  }

  // ---------- Plotting ----------

  const DATA_COLOR = '#2563eb';
  const EXCLUDED_COLOR = '#b8c4de';

  function logGrid(fmin, fmax, n) {
    return Array.from({length: n}, (_, i) => fmin * Math.pow(fmax / fmin, i / (n - 1)));
  }

  function renderPlots(data, fit) {
    const {freq, zreal, minusImZ} = data;
    const zimag = minusImZ.map(v => -v);
    const restricted = rangeRestricted();
    const b = rangeBounds();
    const mask = freq.map(f => f >= b.min && f <= b.max);
    const ix = [], ex = [];
    freq.forEach((f,i) => (mask[i] ? ix : ex).push(i));

    let fitTrace = null, fitMag = null, fitPhase = null;
    if (fit) {
      const fminFit = Math.min.apply(null, ix.map(i => freq[i]));
      const fmaxFit = Math.max.apply(null, ix.map(i => freq[i]));
      const fgrid = logGrid(fminFit, fmaxFit, 200);
      const zfit = (fit.modelKey === 'Custom')
        ? fgrid.map(f => circuitZ(fit.node, fit.values, 2 * Math.PI * f))
        : modelZ(fit.values, fgrid, fit.modelKey === 'RandlesWarburg');
      const re = zfit.map(z => z.real);
      const nim = zfit.map(z => -z.imag);
      fitTrace = {x: re, y: nim, mode: 'lines', type: 'scatter', name: 'Fit', line: {color: '#dc2626', width: 2}};
      fitMag = {x: fgrid, y: zfit.map(z => Math.sqrt(z.real*z.real + z.imag*z.imag)), mode: 'lines', type: 'scatter', name: 'Fit', line: {color: '#dc2626', width: 2}};
      fitPhase = {x: fgrid, y: zfit.map(z => Math.atan2(z.imag, z.real) * 180 / Math.PI), mode: 'lines', type: 'scatter', name: 'Fit', line: {color: '#dc2626', width: 2}};
    }

    // Nyquist
    const pts = (list, color, name, size) => ({
      x: list.map(i => zreal[i]),
      y: list.map(i => minusImZ[i]),
      mode: 'markers', type: 'scatter', name,
      marker: {size, color}
    });
    const nyqTraces = [pts(ix, DATA_COLOR, 'Data', 6)];
    if (ex.length) nyqTraces.push(pts(ex, EXCLUDED_COLOR, 'Data (excluded)', 6));
    if (fitTrace) nyqTraces.push(fitTrace);
    Plotly.react('nyquist', nyqTraces, {
      title: 'Nyquist Plot',
      xaxis: {title: 'Re(Z) (Ω)', scaleanchor: 'y', scaleratio: 1},
      yaxis: {title: '-Im(Z) (Ω)'},
      margin: {l: 60, r: 20, t: 40, b: 50},
      hovermode: 'closest',
      plot_bgcolor: '#fff'
    });

    // Bode magnitude
    const mag = zreal.map((r,i) => Math.sqrt(r*r + zimag[i]*zimag[i]));
    const magPts = (list, color, name) => ({
      x: list.map(i => freq[i]),
      y: list.map(i => mag[i]),
      mode: 'markers', type: 'scatter', name,
      marker: {size: 4, color}
    });
    const magTraces = [magPts(ix, DATA_COLOR, 'Data')];
    if (ex.length) magTraces.push(magPts(ex, EXCLUDED_COLOR, 'Data (excluded)'));
    if (fitMag) magTraces.push(fitMag);
    Plotly.react('bodeMag', magTraces, {
      title: 'Bode Magnitude',
      xaxis: {title: 'Frequency (Hz)', type: 'log'},
      yaxis: {title: '|Z| (Ω)'},
      margin: {l: 60, r: 20, t: 40, b: 50},
      hovermode: 'closest',
      plot_bgcolor: '#fff'
    });

    // Bode phase
    const phase = zreal.map((r,i) => Math.atan2(zimag[i], r) * 180 / Math.PI);
    const phasePts = (list, color, name) => ({
      x: list.map(i => freq[i]),
      y: list.map(i => phase[i]),
      mode: 'markers', type: 'scatter', name,
      marker: {size: 4, color}
    });
    const phaseTraces = [phasePts(ix, DATA_COLOR, 'Data')];
    if (ex.length) phaseTraces.push(phasePts(ex, EXCLUDED_COLOR, 'Data (excluded)'));
    if (fitPhase) phaseTraces.push(fitPhase);
    Plotly.react('bodePhase', phaseTraces, {
      title: 'Bode Phase',
      xaxis: {title: 'Frequency (Hz)', type: 'log'},
      yaxis: {title: 'Phase (°)'},
      margin: {l: 60, r: 20, t: 40, b: 50},
      hovermode: 'closest',
      plot_bgcolor: '#fff'
    });
  }

  // ---------- Results ----------

  function renderFitTable(names, values, meta, error, absErrors = []) {
    const div = document.getElementById('fitResults');
    // Determine quality based on overall residual error
    let qualityClass = 'good';
    let qualityLabel = 'Good';
    if (error >= 2) { qualityClass = 'bad'; qualityLabel = 'Bad'; }
    else if (error >= 0.5) { qualityClass = 'moderate'; qualityLabel = 'Moderate'; }
    let html = '<h2>Fitted Parameters</h2><table><tr><th>Parameter</th><th>Value</th><th>Abs. Error</th><th>Rel. Error (%)</th></tr>';
    names.forEach((n,i) => {
      const val = values[i].toExponential(6);
      const absErr = absErrors[i] !== undefined && !isNaN(absErrors[i]) ? absErrors[i].toExponential(3) : '—';
      const relErr = (absErrors[i] !== undefined && values[i] !== 0 && !isNaN(absErrors[i])) ? (absErrors[i]/Math.abs(values[i])*100).toFixed(2) : '—';
      html += '<tr><td>' + n + '</td><td><span class="fit-quality ' + qualityClass + '">' + val + '</span></td><td>' + absErr + '</td><td>' + relErr + '</td></tr>';
    });
    // Add fit quality row (spanning three columns for value+errors)
    html += '<tr><td>Fit quality</td><td colspan="3"><span class="fit-quality ' + qualityClass + '">' + qualityLabel + '</span></td></tr>';
    html += '</table>';
    if (meta) html += '<div class="meta">' + meta + '</div>';
    div.innerHTML = html;
  }

  function downloadCSV(rows) {
    const csvContent = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csvContent], {type: 'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fit_parameters.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function paramNames(modelKey) {
    return modelKey === 'RandlesWarburg'
      ? ['Rs (Ω)', 'Rct (Ω)', 'Cdl (F)', 'sigma (Ω·s^-1/2)']
      : ['Rs (Ω)', 'Rct (Ω)', 'Cdl (F)'];
  }

  function fitModelNames(modelKey) {
    return modelKey === 'Custom'
      ? customCircuit.params.map(p => p.name + ' (' + p.unit + ')')
      : paramNames(modelKey);
  }

  // ---------- UI wiring ----------

  const fileInput = document.getElementById('fileInput');

  const fitBtn = document.getElementById('fitBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const exportFormatSelect = document.getElementById('exportFormatSelect');
  const rangePanel = document.getElementById('rangePanel');
  const minFreqInput = document.getElementById('minFreqInput');
  const maxFreqInput = document.getElementById('maxFreqInput');
  const applyRangeBtn = document.getElementById('applyRangeBtn');
  const resetRangeBtn = document.getElementById('resetRangeBtn');
  const rangeInfo = document.getElementById('rangeInfo');
  const circuitInput = document.getElementById('circuitInput');
  // Ensure field starts empty
  circuitInput.value = '';
  const presetSelect = document.getElementById('presetSelect');
presetSelect.addEventListener('change', () => {
  const val = presetSelect.value;
  if (val) {
    circuitInput.value = val;
    updateCircuitDiagram();
  } else {
    circuitInput.value = '';
    updateCircuitDiagram();
  }
});

  const circuitDiagram = document.getElementById('circuitDiagram');
  const circuitError = document.getElementById('circuitError');


  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const data = parseImpedanceData(ev.target.result);
      if (data.freq.length < 2) {
        alert('No data rows found. Expected columns: freq (Hz), Re(Z) (Ohm), -Im(Z) (Ohm).');
        return;
      }
      loadedData = data;
      lastFit = null;
      freqRange = null;
      downloadBtn.disabled = true;
      document.getElementById('fitResults').innerHTML = '';
      // Prefill range inputs
      minFreqInput.value = formatFreq(Math.min.apply(null, data.freq));
      maxFreqInput.value = formatFreq(Math.max.apply(null, data.freq));
      rangeInfo.textContent = '';
      rangePanel.style.display = 'flex';
      renderPlots(data, null);
      fitBtn.disabled = false;
    };
    reader.readAsText(file);
  });

  fitBtn.addEventListener('click', () => {
    if (!loadedData) return;
    try {
      const modelKey = 'Custom';
      if (!customCircuit) {
        alert('Please enter a valid circuit notation first.');
        return;
      }
      const data = rangeData();
      if (data.freq.length < 2) {
        alert('Fewer than 2 data points inside the selected frequency range.');
        return;
      }
      const {values, error, iterations, success, stopReason} = fitData(modelKey, data);
        // Compute absolute (standard) errors via numerical Jacobian approximation
        const residuals = (() => {
          const zimag = data.minusImZ.map(v => -v);
          const zc = (modelKey === 'Custom')
            ? data.freq.map(f => circuitZ(customCircuit.root, values, 2 * Math.PI * f))
            : modelZ(values, data.freq, false);
          const res = [];
          for (let i = 0; i < data.freq.length; i++) {
            res.push(zc[i].real - data.zreal[i]);
            res.push(zc[i].imag - zimag[i]);
          }
          return res;
        })();
        const nParams = values.length;
        const nRes = residuals.length;
        const J = Array.from({length: nRes}, () => new Array(nParams).fill(0));
        for (let j = 0; j < nParams; j++) {
          const pert = values.slice();
          const delta = Math.abs(values[j]) * 1e-6 + 1e-12;
          pert[j] += delta;
          const zimag = data.minusImZ.map(v => -v);
          const zcPert = (modelKey === 'Custom')
            ? data.freq.map(f => circuitZ(customCircuit.root, pert, 2 * Math.PI * f))
            : modelZ(pert, data.freq, false);
          const resPert = [];
          for (let i = 0; i < data.freq.length; i++) {
            resPert.push(zcPert[i].real - data.zreal[i]);
            resPert.push(zcPert[i].imag - zimag[i]);
          }
          for (let i = 0; i < nRes; i++) {
            J[i][j] = (resPert[i] - residuals[i]) / delta;
          }
        }
        // Approximate covariance: sigma^2 * (J^T J)^-1
        const JT = J[0].map((_, colIndex) => J.map(row => row[colIndex]));
        const JTJ = JT.map(row => JT[0].map((_, colIndex) => row.reduce((sum, r, k) => sum + r * J[k][colIndex], 0)));
        // Invert JTJ (Gaussian elimination)
        function invertMatrix(m) {
          const n = m.length;
          const A = m.map(row => row.slice());
          const I = Array.from({length: n}, (_, i) => {
            const row = new Array(n).fill(0);
            row[i] = 1; return row;
          });
          for (let i = 0; i < n; i++) {
            // pivot
            let maxRow = i;
            for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) maxRow = k;
            if (Math.abs(A[maxRow][i]) < 1e-15) { continue; }
            // swap rows in A and I
            [A[i], A[maxRow]] = [A[maxRow], A[i]];
            [I[i], I[maxRow]] = [I[maxRow], I[i]];
            const diag = A[i][i];
            for (let j = 0; j < n; j++) { A[i][j] /= diag; I[i][j] /= diag; }
            for (let k = 0; k < n; k++) {
              if (k === i) continue;
              const factor = A[k][i];
              for (let j = 0; j < n; j++) { A[k][j] -= factor * A[i][j]; I[k][j] -= factor * I[i][j]; }
            }
          }
          return I;
        }
        const JTJinv = invertMatrix(JTJ);
        const rss = residuals.reduce((s, v) => s + v * v, 0);
        const sigma2 = rss / Math.max(1, (nRes - nParams));
        const absErrors = [];
        for (let i = 0; i < nParams; i++) {
          const variance = JTJinv[i][i] * sigma2;
          absErrors[i] = variance > 0 ? Math.sqrt(variance) : NaN;
        }
      const names = fitModelNames(modelKey);
      lastFit = {names, values, modelKey, node: modelKey === 'Custom' ? customCircuit.root : null, absErrors};
      const stopLabel = success
        ? 'converged'
        : stopReason === 'maxIterations' ? 'max iterations reached' : 'no further improvement';
      let meta = 'Model: Custom circuit' +
        ' — mean |residual|: ' + error.toExponential(3) + ' Ω' +
        ' — iterations: ' + iterations + ' — ' + stopLabel;
      if (rangeRestricted()) {
        const b = rangeBounds();
        meta += ' — fit range: ' + formatFreq(b.min) + ' – ' + formatFreq(b.max) + ' Hz (' + data.freq.length + '/' + loadedData.freq.length + ' points)';
      }
      renderFitTable(names, values, meta, error, absErrors);
      downloadBtn.disabled = false;
      renderPlots(loadedData, lastFit);
    } catch (err) {
      alert('Fitting failed: ' + err.message);
    }
  });

  downloadBtn.addEventListener('click', () => {
    if (!lastFit || !loadedData) return;
    // --- Parameters section (tab‑separated) ---
    const allRows = [];
    allRows.push(['# Parameters']);
    allRows.push(['Parameter', 'Value', 'Abs. Error', 'Rel. Error (%)']);
    lastFit.names.forEach((n, i) => {
      const val = lastFit.values[i];
      const absErr = lastFit.absErrors && lastFit.absErrors[i] !== undefined ? lastFit.absErrors[i] : '';
      const relErr = (absErr !== '' && val !== 0 && !isNaN(absErr)) ? (absErr / Math.abs(val) * 100).toFixed(2) : '';
      allRows.push([n, val, absErr, relErr]);
    });
    allRows.push([]); // blank line

    // --- Raw data section ---
    allRows.push(['# Raw Data']);
    allRows.push(['Frequency (Hz)', 'Re(Z)', '-Im(Z)']);
    for (let i = 0; i < loadedData.freq.length; i++) {
      allRows.push([loadedData.freq[i], loadedData.zreal[i], loadedData.minusImZ[i]]);
    }
    allRows.push([]);

    // --- Fit spectra section ---
    allRows.push(['# Fit Spectra']);
    allRows.push(['Frequency (Hz)', 'Fit_Re(Z)', 'Fit_-Im(Z)']);
    const f = loadedData.freq;
    let fitPoints;
    if (lastFit.modelKey === 'Custom') {
      fitPoints = f.map(freq => circuitZ(lastFit.node, lastFit.values, 2 * Math.PI * freq));
    } else {
      fitPoints = modelZ(lastFit.values, f, lastFit.modelKey === 'RandlesWarburg');
    }
    fitPoints.forEach(z => {
      allRows.push([z.freq, z.real, -z.imag]);
    });

    // Build file content according to selected format (TSV or CSV)
    const fmt = exportFormatSelect.value; // 'tsv' or 'csv'
    const delim = fmt === 'csv' ? ';' : '\t';
    const ext = fmt === 'csv' ? 'csv' : 'tsv';
    const mime = fmt === 'csv' ? 'text/csv;charset=utf-8' : 'text/tab-separated-values;charset=utf-8';
    const bom = '\uFEFF'; // ensure UTF‑8 detection in Excel
    const fileContent = bom + allRows.map(r => r.join(delim)).join('\n');
    const blob = new Blob([fileContent], {type: mime});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'fit_results.' + ext;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // Frequency range UI helpers
  function parseFreqInput(str) {
    const v = Number(String(str).trim().replace(',', '.'));
    return isFinite(v) && v > 0 ? v : NaN;
  }
  function shiftInput(el, factor) {
    const v = parseFreqInput(el.value);
    if (!isFinite(v)) { rangeInfo.textContent = 'Please enter a valid frequency first.'; return; }
    el.value = formatFreq(v * factor);
  }
  function decLowerBoundary() {
    if (!loadedData) return;
    const uniq = Array.from(new Set(loadedData.freq)).sort((a,b)=>a-b);
    const curMin = freqRange ? freqRange.min : uniq[0];
    const idx = uniq.indexOf(curMin);
    if (idx >= 0 && idx < uniq.length-1) {
      const newMin = uniq[idx+1];
      freqRange = freqRange ? {...freqRange, min:newMin} : {min:newMin, max:rangeBounds().max};
      minFreqInput.value = formatFreq(newMin);
      rangeInfo.textContent = '';
      renderPlots(loadedData, lastFit);
      if (lastFit) fitBtn.click();
    }
  }
  function decUpperBoundary() {
    if (!loadedData) return;
    const uniq = Array.from(new Set(loadedData.freq)).sort((a,b)=>a-b);
    const curMax = freqRange ? freqRange.max : uniq[uniq.length-1];
    const idx = uniq.indexOf(curMax);
    if (idx > 0) {
      const newMax = uniq[idx-1];
      freqRange = freqRange ? {...freqRange, max:newMax} : {min:rangeBounds().min, max:newMax};
      maxFreqInput.value = formatFreq(newMax);
      rangeInfo.textContent = '';
      renderPlots(loadedData, lastFit);
      if (lastFit) fitBtn.click();
    }
  }
  document.getElementById('minDiv10').addEventListener('click', () => shiftInput(minFreqInput, 0.1));
  document.getElementById('minMul10').addEventListener('click', () => shiftInput(minFreqInput, 10));
  document.getElementById('decLowerBtn').addEventListener('click', decLowerBoundary);
  document.getElementById('maxDiv10').addEventListener('click', () => shiftInput(maxFreqInput, 0.1));
  document.getElementById('maxMul10').addEventListener('click', () => shiftInput(maxFreqInput, 10));
  document.getElementById('decUpperBtn').addEventListener('click', decUpperBoundary);
  applyRangeBtn.addEventListener('click', () => {
    const vmin = parseFreqInput(minFreqInput.value);
    const vmax = parseFreqInput(maxFreqInput.value);
    if (!isFinite(vmin) || !isFinite(vmax)) { rangeInfo.textContent = 'Invalid frequency. Use a number, e.g. 0.01 or 1e-2.'; return; }
    if (vmin >= vmax) { rangeInfo.textContent = 'Min frequency must be smaller than max frequency.'; return; }
    freqRange = {min: vmin, max: vmax};
    rangeInfo.textContent = '';
    renderPlots(loadedData, lastFit);
    if (lastFit) fitBtn.click();
  });
  resetRangeBtn.addEventListener('click', () => { freqRange = null; rangeInfo.textContent = ''; renderPlots(loadedData, lastFit); if (lastFit) fitBtn.click(); });

  // Circuit generator UI
  function updateCircuitDiagram() {
    const txt = circuitInput.value.trim();
    if (!txt) {
      circuitDiagram.innerHTML = '';
      circuitError.textContent = '';
      customCircuit = null;
      return;
    }
    try {
      const root = parseCircuitText(txt);
      const params = buildCircuit(root);
      customCircuit = {root, params};
      const svg = buildCircuitSVG(root);
      circuitDiagram.innerHTML = svg;
      circuitError.textContent = '';
      
      
    } catch (e) {
      circuitDiagram.innerHTML = '';
      circuitError.textContent = e.message;
      customCircuit = null;
      
      
    }
  }



  // Live update as user types
  circuitInput.addEventListener('input', updateCircuitDiagram);

  // Allow Enter key to trigger generation (kept for usability)
  circuitInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); updateCircuitDiagram(); } });

})();

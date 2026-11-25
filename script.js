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
let userStartValues = null;
let userParamBounds = null;

  // ---------- Parsing (data file) ----------

  function parseImpedanceData(text) {
  // Improved: skip leading non-data lines (metadata, comments) until we find a header or a plausible data row
    // --- Intelligent CSV/TSV/TXT parser with fallback -------------------
    // 1. Split into non‑empty lines
    const rawLines = text.split(/\r?\n/).filter(l => l.trim().length);
    if (rawLines.length === 0) return {freq: [], zreal: [], minusImZ: []};

    // 2. Guess delimiter: test comma, semicolon, tab and whitespace.
    const delimiters = [/[,\t]+/, /\s+/]; // order matters – prefer explicit separators
    let bestDelim = delimiters[1];
    let bestScore = 0;
    for (const delim of delimiters) {
      const score = rawLines.reduce((c,l) => c + (l.trim().split(delim).length >= 3 ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; bestDelim = delim; }
    }

    // 3. Detect header row (anywhere) or find first plausible data line
    let headerLineIdx = rawLines.findIndex(line => {
      const toks = line.trim().split(bestDelim);
      // Require a token that matches a known column keyword **and** contains a '/' (typical for the headers)
      return toks.some(tok => /^(freq|hz|frequency|re|real|zre|im|imag)[\\/_]/i.test(tok));
    });


    let startIdx = 0;
    const colIdx = {freq: -1, re: -1, im: -1};
    if (headerLineIdx !== -1) {
      const headerTokens = rawLines[headerLineIdx].trim().split(bestDelim);
      headerTokens.forEach((tok, i) => {
        const t = tok.toLowerCase();
        if (colIdx.freq === -1 && /(freq|hz|frequency)/i.test(t)) colIdx.freq = i;
        if (colIdx.re === -1 && /^(re\(|real|zre|impedance_r|_r)/i.test(t)) colIdx.re = i;
        if (colIdx.im === -1 && /(?:_i[\\/]|im\(|-?im\b)/i.test(t)) colIdx.im = i;
      });


      startIdx = headerLineIdx + 1; // data starts after header
    } else {
      // Infer column order when no explicit header is present
      const sampleLines = rawLines.filter(l => {
        const toks = l.trim().split(bestDelim);
        return toks.length >= 3 && toks.every(tok => !isNaN(Number(tok.replace(',', '.'))));
      }).slice(0, 5);
      if (sampleLines.length > 0) {
        const colCount = sampleLines[0].trim().split(bestDelim).length;
        const stats = Array.from({length: colCount}, () => ({freqScore: 0, realScore: 0, imagNegScore: 0, imagPosScore: 0}));
        for (const line of sampleLines) {
          const toks = line.trim().split(bestDelim);
          for (let i = 0; i < colCount; i++) {
            const val = Number(toks[i].replace(',', '.'));
            if (isNaN(val)) continue;
            // Frequency plausibility
            if (val >= 1e-3 && val <= 1e7) stats[i].freqScore++;
            // Real part plausibility
            if (val > 0) stats[i].realScore++;
            // Imag part: prefer negative (original Im) values
            if (val < 0) stats[i].imagNegScore++; else if (val >= 0) stats[i].imagPosScore++;
          }
        }
        // Choose column with highest freqScore as frequency
        let freqIdx = 0;
        for (let i = 1; i < colCount; i++) {
          if (stats[i].freqScore > stats[freqIdx].freqScore) freqIdx = i;
        }
        // Among remaining, choose highest realScore as real
        const remaining = [];
        for (let i = 0; i < colCount; i++) if (i !== freqIdx) remaining.push(i);
        let realIdx = remaining[0];
        for (let i = 1; i < remaining.length; i++) {
          if (stats[remaining[i]].realScore > stats[realIdx].realScore) realIdx = remaining[i];
        }
        // Choose imag column: prefer negative values
        let imagIdx = remaining.find(i => i !== realIdx && stats[i].imagNegScore > 0);
        if (imagIdx === undefined) {
          imagIdx = remaining.find(i => i !== realIdx);
        }
        colIdx.freq = freqIdx;
        colIdx.re = realIdx;
        colIdx.im = imagIdx;
      }
    }

    const freq = [], zreal = [], minusImZ = [];
    const toNumber = (s) => {
      const clean = s.replace(',', '.');
      const n = Number(clean);
      return isFinite(n) ? n : null;
    };
    // If a header was recognised but some column could not be mapped, indexing
    // with -1 used to throw (tokens[-1] is undefined). Let the simple fallback
    // parser at the end handle such files instead.
    const mapped = colIdx.freq >= 0 && colIdx.re >= 0 && colIdx.im >= 0;

    const rows = [];

    for (let i = startIdx; mapped && i < rawLines.length; i++) {
      const tokens = rawLines[i].trim().split(bestDelim);
      if (tokens.length < 3) continue;
      const at = (idx) => (idx < tokens.length) ? tokens[idx] : '';
      const f = toNumber(at(colIdx.freq));
      const zr = toNumber(at(colIdx.re));
      const imRaw = toNumber(at(colIdx.im));
      if (f === null || zr === null || imRaw === null) continue;
      // Basic sanity checks
      if (f < 1e-3 || f > 1e7) continue;
      if (zr <= 0) continue;
      rows.push([f, zr, imRaw]);
    }

    // Fallback: simple split if we got too few rows after intelligent parsing
    if (rows.length < 2) {
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const toks = line.trim().split(/[\s,;]+/);
        if (toks.length < 3) continue;
        const f = toNumber(toks[0]), zr = toNumber(toks[1]), imRaw = toNumber(toks[2]);
        if (f === null || zr === null || imRaw === null) continue;
        if (f < 1e-3 || f > 1e7) continue;
        if (zr <= 0) continue;
        rows.push([f, zr, imRaw]);
      }
    }

    // The imaginary column of an export holds either Im(Z) (negative for
    // capacitive data) or -Im(Z) (positive). The convention is decided once for
    // the whole file from the majority of its values. Flipping every point
    // keeps a genuinely inductive branch (where -Im(Z) is negative) physical;
    // taking the absolute value point by point mirrored such points onto the
    // capacitive side and so corrupted the spectrum.
    let negIm = 0;
    for (const r of rows) if (r[2] < 0) negIm++;
    const flipIm = negIm * 2 > rows.length;
    for (const r of rows) {
      freq.push(r[0]);
      zreal.push(r[1]);
      minusImZ.push(flipIm ? -r[2] : r[2]);
    }
    return {freq, zreal, minusImZ};
  }
  // expose for testing/debugging
  if (typeof window !== 'undefined') window.parseImpedanceData = parseImpedanceData;

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

  // Characteristic scales of a spectrum: the size of its impedance and the
  // angular frequency where the imaginary response is strongest (the apex of
  // the arc). Anchoring on the apex instead of on the highest measured
  // frequency is what makes the guesses usable: a spectrum measured from
  // 0.1 Hz to 8 MHz has nothing in common with one from 1 kHz to 1 Hz.
  function spectrumScales(data) {
    const posOr = (x, d) => (isFinite(x) && x > 0) ? x : d;
    const n = (data && data.freq) ? data.freq.length : 0;
    if (!n) return null;                     // nothing loaded: use the catalogue guesses
    let maxRe = -Infinity, k = 0, fMin = Infinity, fMax = 0;
    for (let i = 0; i < n; i++) {
      if (data.zreal[i] > maxRe) maxRe = data.zreal[i];
      if (data.minusImZ[i] > data.minusImZ[k]) k = i;
      if (data.freq[i] < fMin) fMin = data.freq[i];
      if (data.freq[i] > fMax) fMax = data.freq[i];
    }
    // A series inductance is the only thing that can turn -Im(Z) negative, and
    // where it dominates -Im = -w*L, so (-Im)/w is a direct estimate of it.
    // Without that estimate an inductance is guessed from the arc and can be off
    // by orders of magnitude. Only the top decade of the spectrum is used, which
    // is where an inductance lives, and the median of those ratios rather than
    // the largest: one noisy point elsewhere whose -Im just dips below zero makes
    // (-Im)/w huge at a low frequency, and since the bounds are derived from the
    // start, the true value then falls below Min and the fitted inductance sits
    // pinned at its bound while resistance and capacitance compensate around it.
    const lAll = [], lHi = [];
    for (let i = 0; i < n; i++) {
      if (!(data.minusImZ[i] < 0) || !isFinite(data.freq[i])) continue;
      const li = -data.minusImZ[i] / (2 * Math.PI * Math.max(data.freq[i], 1e-9));
      if (isFinite(li) && li > 0) {
        lAll.push(li);
        if (data.freq[i] * 10 >= fMax) lHi.push(li);
      }
    }
    const lSample = (lHi.length ? lHi : lAll).sort((a, b) => a - b);
    return {
      r: posOr(Math.max(maxRe, data.minusImZ[k]), 1),      // ohms
      w: posOr(2 * Math.PI * data.freq[k], 2 * Math.PI),   // rad/s at that apex
      wLo: posOr(2 * Math.PI * (isFinite(fMin) ? fMin : 1), 2 * Math.PI), // rad/s at the lowest measured frequency
      l: lSample.length ? lSample[(lSample.length - 1) >> 1] : 0   // henries, 0 if not inductive
    };
  }

  // Value of an element whose |Z| equals the spectrum scale at the Debye apex
  // (frequency w), or at the low-frequency limit (wLo) for elements that only
  // express themselves there: C = 1/(wR), I = R/w, Q = 1/(R*sqrt(w)), W = R*sqrt(wLo).
  function elementValueScale(p, s) {
    if (!s) return p.guess;
    switch (p.name[0]) {
      case 'R': return s.r;
      case 'C': return 1 / (s.r * s.w);
      case 'I': return s.l > 0 ? s.l : s.r / s.w;   // measured inductive branch wins
      // A Warburg only shows up at the low-frequency end (its impedance grows as
      // 1/sqrt(w)), so it has to be anchored there. Anchoring it on the arc apex
      // makes the coefficient sqrt(w_apex/w_lo) too large: on example-data-01,
      // whose apex sits four decades above the lowest frequency, that start is
      // 135x the measured impedance, the residual of the first iteration is
      // dominated by the element itself, and the fit never recovers - a series
      // Warburg then stalls around 1.8e4 and reports a 2580 % misfit as if the
      // circuit were wrong.
      case 'W': return s.r * Math.sqrt(s.wLo);
      case 'P':
      case 'Q': return 1 / (s.r * Math.sqrt(s.w));
      default: return p.guess;                 // dimensionless exponents
    }
  }

  function circuitInitialGuesses(params, data) {
    const s = spectrumScales(data);
    const rCount = params.filter(p => p.name[0] === 'R').length || 1;
    return params.map(p => {
      if (!s) return p.guess;
      return p.name[0] === 'R'
        ? Math.max(s.r / rCount, s.r * 1e-6)   // split the measured resistance over the R's
        : elementValueScale(p, s);
    });
  }

  // Everything derived from a guess is shown with three significant figures:
  // these numbers only ever carry order-of-magnitude meaning, and a 16-digit
  // bound in a text field hides the fact that it is an estimate.
  const SIG_DIGITS = 3;
  function roundSig(x) {
    if (!isFinite(x) || x === 0) return 0;
    const e = Math.floor(Math.log10(Math.abs(x)));
    const factor = Math.pow(10, SIG_DIGITS - 1 - e);
    return Math.round(x * factor) / factor;
  }
  // Display form with SIG_DIGITS significant figures, with the exponent written
  // out only where the plain number would be a wall of zeros or of nines.
  function fmtSig(x) {
    if (typeof x !== 'number' || !isFinite(x)) return '';
    if (x === 0) return '0';
    const a = Math.abs(x);
    return (a < 1e-3 || a >= 1e4) ? x.toExponential(SIG_DIGITS - 1) : String(roundSig(x));
  }

  // Guess start values (3 significant figures) and fitting bounds
  function guessStartAndBounds(params, data) {
    const s = spectrumScales(data);
    const rCount = params.filter(p => p.name[0] === 'R').length || 1;
    const posOr = (x, d) => (isFinite(x) && x > 0) ? x : d;
    const starts = params.map(p => {
      const raw = !s ? p.guess
        : (p.name[0] === 'R') ? Math.max(s.r / rCount, s.r * 1e-6)
        : elementValueScale(p, s);
      const v = roundSig(raw);
      return v > 0 ? v : posOr(raw, 0);      // never round a small element to zero
    });
    // Bounds are deliberately wide (4 decades around the element's own scale).
    // A parameter pinned at a tight default limit stops the fit silently and
    // the leftover residual then looks like a mistake in the circuit, not in
    // the bounds. Only the dimensionless exponent gets a physical window.
    const bounds = params.map((p, i) => {
      const g = starts[i];
      if (p.name[0] === 'n') return [0.2, 1.0];
      if (p.name[0] === 'R') return [0, posOr(roundSig(Math.max(g, s ? s.r : g) * 1e4), 1)];
      const scale = elementValueScale(p, s);
      const lo = Math.min(g, scale) * 1e-4;
      const hi = Math.max(g, scale) * 1e4;
      return [posOr(roundSig(lo), 0), posOr(roundSig(hi), 1)];
    });
    return {starts, bounds};
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
      const errBefore = err;
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
          // Marquardt damping: lambda (absolute) + scaled term, so the step is
          // damped consistently for parameters of very different magnitudes
          // (R ~ 1e2 vs C ~ 1e-6). lambda*JtJ alone leaves small-diagonal
          // directions almost undamped and they overshoot.
          row.map((v, j) => (i === j ? v + lambda + lambda * v : v))
        );
        for (let i = 0; i < n; i++) if (Math.abs(Ad[i][i]) < 1e-14) Ad[i][i] = 1e-14;
        const delta = lmSolveLinear(Ad, g.map(v => -v));
        if (!delta.every(v => isFinite(v))) { lambda *= 10; continue; }
        let pNew = p.map((v, i) => v + delta[i]);
        // Apply bounds if provided
        if (opt.bounds) {
          pNew = pNew.map((val, i) => {
            const b = opt.bounds[i];
            if (!b) return val;
            const low = b[0];
            const high = b[1];
            if (low !== undefined && val < low) return low;
            if (high !== undefined && val > high) return high;
            return val;
          });
        }
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
      // Stop as soon as an accepted step no longer improves the residuals
      // (scale independent criterion; complements the absolute errorTolerance).
      if (errBefore - err <= 1e-10 * Math.max(errBefore, opt.errorTolerance)) {
        success = true;
        stopReason = 'converged';
        break;
      }
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

    // Determine initial guess and optional bounds
    let initial;
    // The LM error is the mean |residual| in ohms, so the tolerance must scale
    // with the impedance of the data: an absolute 1e-3 ohm is reached instantly
    // for a 10 kohm spectrum (stop before converging) and is unreachable for a
    // milliohm one (run to max iterations). Relative: 1e-5 of mean |Z|.
    const zAvg = meanImpedanceMagnitude(data);
    const lmOptions = {
      damping: 1.5,
      gradientDifference: 1e-6,
      maxIterations: 100,
      errorTolerance: Math.max(1e-12, zAvg * 1e-5),
      bounds: null
    };

    if (modelKey === 'Custom') {
      if (userStartValues && userStartValues.length === customCircuit.params.length) {
        // An emptied Start field is undefined; using it as an initial value
        // makes every residual NaN and the fit crashes on the way to the table.
        initial = userStartValues.map((v, i) =>
          (typeof v === 'number' && isFinite(v)) ? v : customCircuit.params[i].guess);
      } else {
        initial = circuitInitialGuesses(customCircuit.params, data);
      }
      if (userParamBounds && userParamBounds.length === customCircuit.params.length) {
        lmOptions.bounds = userParamBounds;
      }
    } else {
      initial = includeWarburg
        ? [0, Math.max.apply(null, zreal), 1e-5, 1]
        : [0, Math.max.apply(null, zreal), 1e-5];
    }

    const result = levenbergMarquardt(residual, initial, lmOptions);


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
    dot(leftX, y0, out);
    dot(rightX, y0, out);
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

    // The K-K verdict used to be the name of the trace it draws, and Plotly sizes
    // the legend to its longest entry: the whole sentence ended up over half the
    // Nyquist plot, hiding the points it was talking about. The legend entry is
    // short now and the message is wrapped into small caption lines above the axes.
    const caption = (info, width) => {
      const maxChars = Math.max(24, Math.floor(((width || 420) - 44) / 6.3));
      const words = String(info).split(' ');
      const lines = [];
      let cur = '';
      words.forEach(w => {
        if (cur && (cur + ' ' + w).length > maxChars) { lines.push(cur); cur = w; }
        else cur = cur ? cur + ' ' + w : w;
      });
      if (cur) lines.push(cur);
      // Plotly advances every title line by 1.3em of the title font, 17px by
      // default, so a caption line costs about 23px of top margin whatever its
      // own size - measured, not guessed, or the caption sits on the data.
      return { text: lines.join('<br>'), height: 23 * lines.length };
    };

    let fitTrace = null, fitMag = null, fitPhase = null;
    if (fit && ix.length >= 2) {
      // with fewer than 2 points in range there is nothing to draw a curve over
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
    let kkNote = '';
      if (showKK) {
        // test the points that are actually selected for the fit
        const kkData = {
          freq: ix.map(i => freq[i]),
          zreal: ix.map(i => zreal[i]),
          minusImZ: ix.map(i => minusImZ[i])
        };
        const kk = computeKK(kkData);
        nyqTraces.push(pts(kk.bad.map(t => ix[t]), '#ff0000', 'K-K', 9));
        kkNote = kk.info;
      }
    if (ex.length) nyqTraces.push(pts(ex, EXCLUDED_COLOR, 'Data (excluded)', 6));
    if (fitTrace) nyqTraces.push(fitTrace);
    // Wrap to the width the plot is drawn at, not to the div's: Plotly keeps the
    // canvas size of an existing plot, so after a window resize the two differ
    // and the caption would spill past the edge of the figure.
    const nyqEl = document.getElementById('nyquist');
    const drawn = nyqEl.querySelector('svg');
    const nyqW = (drawn && drawn.getBoundingClientRect().width) || nyqEl.clientWidth;
    const kkCaption = kkNote ? caption(kkNote, nyqW) : null;
    // The verdict is a subtitle of the plot rather than a legend entry or an
    // in-plot note: it is a sentence, it has to stay readable on a narrow plot,
    // and nothing of it may cover the points it describes.
    const nyqTitle = {
      text: 'Nyquist Plot' + (kkCaption
        ? '<br><span style="font-size:11px;font-weight:normal;color:#555">' + kkCaption.text + '</span>'
        : '')
    };
    if (kkCaption) {
      // Left to itself Plotly floats the title in the middle of the top margin,
      // so every caption line would cost twice the room it needs. Pinning the
      // block just below the top edge of the figure (0.945 of the 420px plot,
      // i.e. the first line's own height) keeps it clear of the axes.
      nyqTitle.y = 0.945;
      nyqTitle.yanchor = 'top';
    }
    Plotly.react('nyquist', nyqTraces, {
      title: nyqTitle,
      xaxis: {title: 'Re(Z) (Ω)', scaleanchor: 'y', scaleratio: 1},
      yaxis: {title: '-Im(Z) (Ω)'},
      margin: {l: 60, r: 20, t: kkCaption ? 30 + kkCaption.height : 40, b: 50},
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

  // ---------- Kramers-Kronig Test ----------
  let showKK = false;

  // Kramers-Kronig test for causality of the imaginary part.
  // Causality ties the two parts of an impedance together. Every element of
  //     Z(w) = Rinf + SUM_k Rk / (1 + (j w tk)^nk),   0 < nk <= 1
  // is causal on its own, so fitting the *measured real part* with a few of
  // these elements determines the imaginary part completely - the imaginary
  // part is never used to fit the model that then predicts it. A smooth causal
  // response cannot follow a single artefact, so the difference between the
  // predicted and the measured imaginary part exposes K-K violations. The
  // deviations are judged relative to |Z| and against their own median, which
  // flags outliers instead of the noise band of an otherwise good spectrum.
  function computeKK(data) {
    const none = {bad: [], info: 'K-K test unavailable'};
    const n = data.freq.length;
    if (n < 8) return none;                        // too few points to fit a model
    const w = data.freq.map(f => 2 * Math.PI * f);
    let iLo = 0, iHi = 0, apex = 0;
    for (let i = 1; i < n; i++) {
      if (data.freq[i] < data.freq[iLo]) iLo = i;
      if (data.freq[i] > data.freq[iHi]) iHi = i;
      if (data.minusImZ[i] > data.minusImZ[apex]) apex = i;
    }
    let reMin = Infinity, reMax = -Infinity, imMax = 0;
    for (let i = 0; i < n; i++) {
      if (data.zreal[i] < reMin) reMin = data.zreal[i];
      if (data.zreal[i] > reMax) reMax = data.zreal[i];
      if (data.minusImZ[i] > imMax) imMax = data.minusImZ[i];
    }
    // Size of the spectrum: every tolerance below is a fraction of it and never
    // an absolute number of ohms.
    const arc = Math.max(imMax, reMax - reMin, 1e-12);
    const tauMin = 1 / (2 * Math.PI * data.freq[iHi]);
    const tauMax = 1 / (2 * Math.PI * Math.max(data.freq[iLo], 1e-12));
    const tauApex = 1 / (2 * Math.PI * Math.max(data.freq[apex], 1e-12));
    const rInf0 = data.zreal[iHi];
    const span0 = Math.max(reMax - rInf0, 0.2 * arc);

    // Real and (-)imaginary part of Rinf + SUM Rk/(1+(jwt)^nk).
    const ccParts = (p) => {
      const re = new Array(n), im = new Array(n);
      const m = (p.length - 1) / 3;
      for (let i = 0; i < n; i++) {
        let reI = p[0], imI = 0;
        for (let k = 0; k < m; k++) {
          const R = p[1 + 3 * k];
          const tau = Math.exp(p[2 + 3 * k]);
          const nk = p[3 + 3 * k];
          const u = Math.pow(w[i] * tau, nk);
          const c = Math.cos(nk * Math.PI / 2), s = Math.sin(nk * Math.PI / 2);
          const den = (1 + u * c) * (1 + u * c) + (u * s) * (u * s);
          reI += R * (1 + u * c) / den;
          imI += R * u * s / den;
        }
        re[i] = reI;
        im[i] = imI;
      }
      return {re, im};
    };

    // One to three elements; an extra one is accepted only when it clearly
    // lowers the real-part misfit (a broad or double arc needs several).
    let best = null;
    for (let m = 1; m <= 3; m++) {
      const p0 = [rInf0];
      const bounds = [[0, Infinity]];
      for (let k = 0; k < m; k++) {
        const frac = (m === 1) ? 0 : k / (m - 1);
        const tau = (m === 1) ? tauApex
          : tauMin * Math.pow(Math.max(tauMax / tauMin, 10), frac);
        p0.push(span0 / m, Math.log(tau), 0.9);
        bounds.push([0, Infinity],
          [Math.log(tauMin) - 2, Math.log(tauMax) + 2], [0.05, 1]);
      }
      const fit = levenbergMarquardt((p) => {
        const parts = ccParts(p);
        return data.zreal.map((v, i) => (parts.re[i] - v) / arc);
      }, p0, {
        bounds: bounds,
        damping: 1e-2,
        maxIterations: 250,
        // the residuals are already normalised by the size of the spectrum
        errorTolerance: 1e-9
      });
      if (!fit.parameterValues.every(v => isFinite(v))) continue;
      if (!best || fit.parameterError < best.error * 0.7) {
        best = {values: fit.parameterValues, error: fit.parameterError, elements: m};
      }
    }
    if (!best || !isFinite(best.error)) return none;

    const pred = ccParts(best.values);
    let dev = data.minusImZ.map((v, i) => v - pred.im[i]);
    const medianAbs = (arr) => {
      const s = arr.map(v => Math.abs(v)).sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)] || 0;
    };
    // A series inductance (cable, cell holder) is causal as well, so its
    // contribution -Im(w) = -w*L is removed before judging. It is kept only
    // when it really tightens the residuals, otherwise a fit parameter would
    // absorb part of the data the test is supposed to check.
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num -= dev[i] * w[i]; den += w[i] * w[i]; }
    const L = den > 0 ? Math.max(0, num / den) : 0;
    if (L > 0) {
      const withL = dev.map((v, i) => v + L * w[i]);
      if (medianAbs(withL) < medianAbs(dev)) dev = withL;
    }
    const rel = dev.map((v, i) =>
      Math.abs(v) / Math.max(Math.hypot(data.zreal[i], data.minusImZ[i]), 1e-12));
    const medRel = medianAbs(rel);
    const limit = Math.max(6 * medRel, 0.002);   // at least 0.2 % of |Z|
    // When a handful of causal elements cannot keep up with the imaginary part
    // anywhere near the real part's accuracy, the deviation is a property of the
    // model and not of the data: every point would look wrong, so no point is
    // claimed. The message says what was measured instead.
    const inconclusive = medRel > 0.05;
    const bad = [];
    if (!inconclusive) {
      for (let i = 0; i < n; i++) if (rel[i] > limit) bad.push(i);
    }
    const info = 'K-K: ' + best.elements +
      (best.elements > 1 ? ' causal elements, ' : ' causal element, ') +
      'real part fitted to ' + (100 * best.error).toPrecision(2) + '%, ' +
      (inconclusive
        ? 'test inconclusive (typical deviation ' + (100 * medRel).toPrecision(2) + '% of |Z|: response needs more than a few relaxation times)'
        : 'median deviation ' + (100 * medRel).toPrecision(2) + '% of |Z|, ' +
          bad.length + '/' + n + ' points deviate (limit ' + (100 * limit).toPrecision(2) + '% of |Z|)');
    return {bad: bad, info: info};
  }

  // ---------- Results ----------

  // Mean |Z| of a spectrum — the scale a residual has to be compared with.
  function meanImpedanceMagnitude(data) {
    if (!data || !data.freq || !data.freq.length) return 0;
    let s = 0;
    for (let i = 0; i < data.freq.length; i++) s += Math.hypot(data.zreal[i], data.minusImZ[i]);
    return s / data.freq.length;
  }

  function renderFitTable(names, values, meta, error, absErrors = [], zScale = 0) {
    const div = document.getElementById('fitResults');
    // Fit quality: the residual relative to the size of the spectrum. An
    // absolute threshold in ohms labels a well-fitted 1e5 Ω dataset "Bad"
    // because 3 Ω is nothing there, and a badly fitted 1 Ω one "Good".
    const relQuality = zScale > 0 ? error / zScale : Infinity;
    let qualityClass = 'good';
    let qualityLabel = 'Good';
    if (relQuality >= 0.05) { qualityClass = 'bad'; qualityLabel = 'Bad'; }
    else if (relQuality >= 0.01) { qualityClass = 'moderate'; qualityLabel = 'Moderate'; }
    let html = '<h2>Fitted Parameters</h2><table><tr><th>Parameter</th><th>Value</th><th>Abs. Error</th><th>Rel. Error (%)</th></tr>';
    const atLimit = [];
    names.forEach((n,i) => {
      const v = values[i];
      const ok = typeof v === 'number' && isFinite(v);
      let val = ok ? v.toExponential(SIG_DIGITS - 1) : '—';
      const err = (absErrors[i] !== undefined && isFinite(absErrors[i])) ? absErrors[i] : NaN;
      const absErr = isNaN(err) ? '—' : err.toExponential(SIG_DIGITS - 1);
      // A parameter held by one of its limits tells nothing about the system -
      // its value is the limit, not a measurement - so say so instead of
      // presenting it as a fitted number.
      const b = (userParamBounds && userParamBounds.length > i) ? userParamBounds[i] : null;
      if (ok && b) {
        const low = b[0], high = b[1];
        if (low !== undefined && low !== null && Math.abs(v - low) <= 1e-6 * Math.max(Math.abs(low), Math.abs(high) * 1e-12, 1e-30)) {
          val += ' (at Min)'; atLimit.push(n);
        } else if (high !== undefined && high !== null && Math.abs(v - high) <= 1e-6 * Math.abs(high)) {
          val += ' (at Max)'; atLimit.push(n);
        }
      }
      // A parameter that ran to a bound (or to ~0) gets an enormous, useless
      // relative error: show it in exponential form instead of 29199165476.49.
      const rel = (!isNaN(err) && ok && v !== 0) ? err / Math.abs(v) * 100 : NaN;
      const relTxt = isNaN(rel) ? '—'
        : (rel >= 1000 ? rel.toExponential(SIG_DIGITS - 1) : rel.toPrecision(SIG_DIGITS));
      html += '<tr><td>' + n + '</td><td><span class="fit-quality ' + qualityClass + '">' + val + '</span></td><td>' + absErr + '</td><td>' + relTxt + '</td></tr>';
    });

    if (atLimit.length) {
      html += '<tr><td>At a limit</td><td colspan="3">' + atLimit.join(', ') +
        ' could not move past its bound. Widen Start/Min/Max for these, or the element is not present in the data.</td></tr>';
    }

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

  // Render UI for start values and bounds of circuit parameters
  function renderParamControls(params) {
    const container = document.getElementById('paramSettings');
    container.innerHTML = '';
    if (!params || params.length === 0) return;
    const table = document.createElement('table');
    const header = document.createElement('tr');
    header.innerHTML = '<th>Param</th><th>Start</th><th>Min</th><th>Max</th>';
    table.appendChild(header);
    params.forEach((p, i) => {
      const row = document.createElement('tr');
      const nameTd = document.createElement('td');
      nameTd.textContent = p.name + ' (' + p.unit + ')';
      const startTd = document.createElement('td');
      const startIn = document.createElement('input');
      startIn.type = 'number';
      startIn.step = 'any';
      startIn.dataset.idx = i;
      startIn.dataset.field = 'start';
      const startVal = (userStartValues && userStartValues[i] !== undefined) ? userStartValues[i] : p.guess;
      if (typeof startVal === 'number' && isFinite(startVal)) startIn.value = fmtSig(startVal);
      startTd.appendChild(startIn);

      const minTd = document.createElement('td');
      const minIn = document.createElement('input');
      minIn.type = 'number';
      minIn.step = 'any';
      minIn.dataset.idx = i;
      minIn.dataset.field = 'min';
      if (userParamBounds && userParamBounds[i]) {
        const low = userParamBounds[i][0];
        if (typeof low === 'number' && isFinite(low)) minIn.value = fmtSig(low);
      }
      minTd.appendChild(minIn);

      const maxTd = document.createElement('td');
      const maxIn = document.createElement('input');
      maxIn.type = 'number';
      maxIn.step = 'any';
      maxIn.dataset.idx = i;
      maxIn.dataset.field = 'max';
      if (userParamBounds && userParamBounds[i]) {
        const high = userParamBounds[i][1];
        if (typeof high === 'number' && isFinite(high)) maxIn.value = fmtSig(high);
      }
      maxTd.appendChild(maxIn);

      row.appendChild(nameTd);
      row.appendChild(startTd);
      row.appendChild(minTd);
      row.appendChild(maxTd);
      table.appendChild(row);
    });
    container.appendChild(table);

    // Listen for changes to update globals. The container element is reused on
    // every render, so drop the previous listener first (otherwise one more
    // handler is added each time the table is redrawn).
    if (container._paramHandler) container.removeEventListener('input', container._paramHandler);
    container._paramHandler = (e) => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.field;
      const valStr = e.target.value.trim();
      const num = Number(valStr);
      const val = (valStr === '' || !isFinite(num)) ? undefined : num;
      if (field !== 'start' && field !== 'min' && field !== 'max') return;
      if (field === 'start') {
        if (!userStartValues) userStartValues = new Array(params.length).fill(undefined);
        userStartValues[idx] = val;
      } else {
        if (!userParamBounds) userParamBounds = new Array(params.length).fill(undefined);
        if (!userParamBounds[idx]) userParamBounds[idx] = [undefined, undefined];
        if (field === 'min') userParamBounds[idx][0] = val;
        if (field === 'max') userParamBounds[idx][1] = val;
      }
    };
    container.addEventListener('input', container._paramHandler);
  }

  // ---------- UI wiring ----------

  const fileInput = document.getElementById('fileInput');

  const fitBtn = document.getElementById('fitBtn');
  const downloadBtn = document.getElementById('downloadBtn');
const kkBtn = document.getElementById('kkBtn');





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

// Toggle Kramer‑Kronig test overlay (single registration)
kkBtn.addEventListener('click', () => {
  showKK = !showKK;
  kkBtn.textContent = showKK ? 'Hide K‑K Test' : 'Kramers‑Kronig Test';
  renderPlots(loadedData, lastFit);
});


const exampleSelect = document.getElementById('exampleSelect');

// Populate the dropdown with .txt files from the GitHub folder
async function populateExampleFiles() {
  const apiUrl = 'https://api.github.com/repos/pelenn22/EIS-easyfit/contents/Example%20data';
  try {
    const resp = await fetch(apiUrl);
    if (!resp.ok) throw new Error('GitHub API request failed');
    const items = await resp.json();
    // Clear any existing options except the placeholder (first child)
    while (exampleSelect.options.length > 1) {
      exampleSelect.remove(1);
    }
    items.forEach(item => {
      if (item.type === 'file' && item.name.endsWith('.txt')) {
        const opt = document.createElement('option');
        opt.value = item.name;
        // Show a readable name (remove extension)
        opt.textContent = item.name.replace('.txt', '').replace(/_/g, ' ');
        exampleSelect.appendChild(opt);
      }
    });
    exampleSelect.disabled = false;


  } catch (e) {
    console.error('Failed to fetch example list:', e);
    // The page also works from file:// or without network, where this list can
    // never arrive; say so in the control instead of leaving an empty dropdown.
    if (exampleSelect.options.length) {
      exampleSelect.options[0].textContent = 'Example files unavailable (no network?)';
      exampleSelect.disabled = true;
    }
  }
}
populateExampleFiles();

// Load example data immediately when a selection is made
exampleSelect.addEventListener('change', async () => {
  const fileName = exampleSelect.value;
  if (!fileName) return;

  // The name comes from the GitHub listing, so it may contain characters that
  // have a meaning inside a URL (space, '#', '%').
  const rawUrl = `https://raw.githubusercontent.com/pelenn22/EIS-easyfit/main/Example%20data/${encodeURIComponent(fileName)}`;
  try {
    const resp = await fetch(rawUrl);
    if (!resp.ok) throw new Error(`Cannot fetch ${fileName}: ${resp.status}`);

    const csvText = await resp.text();
    const data = parseImpedanceData(csvText);
    if (data.freq.length < 2) {
      alert('No data rows found in the example file.');
      return;
    }

    // Same initialization as file input
    loadedData = data;
    lastFit = null;
    freqRange = null;
    downloadBtn.disabled = true;
    document.getElementById('fitResults').innerHTML = '';

    minFreqInput.value = formatFreq(Math.min.apply(null, data.freq));
    maxFreqInput.value = formatFreq(Math.max.apply(null, data.freq));
    rangeInfo.textContent = '';
    rangePanel.style.display = 'flex';
    renderPlots(data, null);
    // update start values & UI after loading data (example)
    if (customCircuit) {
      const {starts, bounds} = guessStartAndBounds(customCircuit.params, data);
      userStartValues = starts;
      userParamBounds = bounds;
      renderParamControls(customCircuit.params);
    }
    fitBtn.disabled = false; kkBtn.disabled = false;
  } catch (err) {
    alert('Failed to load example data: ' + err.message);
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
        console.log('Parsed', data.freq.length, 'points');
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
      // update start values & UI after loading data
      if (customCircuit) {
        const {starts, bounds} = guessStartAndBounds(customCircuit.params, data);
        userStartValues = starts;
        userParamBounds = bounds;
        renderParamControls(customCircuit.params);
      }
      fitBtn.disabled = false; kkBtn.disabled = false;
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
      const zScale = meanImpedanceMagnitude(data);
      let meta = 'Model: Custom circuit' +
        ' — mean |residual|: ' + error.toExponential(SIG_DIGITS - 1) + ' Ω' +
        (zScale > 0 ? ' (' + (error / zScale * 100).toPrecision(SIG_DIGITS) + ' % of |Z|)' : '') +
        ' — iterations: ' + iterations + ' — ' + stopLabel;
      if (rangeRestricted()) {
        const b = rangeBounds();
        meta += ' — fit range: ' + formatFreq(b.min) + ' – ' + formatFreq(b.max) + ' Hz (' + data.freq.length + '/' + loadedData.freq.length + ' points)';
      }
      renderFitTable(names, values, meta, error, absErrors, zScale);
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
      const rel = (absErr !== '' && val !== 0 && !isNaN(absErr)) ? absErr / Math.abs(val) * 100 : '';
      const relErr = rel === '' ? '' : (rel >= 1000 ? rel.toExponential(1) : rel.toFixed(2));
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
    // circuitZ()/modelZ() return {real, imag} only, so take the frequencies
    // from the fit grid itself (z.freq used to be undefined -> empty column)
    fitPoints.forEach((z, i) => {
      allRows.push([f[i], z.real, -z.imag]);
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
      // initialise start values (use data if already loaded)
      if (loadedData) {
         const {starts, bounds} = guessStartAndBounds(customCircuit.params, loadedData);
         userStartValues = starts;
         userParamBounds = bounds;
       } else {
         userStartValues = circuitInitialGuesses(customCircuit.params, {freq: [], zreal: [], minusImZ: []});
         // no data to scale the bounds from: let the fit use its own guesses
         userParamBounds = null;
       }
       renderParamControls(customCircuit.params);
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

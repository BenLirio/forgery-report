// Handwriting Bureau — Questioned Documents forgery report.
// Mechanic: user signs on canvas (finger/mouse) → 8 deterministic analytics → verdict + archetype.
// Share: stroke data is saved to case-store, share URL is ?c=<id>.

// --- Config ---
const SLUG = 'forgery-report';
const CASE_STORE_BASE = 'https://rrun6q1lfk.execute-api.us-east-1.amazonaws.com';

// --- DOM ---
const signScreen = document.getElementById('sign-screen');
const incomingScreen = document.getElementById('incoming-screen');
const loadingScreen = document.getElementById('loading-screen');
const reportScreen = document.getElementById('report-screen');

const sigCanvas = document.getElementById('sig-canvas');
const replayCanvas = document.getElementById('replay-canvas');
const clearBtn = document.getElementById('clear-btn');
const submitBtn = document.getElementById('submit-btn');
const resetBtn = document.getElementById('reset-btn');
const incomingContinue = document.getElementById('incoming-continue');
const incomingVerdict = document.getElementById('incoming-verdict');
const instructionText = document.getElementById('instruction-text');
const loaderText = document.getElementById('loader-text');
const reportDoc = document.getElementById('report-doc');

// --- State ---
let strokes = []; // array of strokes; each stroke = array of {x,y,t}
let activeStroke = null;
let sigRect = null;
let sigLogical = { w: 0, h: 0 }; // canvas CSS size in px
let pendingReport = null; // the report payload we render + share

// --- Canvas setup ---

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height, dpr };
}

function redrawSignature() {
  const { ctx, w, h } = setupCanvas(sigCanvas);
  sigLogical = { w, h };
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#141210';
  ctx.lineWidth = 2.4;
  for (const stroke of strokes) {
    if (stroke.length < 2) {
      // dot
      if (stroke.length === 1) {
        ctx.beginPath();
        ctx.arc(stroke[0].x, stroke[0].y, 1.4, 0, Math.PI * 2);
        ctx.fillStyle = '#141210';
        ctx.fill();
      }
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    for (let i = 1; i < stroke.length; i++) {
      ctx.lineTo(stroke[i].x, stroke[i].y);
    }
    ctx.stroke();
  }
}

// Input handling
function getPoint(e) {
  const rect = sigCanvas.getBoundingClientRect();
  const src = (e.touches && e.touches[0]) || e;
  return {
    x: src.clientX - rect.left,
    y: src.clientY - rect.top,
    t: performance.now()
  };
}

function startStroke(e) {
  e.preventDefault();
  activeStroke = [getPoint(e)];
  strokes.push(activeStroke);
  redrawSignature();
  updateSubmitState();
}

function extendStroke(e) {
  if (!activeStroke) return;
  e.preventDefault();
  activeStroke.push(getPoint(e));
  redrawSignature();
}

function endStroke(e) {
  if (!activeStroke) return;
  e && e.preventDefault && e.preventDefault();
  activeStroke = null;
  updateSubmitState();
}

sigCanvas.addEventListener('mousedown', startStroke);
window.addEventListener('mousemove', (e) => { if (activeStroke) extendStroke(e); });
window.addEventListener('mouseup', (e) => { if (activeStroke) endStroke(e); });
sigCanvas.addEventListener('touchstart', startStroke, { passive: false });
sigCanvas.addEventListener('touchmove', extendStroke, { passive: false });
sigCanvas.addEventListener('touchend', endStroke, { passive: false });
sigCanvas.addEventListener('touchcancel', endStroke, { passive: false });

// Reset DPR / size on resize
window.addEventListener('resize', () => {
  redrawSignature();
});

function updateSubmitState() {
  const totalPoints = strokes.reduce((s, st) => s + st.length, 0);
  const totalLen = totalPathLength(strokes);
  const enough = totalPoints >= 8 && totalLen > 40;
  submitBtn.disabled = !enough;
}

clearBtn.addEventListener('click', () => {
  strokes = [];
  redrawSignature();
  updateSubmitState();
  instructionText.textContent = 'Try again. Sign your name below exactly as you would a package — finger or mouse.';
});

resetBtn.addEventListener('click', () => {
  strokes = [];
  pendingReport = null;
  // Clear URL param on reset so user can sign fresh
  history.replaceState(null, '', location.pathname);
  show(signScreen);
  // Re-init canvas in case dimensions changed
  requestAnimationFrame(() => redrawSignature());
  updateSubmitState();
});

submitBtn.addEventListener('click', submitSpecimen);

// --- Analytics ---

function totalPathLength(strokes) {
  let L = 0;
  for (const s of strokes) {
    for (let i = 1; i < s.length; i++) {
      L += Math.hypot(s[i].x - s[i-1].x, s[i].y - s[i-1].y);
    }
  }
  return L;
}

function computeBoundingBox(strokes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) for (const p of s) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// Loop tightness: count approximate loops & measure mean loop enclosed-area / perimeter²
// Detect loops = within-stroke self-approach (later point within D of an earlier point of same stroke).
function loopTightness(strokes) {
  let loopCount = 0;
  let tightnessSum = 0;
  const D = 10; // px tolerance
  for (const s of strokes) {
    if (s.length < 12) continue;
    for (let i = 0; i < s.length - 10; i++) {
      for (let j = i + 10; j < s.length; j++) {
        if (Math.hypot(s[i].x - s[j].x, s[i].y - s[j].y) < D) {
          // one loop from i..j
          let per = 0;
          for (let k = i + 1; k <= j; k++) per += Math.hypot(s[k].x - s[k-1].x, s[k].y - s[k-1].y);
          // shoelace
          let area = 0;
          for (let k = i; k < j; k++) area += s[k].x * s[k+1].y - s[k+1].x * s[k].y;
          area = Math.abs(area) / 2;
          const tight = per > 0 ? (4 * Math.PI * area) / (per * per) : 0; // circularity 0..1
          tightnessSum += tight;
          loopCount++;
          i = j; // don't double-count; advance outer
          break;
        }
      }
    }
  }
  if (loopCount === 0) return { score: 0, loops: 0 };
  const mean = tightnessSum / loopCount;
  // score 0..100 — scale & clamp
  return { score: Math.max(0, Math.min(100, Math.round(mean * 140))), loops: loopCount };
}

// Slant variance: stddev of angle (in degrees) of smoothed short segments across all strokes (restricted to non-near-horizontal).
function slantVariance(strokes) {
  const angles = [];
  const STEP = 3;
  for (const s of strokes) {
    if (s.length < STEP + 1) continue;
    for (let i = STEP; i < s.length; i++) {
      const dx = s[i].x - s[i - STEP].x;
      const dy = s[i].y - s[i - STEP].y;
      const len = Math.hypot(dx, dy);
      if (len < 4) continue;
      // convert to "slant" = angle from vertical, favoring up-strokes (dy<0).
      // We'll use angle in degrees from straight-up.
      const ang = Math.atan2(dx, -dy) * 180 / Math.PI; // 0=up, +=rightward slant
      // Keep only mostly-vertical segments (|ang|<80)
      if (Math.abs(ang) < 80) angles.push(ang);
    }
  }
  if (angles.length < 3) return { stddev: 0, mean: 0 };
  const mean = angles.reduce((a, b) => a + b, 0) / angles.length;
  const v = angles.reduce((a, b) => a + (b - mean) * (b - mean), 0) / angles.length;
  return { stddev: Math.sqrt(v), mean };
}

// Pen-speed spikes: count of samples where instantaneous speed > 2.5x median speed of strokes
function penSpeedSpikes(strokes) {
  const speeds = [];
  const perPoint = [];
  for (const s of strokes) {
    for (let i = 1; i < s.length; i++) {
      const dx = s[i].x - s[i-1].x;
      const dy = s[i].y - s[i-1].y;
      const dt = Math.max(1, s[i].t - s[i-1].t);
      const sp = Math.hypot(dx, dy) / dt; // px/ms
      speeds.push(sp);
      perPoint.push(sp);
    }
  }
  if (speeds.length < 4) return { spikes: 0, median: 0, max: 0 };
  const sorted = speeds.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0.001;
  const threshold = median * 2.5;
  let spikes = 0;
  for (const sp of speeds) if (sp > threshold) spikes++;
  return { spikes, median, max: sorted[sorted.length - 1] };
}

// Letter-size ratio: bounding-box height divided by median stroke height
function letterSizeRatio(strokes) {
  const bb = computeBoundingBox(strokes);
  const heights = [];
  for (const s of strokes) {
    if (s.length < 2) continue;
    let minY = Infinity, maxY = -Infinity;
    for (const p of s) { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
    heights.push(maxY - minY);
  }
  if (heights.length === 0 || bb.h === 0) return { ratio: 1 };
  heights.sort((a, b) => a - b);
  const med = heights[Math.floor(heights.length / 2)] || 1;
  return { ratio: bb.h / Math.max(1, med) };
}

// Avg pressure-duration (time between pen-lifts) — ms
function avgLiftDuration(strokes) {
  if (strokes.length < 2) return { liftMs: 0, lifts: 0 };
  let total = 0;
  let count = 0;
  for (let i = 1; i < strokes.length; i++) {
    const prevEnd = strokes[i-1][strokes[i-1].length - 1];
    const curStart = strokes[i][0];
    if (prevEnd && curStart) {
      total += Math.max(0, curStart.t - prevEnd.t);
      count++;
    }
  }
  if (count === 0) return { liftMs: 0, lifts: 0 };
  return { liftMs: total / count, lifts: count };
}

// The 8-field panel
function computeAnalytics(strokes) {
  const bb = computeBoundingBox(strokes);
  const pathLen = totalPathLength(strokes);
  const loop = loopTightness(strokes);
  const slant = slantVariance(strokes);
  const spikes = penSpeedSpikes(strokes);
  const lsr = letterSizeRatio(strokes);
  const lift = avgLiftDuration(strokes);
  const strokeCount = strokes.length;
  const aspect = bb.h > 0 ? bb.w / bb.h : 0;

  return {
    loopTightness: loop.score,          // 0..100
    loopCount: loop.loops,
    slantVarianceDeg: Math.round(slant.stddev * 10) / 10,
    slantMeanDeg: Math.round(slant.mean * 10) / 10,
    penSpeedSpikes: spikes.spikes,
    letterSizeRatio: Math.round(lsr.ratio * 100) / 100,
    avgLiftMs: Math.round(lift.liftMs),
    liftCount: lift.lifts,
    pathLenPx: Math.round(pathLen),
    strokeCount,
    aspect: Math.round(aspect * 100) / 100,
    bboxW: Math.round(bb.w),
    bboxH: Math.round(bb.h)
  };
}

// --- Deterministic archetype + verdict buckets ---

// Verdict risk tiers keyed on (spikes + slant variance + loop tightness).
// Risk is a 0..3 integer. Higher = more "forgery risk" theatrics.
function computeRiskTier(a) {
  let score = 0;
  // slant variance (big variance = higher risk)
  if (a.slantVarianceDeg > 18) score += 2;
  else if (a.slantVarianceDeg > 9) score += 1;
  // pen-speed spikes
  if (a.penSpeedSpikes >= 8) score += 2;
  else if (a.penSpeedSpikes >= 3) score += 1;
  // loop tightness (very low = suspicious; very high = controlled)
  if (a.loopTightness < 15 && a.loopCount >= 1) score += 1;
  // path length tiny = cagey; huge = flamboyant
  if (a.pathLenPx > 1600) score += 1;
  if (score >= 5) return 3;
  if (score >= 3) return 2;
  if (score >= 1) return 1;
  return 0;
}

const VERDICT_LINES = {
  3: {
    label: 'SEVERE FORGERY RISK',
    copy: "Subject exhibits pronounced ink-lift anxiety and terminal-stroke hesitation consistent with serial check-writers. Recommend co-signatory supervision for all instruments exceeding forty-nine United States dollars."
  },
  2: {
    label: 'MODERATE FORGERY RISK',
    copy: "Slant variance and velocity spikes suggest the hand was composing the signature rather than executing it. Not a forger yet — but a person whose identity is, respectfully, still under construction."
  },
  1: {
    label: 'LOW FORGERY RISK',
    copy: "The specimen presents a stable loop geometry and unremarkable pen-lift cadence. Subject is probably exactly who they say they are, which is, statistically, the most suspicious thing of all."
  },
  0: {
    label: 'NEGLIGIBLE FORGERY RISK',
    copy: "Examiner finds nothing actionable. The hand is confident, practiced, and bureaucratically inert. This signature would be accepted at any bank branch between the hours of 9:03 and 2:47 p.m."
  }
};

// Archetype chosen deterministically from analytics vector — 12 flattering-or-absurd buckets.
const ARCHETYPES = [
  { name: 'The Confident Embezzler',        copy: 'Clean baseline, tight loops, zero hesitation. The hand of someone who signs for other people\'s money without blinking.' },
  { name: 'The Trembling Diplomat',         copy: 'High slant variance under controlled velocity. You sign treaties you haven\'t read, and you sign them slowly.' },
  { name: 'The Flat-Line Hostage-Taker',    copy: 'Minimal vertical range, long uninterrupted path. You were told to sign and you did exactly that, which is itself a red flag.' },
  { name: 'The Serial Check-Writer',        copy: 'Repeating loop tightness and a reliable pen-lift cadence. You have signed for groceries, for leases, for love. You will sign again.' },
  { name: 'The Forensic Shoplifter',        copy: 'Short path, clipped strokes, exit velocity elevated. Your signature is already halfway out the door before the pen leaves the paper.' },
  { name: 'The Notary in Witness Protection', copy: 'Perfectly average everything. An alarmingly unsuspicious hand. Examiner would like to know where you were the night of April 14th.' },
  { name: 'The Cursive-School Valedictorian', copy: 'Controlled loops, even slant, generous size ratio. You won a ribbon in 4th grade for this and you have never let us forget.' },
  { name: 'The Corporate Ghost-Signer',     copy: 'Angular, efficient, emotionally withheld. You sign at the bottom of documents you didn\'t draft and can\'t remember approving.' },
  { name: 'The Romantic Defaulter',         copy: 'Decorative loops, wandering baseline, expressive pen lifts. You sign love letters with more gusto than loan paperwork. It shows.' },
  { name: 'The Witness Stand Regular',      copy: 'High velocity spikes, confident terminals. You sign like someone who has been sworn in before and fully expects to be again.' },
  { name: 'The Deep-Cover Pseudonym',       copy: 'Unusual aspect ratio and asymmetric lift timing. This is not the signature of the person currently holding the pen. Examiner will not be asking follow-up questions.' },
  { name: 'The Courthouse Insomniac',       copy: 'Erratic speed, drifting slant, long pauses between strokes. You sign things at 3 a.m. and then worry about it in the morning.' },
];

function pickArchetype(a) {
  // Build a signed integer from the analytics vector so the same strokes → same archetype.
  const key = `${a.loopTightness}|${a.slantVarianceDeg}|${a.penSpeedSpikes}|${a.letterSizeRatio}|${a.avgLiftMs}|${a.pathLenPx}|${a.strokeCount}|${a.aspect}`;
  return ARCHETYPES[hash(key) % ARCHETYPES.length];
}

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// --- Compose the report payload ---

function buildReport(strokes) {
  const a = computeAnalytics(strokes);
  const tier = computeRiskTier(a);
  const verdict = VERDICT_LINES[tier];
  const archetype = pickArchetype(a);
  const caseNum = 'QD-' + (hash(JSON.stringify({ a, tier })) % 99999).toString().padStart(5, '0');
  const examiner = pickExaminer(a);
  const filedAt = new Date();
  return { a, tier, verdict, archetype, caseNum, examiner, filedAt: filedAt.toISOString() };
}

function pickExaminer(a) {
  const pool = [
    'A. Markwell', 'R. Penworthy', 'J. Stroud', 'E. Halberd', 'M. Kerrigan',
    'D. Ashbrook', 'S. Feldspar', 'T. Cavanaugh', 'L. Quellbrunn', 'V. Hardcastle'
  ];
  const key = `${a.strokeCount}|${a.avgLiftMs}|${a.pathLenPx}`;
  return pool[hash(key) % pool.length];
}

// --- Submit flow ---

async function submitSpecimen() {
  if (strokes.length === 0) return;
  submitBtn.disabled = true;
  pendingReport = buildReport(strokes);
  show(loadingScreen);

  const msgs = [
    'measuring ink-lift intervals…',
    'fitting bezier to terminal strokes…',
    'cross-referencing questioned-documents archive…',
    'stamping CLASSIFIED (Rev. 7)…'
  ];
  await animateLoader(msgs, 2200);

  renderReport(pendingReport, strokes);
  show(reportScreen);

  // Save to case-store and update URL.
  try {
    const payload = encodeSharePayload(strokes, pendingReport);
    const id = await saveCaseToStore(payload);
    if (id) {
      history.replaceState(null, '', '?c=' + id);
    }
  } catch (e) {
    // silent; share still works via the fallback in share()
  }
}

async function animateLoader(msgs, totalMs) {
  const per = Math.max(400, Math.floor(totalMs / msgs.length));
  for (const m of msgs) {
    loaderText.textContent = m;
    await new Promise((r) => setTimeout(r, per));
  }
}

// --- Rendering the report document ---

function renderReport(r, strokesForDisplay) {
  const a = r.a;
  const dateStr = new Date(r.filedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
  const timeStr = new Date(r.filedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  reportDoc.innerHTML = `
    <div class="classified-stamp">CLASSIFIED
      <span class="sub">QD / LEVEL 3</span>
    </div>

    <div class="fold top"></div>
    <div class="fold bot"></div>

    <header class="report-head">
      ${sealSVG()}
      ${sealSVG(true)}
      <p class="head-sub">Federal Bureau of Questioned Documents</p>
      <h2>Forensic Examiner's Report</h2>
      <p class="head-sub">Form QD-17 &mdash; Specimen Analysis</p>
    </header>

    <div class="case-meta">
      <b>File No.</b><span>${escapeHtml(r.caseNum)}</span>
      <b>Filed</b><span>${escapeHtml(dateStr)} &middot; ${escapeHtml(timeStr)}</span>
      <b>Examiner</b><span>${escapeHtml(r.examiner)}</span>
      <b>Disposition</b><span>PRELIMINARY</span>
    </div>

    <div class="exhibit">
      <p class="exhibit-label">Exhibit A &mdash; Traced Specimen (Actual Strokes)</p>
      <canvas id="trace-canvas"></canvas>
      <p class="exhibit-tag">Traced at 1:1 &middot; ${a.strokeCount} stroke${a.strokeCount === 1 ? '' : 's'} &middot; ${a.pathLenPx}px path</p>
    </div>

    <div class="analytics">
      ${analyticsCell('Loop Tightness', a.loopTightness, '/100', a.loopTightness / 100)}
      ${analyticsCell('Slant Variance', a.slantVarianceDeg, '°', Math.min(1, a.slantVarianceDeg / 30))}
      ${analyticsCell('Pen-Speed Spikes', a.penSpeedSpikes, 'ct', Math.min(1, a.penSpeedSpikes / 15))}
      ${analyticsCell('Letter-Size Ratio', a.letterSizeRatio, 'x', Math.min(1, a.letterSizeRatio / 6))}
      ${analyticsCell('Avg Pen-Lift', a.avgLiftMs, 'ms', Math.min(1, a.avgLiftMs / 800))}
      ${analyticsCell('Total Path Length', a.pathLenPx, 'px', Math.min(1, a.pathLenPx / 2000))}
      ${analyticsCell('Stroke Count', a.strokeCount, 'ct', Math.min(1, a.strokeCount / 12))}
      ${analyticsCell('Aspect Ratio', a.aspect, 'w/h', Math.min(1, a.aspect / 8))}
    </div>

    <div class="verdict">
      <p class="verdict-label">Three-Line Forensic Verdict</p>
      <p class="verdict-line">${escapeHtml(r.verdict.label)}<br>&mdash; ${escapeHtml(r.archetype.name.toUpperCase())}</p>
      <p class="verdict-copy">${escapeHtml(r.verdict.copy)}</p>
    </div>

    <div class="archetype">
      <p class="archetype-label">Signatory Archetype (Provisional)</p>
      <p class="archetype-name">${escapeHtml(r.archetype.name)}</p>
      <p class="archetype-copy">${escapeHtml(r.archetype.copy)}</p>
    </div>

    <div class="examiner-row">
      <div class="examiner-box">
        <div class="examiner-sig">${escapeHtml(r.examiner)}</div>
        <p class="examiner-name">Signature of Examiner &middot; ${escapeHtml(r.caseNum)}</p>
      </div>
      <div class="examiner-box">
        <div class="examiner-sig" style="text-align:right">${escapeHtml(dateStr)}</div>
        <p class="examiner-name" style="text-align:right">Date Filed</p>
      </div>
    </div>
  `;

  drawTrace(strokesForDisplay, r);
}

function sealSVG(right) {
  const cls = right ? 'seal-right' : 'seal';
  return `<svg class="${cls}" viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="40" cy="40" r="36" fill="none" stroke="#161310" stroke-width="1.6"/>
    <circle cx="40" cy="40" r="28" fill="none" stroke="#161310" stroke-width="0.9"/>
    <text x="40" y="44" text-anchor="middle" font-family="'Playfair Display', serif" font-weight="900" font-size="14" fill="#a51e1a">Q.D.</text>
    <text x="40" y="56" text-anchor="middle" font-family="'Special Elite', monospace" font-size="6" letter-spacing="1" fill="#161310">BUREAU</text>
  </svg>`;
}

function analyticsCell(label, value, unit, meter) {
  return `<div class="cell">
    <p class="label">${escapeHtml(label)}</p>
    <p class="value">${escapeHtml(String(value))}<span class="unit">${escapeHtml(unit)}</span></p>
    <div class="meter"><div class="meter-fill" style="width:${Math.max(2, Math.min(100, Math.round(meter * 100)))}%"></div></div>
  </div>`;
}

function drawTrace(strokesForDisplay, r) {
  const c = document.getElementById('trace-canvas');
  if (!c) return;
  const { ctx, w, h } = setupCanvas(c);
  ctx.clearRect(0, 0, w, h);

  // guideline
  ctx.strokeStyle = 'rgba(22,19,16,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(12, h * 0.68);
  ctx.lineTo(w - 12, h * 0.68);
  ctx.stroke();

  // Fit strokes into canvas bounds with padding
  const bb = computeBoundingBox(strokesForDisplay);
  if (bb.w === 0 || bb.h === 0) return;
  const pad = 16;
  const scale = Math.min((w - pad * 2) / bb.w, (h - pad * 2) / bb.h);
  const offX = (w - bb.w * scale) / 2 - bb.minX * scale;
  const offY = (h - bb.h * scale) / 2 - bb.minY * scale;

  ctx.strokeStyle = '#161310';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokesForDisplay) {
    if (s.length < 2) {
      if (s.length === 1) {
        ctx.beginPath();
        ctx.arc(s[0].x * scale + offX, s[0].y * scale + offY, 1.6, 0, Math.PI * 2);
        ctx.fillStyle = '#161310';
        ctx.fill();
      }
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(s[0].x * scale + offX, s[0].y * scale + offY);
    for (let i = 1; i < s.length; i++) {
      ctx.lineTo(s[i].x * scale + offX, s[i].y * scale + offY);
    }
    ctx.stroke();
  }

  // Overlay: little analyst marker at first and last point
  const first = strokesForDisplay[0][0];
  const lastStroke = strokesForDisplay[strokesForDisplay.length - 1];
  const last = lastStroke[lastStroke.length - 1];
  ctx.strokeStyle = '#a51e1a';
  ctx.lineWidth = 1;
  [first, last].forEach((p, idx) => {
    if (!p) return;
    const cx = p.x * scale + offX;
    const cy = p.y * scale + offY;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = "9px 'Special Elite', monospace";
    ctx.fillStyle = '#a51e1a';
    ctx.fillText(idx === 0 ? 'i' : 'f', cx + 8, cy + 3);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Replay (incoming specimen) ---

function renderReplay(strokesIn) {
  const c = replayCanvas;
  const { ctx, w, h } = setupCanvas(c);
  ctx.clearRect(0, 0, w, h);
  const bb = computeBoundingBox(strokesIn);
  if (bb.w === 0 || bb.h === 0) return;

  const pad = 18;
  const scale = Math.min((w - pad * 2) / bb.w, (h - pad * 2) / bb.h);
  const offX = (w - bb.w * scale) / 2 - bb.minX * scale;
  const offY = (h - bb.h * scale) / 2 - bb.minY * scale;

  // guideline
  ctx.strokeStyle = 'rgba(22,19,16,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(12, h * 0.72);
  ctx.lineTo(w - 12, h * 0.72);
  ctx.stroke();

  // animate stroke draw
  ctx.strokeStyle = '#161310';
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let strokeIdx = 0;
  let pointIdx = 0;

  function step() {
    if (strokeIdx >= strokesIn.length) return;
    const s = strokesIn[strokeIdx];
    if (s.length < 2) { strokeIdx++; pointIdx = 0; requestAnimationFrame(step); return; }
    if (pointIdx === 0) {
      ctx.beginPath();
      ctx.moveTo(s[0].x * scale + offX, s[0].y * scale + offY);
      pointIdx = 1;
    }
    const steps = 3; // draw a few points per frame
    for (let k = 0; k < steps && pointIdx < s.length; k++, pointIdx++) {
      ctx.lineTo(s[pointIdx].x * scale + offX, s[pointIdx].y * scale + offY);
    }
    ctx.stroke();
    if (pointIdx >= s.length) {
      strokeIdx++;
      pointIdx = 0;
    }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// --- Share payload encoding / decoding ---
// Compact stroke data: we quantize each point (1px granularity) and downsample lightly.

function encodeSharePayload(strokes, report) {
  // Normalize to bounding box → fit to ~400x200 reference frame.
  const bb = computeBoundingBox(strokes);
  const REF_W = 400, REF_H = 200;
  const scale = (bb.w > 0 && bb.h > 0) ? Math.min(REF_W / bb.w, REF_H / bb.h) : 1;

  // keep timing; downsample every other point for strokes >50 pts
  const out = strokes.map((s) => {
    const simplified = [];
    const keepEvery = s.length > 80 ? 2 : 1;
    for (let i = 0; i < s.length; i += keepEvery) simplified.push(s[i]);
    if (simplified[simplified.length - 1] !== s[s.length - 1]) simplified.push(s[s.length - 1]);
    return simplified.map((p) => ({
      x: Math.round((p.x - bb.minX) * scale),
      y: Math.round((p.y - bb.minY) * scale),
      t: Math.round(p.t)
    }));
  });
  const payload = { v: 1, s: out, r: { tier: report.tier, arch: report.archetype.name, case: report.caseNum } };
  return JSON.stringify(payload);
}

function decodeSharePayload(str) {
  try {
    const obj = JSON.parse(str);
    if (!obj || !Array.isArray(obj.s)) return null;
    // Make sure t is monotonic per stroke
    return obj;
  } catch (e) { return null; }
}

// --- Case store ---

async function saveCaseToStore(data) {
  try {
    const res = await fetch(CASE_STORE_BASE + '/case', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: SLUG, data })
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.id;
  } catch (e) { return null; }
}

async function loadCaseFromStore(id) {
  try {
    const res = await fetch(CASE_STORE_BASE + '/case/' + encodeURIComponent(id));
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.data;
  } catch (e) { return null; }
}

// --- Share ---

function share() {
  const url = location.href;
  const text = "I just got examined by the Handwriting Bureau. My signature has opinions.";
  if (navigator.share) {
    navigator.share({ title: document.title, text, url }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => alert('Link copied to clipboard.'));
  } else {
    alert(url);
  }
}
window.share = share;

// --- Screen manager ---

function show(screen) {
  for (const s of [signScreen, incomingScreen, loadingScreen, reportScreen]) {
    if (s === screen) s.classList.remove('hidden');
    else s.classList.add('hidden');
  }
  // Re-setup sig canvas after becoming visible
  if (screen === signScreen) {
    requestAnimationFrame(() => redrawSignature());
  }
}

// --- Boot ---

async function boot() {
  // Set sig canvas to correct size.
  requestAnimationFrame(() => redrawSignature());

  const params = new URLSearchParams(location.search);
  const shortId = params.get('c');
  if (shortId) {
    const data = await loadCaseFromStore(shortId);
    if (data) {
      const payload = decodeSharePayload(data);
      if (payload && payload.s && payload.s.length) {
        // Show incoming screen with replay.
        show(incomingScreen);
        if (payload.r && payload.r.arch) {
          incomingVerdict.textContent = 'Prior specimen filed under ' + payload.r.case + '. Classified as: ' + payload.r.arch + '.';
        } else {
          incomingVerdict.textContent = 'Prior specimen received. Now on file.';
        }
        requestAnimationFrame(() => renderReplay(payload.s));
        incomingContinue.onclick = () => {
          // Clear the URL so the user's own analysis becomes their URL
          history.replaceState(null, '', location.pathname);
          show(signScreen);
          requestAnimationFrame(() => redrawSignature());
        };
        return;
      }
    }
    // If we couldn't hydrate, fall through to sign screen silently.
  }
  show(signScreen);
}

boot();

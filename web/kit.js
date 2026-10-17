// KitStation — Kit page. Standalone HTML/CSS/JS bundled inside KitStation.exe.
// Talks to the native audio engine over the WebView2 postMessage bridge
// (window.KitStation.send + window.chrome.webview messages).

// ── Bridge ────────────────────────────────────────────────────────────────────
const nativeHost = !!window.KitStation && window.KitStation.host === 'native';
function send(msg) {
  if (nativeHost) window.KitStation.send(msg);
  else console.log('[bridge->]', msg);   // running in a plain browser (dev)
}

// ── Global JS error trap — surface any renderer error so the whole page ─────
// doesn't die silently on a stray exception in a click handler.
window.addEventListener('error', (e) => {
  const msg = `JS error: ${e.message}` + (e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '');
  console.error(msg, e.error);
  const bar = document.querySelector('#status');
  if (bar) { bar.style.color = '#e04040'; bar.textContent = msg; }
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = `JS promise rejected: ${e.reason?.message || e.reason}`;
  console.error(msg, e.reason);
  const bar = document.querySelector('#status');
  if (bar) { bar.style.color = '#e04040'; bar.textContent = msg; }
});
if (nativeHost) {
  window.chrome.webview.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || !m.type) return;
    if (m.type === 'padLevel')         updatePadLevel(m.pad, m.level);
    if (m.type === 'status')           setStatus(m.text);
    if (m.type === 'audioDevices')     populateAudioDevices(m);
    if (m.type === 'midiInputs')       populateMidiInputs(m);
    if (m.type === 'midiOutputs')      populateMidiOutputs(m);
    if (m.type === 'sampleAssigned')   onSampleAssigned(m);
    if (m.type === 'sampleRootPicked') onSampleRootPicked(m);
    if (m.type === 'sampleList')       onSampleList(m);
    if (m.type === 'kitList')          onKitList(m);
    if (m.type === 'kitLoaded')        onKitLoaded(m);
    if (m.type === 'kitSaved')         setStatus(`Kit saved: ${m.name}`);
    if (m.type === 'textFile' && m.path === KITS_FILE) onKitsFileArrived(m);
    if (m.type === 'samplePeaks')    onSamplePeaks(m);
    if (m.type === 'pluginList')     onPluginList(m);
    if (m.type === 'masterMeters')   onMasterMeters(m);
    if (m.type === 'virusLoaded')       onVirusLoaded(m);
    if (m.type === 'virusPresetLoaded') onVirusPresetLoaded(m);
    if (m.type === 'virusPresetList')   onVirusPresetList(m);
    if (m.type === 'virusPresetSaved')  onVirusPresetSaved(m);
    if (m.type === 'virusPresetDeleted') onVirusPresetDeleted(m);
  });
}

// Per-pad user-editable state (mirrors PadSettings in C++).
const padState = Array.from({ length: 11 }, () => ({
  sample: '',        // full path (empty = synth fallback)
  pitchSemis: 0,     // -24..+24
  decaySec: 4.0,     // 0.05..4.0
  gain: 1.0,         // 0..2
  choke: 0,          // 0..8 (0 = none)
  reverse: false,    // playback direction flip
  normalize: false,  // peak-normalise on playback
  peaks: null,       // cached Float32-like array of peaks for the wave draw
}));
// Convenience alias for backward compatibility inside this file.
const padSamples = new Proxy(padState, {
  get: (t, k) => (typeof k === 'string' && !isNaN(+k)) ? t[+k].sample : t[k],
  set: (t, k, v) => { if (typeof k === 'string' && !isNaN(+k)) t[+k].sample = v; return true; },
});
function onSampleAssigned(msg) {
  if (msg.pad == null) return;
  padSamples[msg.pad] = msg.ok ? (msg.path || '') : '';
  // Reflect the loaded state in the pad UI so the tube reads "loaded".
  const pad = document.querySelector(`.pad[data-i="${msg.pad}"]`);
  if (pad) pad.classList.toggle('loaded', !!padSamples[msg.pad]);
  // Update the PAD-detail card's sample-name line if this is the current pad.
  const sel = window.__selectedPad ?? 0;
  if (sel === msg.pad) refreshPadDetail(sel);
  setStatus(msg.ok
    ? `Sample loaded on pad ${msg.pad + 1}`
    : `Failed to load sample for pad ${msg.pad + 1}`);
}
function refreshPadDetail(pad) {
  const p = padState[pad];
  const short = (p.sample || '— no sample —').replace(/^.*[\\/]/, '');
  const nameEl = document.querySelector('.sample-name');
  if (nameEl) nameEl.textContent = short;
  refreshSwatchHighlight();
  // Sync reverse/normalize button states to this pad's flags.
  const rev  = document.querySelector('#btnReverse');
  const norm = document.querySelector('#btnNormalize');
  if (rev)  rev.classList.toggle('pill-active', !!p.reverse);
  if (norm) norm.classList.toggle('pill-active', !!p.normalize);
  // Fetch peaks (if a sample is loaded) so the wave repaints per pad.
  if (p.sample) requestPeaks(pad);
  drawWave();
  // Sync the three shape sliders + choke chip highlight to this pad.
  const pitch = document.querySelector('#padPitch');
  const decay = document.querySelector('#padDecay');
  const gain  = document.querySelector('#padGain');
  if (pitch) { pitch.value = p.pitchSemis; document.querySelector('#padPitchVal').textContent = `${p.pitchSemis > 0 ? '+' : ''}${p.pitchSemis}st`; }
  if (decay) { decay.value = p.decaySec;   document.querySelector('#padDecayVal').textContent = p.decaySec.toFixed(2) + 's'; }
  if (gain)  { gain.value  = p.gain;       document.querySelector('#padGainVal').textContent  = p.gain.toFixed(2); }
  document.querySelectorAll('.choke-cells .chip').forEach((c, i) => {
    c.classList.toggle('active', i === p.choke);
  });
  // Pad name field
  const nameField = document.querySelector('.pad-name');
  if (nameField) nameField.value = TR8S[pad].label.replace(/^\d+\s+/, '');
  const hdr = document.querySelector('.pad-card header b');
  if (hdr) hdr.textContent = `PAD ${pad + 1}`;
}

// ── Data (matches src/kit/*.hpp — same shapes the C++ side uses) ─────────────
// Kits — populated at boot from Z:\_claude\_kits.json (real project data).
// Presets stay as the same hardcoded shortlist until we wire a preset source.
let KITS = [];      // [{id, name, pads: [...]}]  full data from _kits.json
const PRESETS = ['Concrete Street','Dem Crews','Distant Sound','Donkey Shoe',
                 'Dub Killa','For You','Forbidden Fruits','Funky Donkey'];

// Root of the shared samples volume. rel_path in a kit is resolved against this.
const SAMPLE_ROOT = '\\\\ds01\\Projects\\';
const KITS_FILE   = 'Z:\\_claude\\_kits.json';

// TR-8S 11 slots — codes + colours + default labels (kTr8sColor in Win32Shell)
// Pastel TR-8S palette — softer / higher-lightness so pads read as coloured
// glass without shouting like neon paint. Matches the wash of the web app.
const TR8S = [
  { slot:'BD', color:'#e89b6a', label:'01 Kick'      },  // peach
  { slot:'SD', color:'#e08590', label:'02 Snare'     },  // dusty pink
  { slot:'LT', color:'#b39ad9', label:'03 Bass'      },  // lavender
  { slot:'MT', color:'#d3a1d9', label:'04 Dog'       },  // pale magenta
  { slot:'HT', color:'#e89b6a', label:'05 Kick C…'   },  // peach
  { slot:'RS', color:'#e08590', label:'06 Kick Pi…'  },  // dusty pink
  { slot:'HC', color:'#8ecfa5', label:'07 Shuffle'   },  // mint
  { slot:'CH', color:'#8ecad4', label:'08 Sky'       },  // aqua
  { slot:'OH', color:'#9abfd9', label:'09 Dub Sr…'   },  // sky
  { slot:'CC', color:'#a3b5e0', label:'10 Snare …'   },  // periwinkle
  { slot:'RC', color:'#a8a5db', label:'11 Rvs Sn…'   },  // indigo mist
];

// Per-pad channel volume 0..127 (mixer fader position under each pad).
const padVol = TR8S.map(() => 100);

const PATTERNS  = ['A','B','C','D','E','F','G','H','1','2'];
const CHAIN     = ['A×','B×','C×','D×','E×','F×','G×','H×','H×'];
const SWATCHES  = ['#f97316','#3b82f6','#7dd3fc','#b06cf7','#eab308','#22c55e','#f4485e','#ec4899',
                   '#93c5fd','#e2e8f0','#ffffff'];
const FX_KNOBS  = [
  { label:'FILTER',  val:50 },
  { label:'REPEAT',  val:0  },
  { label:'DELAY',   val:0  },
  { label:'REVERB',  val:0  },
  { label:'CRUSH',   val:0  },
  { label:'GATE',    val:0  },
  { label:'COMP',    val:0  },
];

// ── Pattern bank ──────────────────────────────────────────────────────────────
// 10 slots: A B C D E F G H + fills 1, 2 (matches kit/Pattern.hpp TOTAL_PATTERNS).
// Each slot carries a motion lane (per current motion-pad selection) and the
// TR-8S grid (11 pads × 16 steps). Clicking pattern pills swaps this state.
const PATTERN_COUNT = 10;
function blankPattern() {
  return {
    motionVel: Array(16).fill(0),
    gridPattern: Array.from({ length: 11 }, () => Array(16).fill(false)),
  };
}
const patterns = Array.from({ length: PATTERN_COUNT }, () => blankPattern());
let currentPatternIdx = 0;

// Seed A with a demo groove so the app isn't silent-looking on first paint.
patterns[0].motionVel = [100,0,0,0, 90,0,0,0, 0,0,110,0, 0,0,0,0];
[0,4,8,12].forEach(s => patterns[0].gridPattern[0][s] = true);           // kick
[4,12].forEach(s => patterns[0].gridPattern[1][s] = true);               // snare
[0,2,4,6,8,10,12,14].forEach(s => patterns[0].gridPattern[7][s] = true); // CH
[0,2,4,6,8,10,12,14].forEach(s => patterns[0].gridPattern[8][s] = true); // OH

// Views bind to the *current* pattern's arrays via these references, which
// get re-pointed whenever the selected pattern changes.
let motionVel    = patterns[0].motionVel;
let gridPattern  = patterns[0].gridPattern;

// ── Chain state ─────────────────────────────────────────────────────────────
// An ordered list of pattern indices (0..9). Sequencer plays each entry for
// one bar then advances to the next; wraps at the end. Empty chain (default)
// loops the single currently-selected pattern.
let chain        = [];       // e.g. [0, 3, 4, 4] plays A · D · E · E
let chainOn      = false;
let chainSlotIdx = 0;        // which slot the sequencer is currently on

// ── UI build ──────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const setStatus = (text) => { $('#status').textContent = text; };

function buildKits() {
  const list = $('#kitList');
  // Placeholder while we wait for the file to load.
  list.innerHTML = KITS.length
    ? KITS.map((k, i) =>
        `<li class="${i === 0 ? 'selected' : ''}" data-i="${i}" title="${escapeAttr(k.name)}">${escapeHtml(k.name)}</li>`
      ).join('')
    : '<li class="muted-sm">Loading kits…</li>';

  // Attach ONCE — property assignment so re-renders don't stack handlers.
  list.onclick = (e) => {
    const li = e.target.closest('li[data-i]'); if (!li) return;
    list.querySelectorAll('li').forEach(x => x.classList.remove('selected'));
    li.classList.add('selected');
    const i = +li.dataset.i;
    loadExternalKit(KITS[i]);
  };

  $('#presetList').innerHTML = PRESETS.map(n =>
    `<li>${escapeHtml(n)} <span class="muted-sm" style="float:right">MID</span></li>`
  ).join('');
}

// ── Real kits (Z:\_claude\_kits.json) ────────────────────────────────────────
function loadKitsFromDisk() {
  if (!nativeHost) return;
  send({ type: 'readTextFile', path: KITS_FILE });
}
function onKitsFileArrived(msg) {
  if (!msg.ok || !msg.body) {
    setStatus(`Couldn't read ${msg.path}`);
    // Re-render the list so "Loading kits…" doesn't stay forever.
    KITS = [];
    buildKits();
    return;
  }
  try {
    const arr = JSON.parse(msg.body);
    if (!Array.isArray(arr)) throw new Error('kits file is not an array');
    KITS = arr;
    // Rebuild the list with real names.
    buildKits();
    // Kick the LEFT column's kit-name field to something sensible.
    const nameField = document.querySelector('#kitName');
    if (nameField && KITS[0]) nameField.value = KITS[0].name;
    setStatus(`Loaded ${KITS.length} kits from _kits.json`);
  } catch (e) {
    console.error('parse kits.json', e);
    setStatus(`Kits JSON parse error: ${e.message}`);
  }
}

// Apply an external kit (from _kits.json) — resolve sample paths against
// \\ds01\Projects\ and push into the C++ engine.
function loadExternalKit(kit) {
  if (!kit || !Array.isArray(kit.pads)) return;
  setStatus(`Loading kit: ${kit.name}…`);
  // Diagnostic breadcrumb so startup.log tells us whether the JS side
  // actually sees a populated kit or a stripped-down one.
  if (nativeHost) send({ type: 'debug',
      msg: `loadExternalKit name=${kit.name} pads=${kit.pads.length} `
         + `firstRel=${(kit.pads[0]||{}).rel_path||'(none)'}` });
  // The kit has up to 16 pads (Kits view in _app). We use the first 11
  // (TR-8S slots). Empty pads (no rel_path) get skipped.
  const nameField = document.querySelector('#kitName');
  if (nameField) nameField.value = kit.name;

  for (let i = 0; i < 11; ++i) {
    const p = kit.pads[i];
    if (!p) { padState[i].sample = ''; continue; }

    // Sync JS-side pad state (pitch/decay/gain/choke) from the kit.
    padState[i].pitchSemis = Math.round(p.pitch ?? 0);
    padState[i].decaySec   = Math.max(0.05, 4 * (p.length ?? 1));   // rough: length is 0..1 of trimmed region
    padState[i].gain       = Math.max(0, Math.min(2, (p.level ?? 1) * (p.gain ?? 1)));
    padState[i].choke      = Math.max(0, Math.min(8, p.choke ?? 0));

    // Push into engine.
    send({ type: 'setPadPitch', pad: i, semis:   padState[i].pitchSemis });
    send({ type: 'setPadDecay', pad: i, seconds: padState[i].decaySec });
    send({ type: 'setPadGain',  pad: i, gain:    padState[i].gain });
    send({ type: 'setPadChoke', pad: i, group:   padState[i].choke });

    // Load the sample (rel_path resolved against \\ds01\Projects\).
    if (p.rel_path) {
      // Normalise slashes — _kits.json uses forward slashes; convert to \ for Windows.
      const rel = p.rel_path.replace(/\//g, '\\');
      const full = SAMPLE_ROOT + rel;
      padState[i].sample = full;
      send({ type: 'assignSample', pad: i, path: full });
    } else {
      padState[i].sample = '';
      send({ type: 'clearSampleForPad', pad: i });
    }

    // Reflect label (Kick/Snare/etc.) in TR8S for the UI.
    if (p.label) TR8S[i].label = `${(i + 1).toString().padStart(2, '0')} ${p.label}`;
  }

  // ── Patterns ────────────────────────────────────────────────────────────
  // _kits.json stores a kit's `seq.patterns[i]` as { vel, prob, sub, alt }
  // where each lane is `{ padIdx: [16 values] }`. We translate that to our
  // two runtime shapes: `gridPattern[pad][step] = bool` and `motionVel[step]
  // = 0..127` (motion strip shows one selected pad at a time).
  const seq = kit.seq;
  if (seq && Array.isArray(seq.patterns)) {
    for (let pi = 0; pi < patterns.length; ++pi) {
      const src = seq.patterns[pi];
      // Reset the slot regardless — old pattern shouldn't bleed through.
      patterns[pi].motionVel   = Array(16).fill(0);
      patterns[pi].gridPattern = Array.from({ length: 11 }, () => Array(16).fill(false));
      if (!src) continue;
      const vel = src.vel || {};
      // Populate the 11-pad × 16-step grid: any step with vel > 0 is "on".
      for (let pd = 0; pd < 11; ++pd) {
        const lane = vel[pd] || vel[String(pd)];   // JSON keys may be strings
        if (!Array.isArray(lane)) continue;
        for (let s = 0; s < 16; ++s) {
          if ((lane[s] || 0) > 0) patterns[pi].gridPattern[pd][s] = true;
        }
      }
      // Motion strip velocities for pad 0 (kick) by default — the user picks
      // which pad the motion strip edits via the dropdown anyway.
      const kickLane = vel[0] || vel["0"];
      if (Array.isArray(kickLane)) {
        for (let s = 0; s < 16; ++s) patterns[pi].motionVel[s] = kickLane[s] || 0;
      }
    }
    // Kick BPM to the kit's saved tempo — through applyBpm so it also
    // restarts the interval + notifies the engine (was previously only
    // updating the visible input, hence the "no effect until nudge" bug).
    if (seq.bpm) applyBpm(+seq.bpm);
    setStatus(`${kit.name}: loaded ${seq.patterns.filter(Boolean).length} patterns`);
  }

  // Repaint pads to show loaded state + new labels, and re-render whichever
  // pattern view is showing so the freshly-loaded steps appear.
  buildPads();
  // Force a rebuild of the motion + grid views by re-selecting pattern 0.
  // (currentPatternIdx→0 short-circuits, so nuke it first.)
  currentPatternIdx = -1;
  selectPattern(0);
  refreshPadDetail(window.__selectedPad ?? 0);
}

function buildPads() {
  const row = $('#padRow');
  row.innerHTML = TR8S.map((p, i) => `
    <div class="pad" data-i="${i}" style="--pad:${p.color}">
      <div class="meters">
        <div class="pad-vol" data-i="${i}" title="Channel volume"><i style="height:${(padVol[i]/127)*100}%"></i></div>
        <div class="vu"><div class="r"></div><div class="y"></div><div class="g"></div></div>
      </div>
      <div class="vu-num">127</div>
      <div class="body">
        <div class="slot">${p.slot}</div>
        <div class="chan">C1</div>
        <div class="hit-led"></div>
      </div>
      <div class="label">${escapeHtml(p.label)}</div>
    </div>`).join('');

  // Trigger the pad on mousedown on the body (not on the meters strip).
  row.addEventListener('mousedown', (e) => {
    if (e.target.closest('.meters')) return;
    const pad = e.target.closest('.pad'); if (!pad) return;
    triggerPad(+pad.dataset.i);
  });

  // Per-pad channel-volume drag — vertical, up = louder.
  row.querySelectorAll('.pad-vol').forEach((el) => {
    const i = +el.dataset.i;
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const setFromY = (y) => {
        const frac = Math.max(0, Math.min(1, 1 - (y - rect.top) / rect.height));
        padVol[i] = Math.round(frac * 127);
        paintPadVol(i);
        // Live stream so the pad's level tracks the drag in real time.
        send({ type: 'setPadVol', pad: i, vol: padVol[i] });
      };
      setFromY(e.clientY);
      document.body.classList.add('dragging');
      const move = (ev) => setFromY(ev.clientY);
      const up   = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.classList.remove('dragging');
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    el.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      padVol[i] = Math.max(0, Math.min(127, padVol[i] - Math.sign(ev.deltaY) * 4));
      paintPadVol(i);
      send({ type: 'setPadVol', pad: i, vol: padVol[i] });
    }, { passive: false });
  });
}

function paintPadVol(i) {
  const bar  = document.querySelector(`.pad[data-i="${i}"] .pad-vol`);
  const fill = bar && bar.querySelector('i');
  if (fill) fill.style.height = `${(padVol[i] / 127) * 100}%`;
  // Set the CSS var used by the ::after cap tick so it tracks the fill height.
  if (bar)  bar.style.setProperty('--vol-pct', `${(padVol[i] / 127) * 100}%`);
}

function triggerPad(i) {
  const pad = document.querySelector(`.pad[data-i="${i}"]`);
  if (!pad) return;
  // Small LED square on top of the pad lights up briefly — crisp, no blur.
  pad.classList.add('hit');
  setTimeout(() => pad.classList.remove('hit'), 150);
  window.__selectedPad = i;                        // remember for LOAD SAMPLE
  refreshPadDetail(i);
  setStatus(`Pad ${i + 1} ${TR8S[i].slot} hit (${TR8S[i].label})`);
  send({ type: 'padPress', pad: i, vel: 1.0 });
  // External MIDI out: fire this pad's clip / note over the Virus rack too.
  if (typeof firePadMidi === 'function') firePadMidi(i, 1.0);
}

function updatePadLevel(i, level) {
  // Placeholder — the audio thread will later push these; we'd animate the .vu block.
  const pad = document.querySelector(`.pad[data-i="${i}"] .vu-num`);
  if (pad) pad.textContent = Math.round(level * 127);
}

function buildPatternRow() {
  $('#patternRow').innerHTML = PATTERNS.map((p, i) =>
    `<button class="pill ${i === 0 ? 'pill-active' : ''}" data-i="${i}"
             title="Click to select · Shift+Click to append to chain">${p}</button>`
  ).join('');
  $('#patternRow').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const idx = +b.dataset.i;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      // Add to chain
      chain.push(idx);
      renderChain();
      setStatus(`Added ${PATTERNS[idx]} to chain (${chain.length} bars)`);
    } else {
      selectPattern(idx);
    }
  };

  renderChain();
}

// ── Chain UI + logic ─────────────────────────────────────────────────────────
function renderChain() {
  const row = $('#chainRow');
  if (!row) return;
  row.innerHTML = chain.length
    ? chain.map((patIdx, slot) =>
        `<button class="pill chain-slot ${slot === chainSlotIdx && chainOn ? 'sel' : ''}"
                 data-slot="${slot}"
                 title="Click to remove from chain">${PATTERNS[patIdx]}<span class="x">×</span></button>`
      ).join('')
    : `<em class="muted">Empty — Shift-click a pattern pill (A/B/C…) to add it to the chain</em>`;
  row.onclick = (e) => {
    const b = e.target.closest('button.chain-slot'); if (!b) return;
    const slot = +b.dataset.slot;
    chain.splice(slot, 1);
    if (chainSlotIdx >= chain.length) chainSlotIdx = 0;
    renderChain();
    updateChainLen();
    setStatus(chain.length ? `Removed slot ${slot + 1}` : 'Chain cleared');
  };
  updateChainLen();
}
function updateChainLen() {
  const el = $('#chainLen'); if (el) el.textContent = `${chain.length} bar${chain.length === 1 ? '' : 's'}`;
}
function wireChainControls() {
  const onBtn = $('#chainOn');
  onBtn.onclick = () => {
    chainOn = !chainOn;
    onBtn.classList.toggle('pill-on', chainOn);
    chainSlotIdx = 0;
    // If chain has entries and we just turned it on, jump to the first slot.
    if (chainOn && chain.length && !seqTimer) {
      selectPattern(chain[0]);
    }
    renderChain();
    setStatus(`Chain ${chainOn ? 'ON' : 'off'}`);
  };
  $('#chainClear').onclick = (e) => {
    e.preventDefault();
    chain = []; chainSlotIdx = 0;
    renderChain();
    setStatus('Chain cleared');
  };
}

// Swap the live pattern arrays and rebuild the pieces that draw from them.
function selectPattern(idx) {
  if (idx < 0 || idx >= PATTERN_COUNT || idx === currentPatternIdx) {
    // still update the highlight so re-selecting the current pill "flashes"
    $('#patternRow').querySelectorAll('.pill').forEach((el, i) =>
      el.classList.toggle('pill-active', i === idx));
    return;
  }
  currentPatternIdx = idx;
  motionVel   = patterns[idx].motionVel;
  gridPattern = patterns[idx].gridPattern;

  $('#patternRow').querySelectorAll('.pill').forEach((el, i) =>
    el.classList.toggle('pill-active', i === idx));

  // Rebuild views bound to these arrays.
  buildMotion();
  buildTr8sGrid();
  setStatus(`Pattern ${PATTERNS[idx]} selected`);
  send({ type: 'selectPattern', pattern: idx });

  if (typeof refreshVirusLcd === 'function') refreshVirusLcd();
}

// ── Drag helper ───────────────────────────────────────────────────────────────
// Attach ns-resize style mouse dragging to any element. Vertical drag (up = +),
// with fine-tune modifiers: Shift = ×5 (faster), Alt = ×0.25 (slow). Wheel
// support included. `opts.get`/`opts.set` are the value getter/setter; the
// element's own painting is up to the caller (called inside opts.set).
function makeDraggable(el, opts) {
  const min  = opts.min ?? 0;
  const max  = opts.max ?? 100;
  const px   = opts.pixelsPerFull ?? 140;   // px of vertical travel = full range
  const wheelStep = opts.wheelStep ?? Math.max(1, Math.round((max - min) / 100));

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY   = e.clientY;
    const startVal = opts.get();
    const range    = max - min;
    document.body.classList.add('dragging');
    // Called after every set — so DSP (filter/gain/etc.) tracks the drag live
    // rather than snapping only on mouse-up. Cheap: postMessage over WebView2
    // is nanosecond-scale, and the C++ side stores into an atomic int/float
    // that the audio thread picks up on the next block.
    const commit = () => { if (opts.onCommit) opts.onCommit(opts.get()); };

    // Optional: if the element itself is a "paint the value" area (a motion
    // bar), let the first mousedown set the value at the click point.
    if (opts.absoluteMode) {
      const rect = el.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
      opts.set(min + frac * range);
      commit();
    }

    function onMove(ev) {
      const speed = ev.shiftKey ? 5 : (ev.altKey ? 0.25 : 1);
      if (opts.absoluteMode) {
        const rect = el.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, 1 - (ev.clientY - rect.top) / rect.height));
        opts.set(min + frac * range);
      } else {
        const dy = (startY - ev.clientY) * speed;
        const v  = startVal + (dy / px) * range;
        opts.set(Math.max(min, Math.min(max, v)));
      }
      commit();   // ← live streaming: DSP hears the change on every mouse move
    }
    function onUp() {
      document.body.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      commit();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  el.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const dir = Math.sign(ev.deltaY);       // wheel-down = negative
    const step = ev.shiftKey ? wheelStep * 5 : wheelStep;
    const v = opts.get() - dir * step;
    opts.set(Math.max(min, Math.min(max, v)));
    if (opts.onCommit) opts.onCommit(opts.get());
  }, { passive: false });
}

// ── PADS layout toggle (Grid ↔ TR-8S row) ────────────────────────────────────
function wirePadsToggle() {
  const grid = $('#padsGrid'), tr8s = $('#padsTr8s'), row = $('#padRow');
  const show = (mode) => {
    row.classList.toggle('mode-grid', mode === 'grid');
    grid.classList.toggle('pill-active', mode === 'grid');
    tr8s.classList.toggle('pill-active', mode !== 'grid');
    send({ type: 'setPadsView', view: mode });
  };
  grid.addEventListener('click', () => show('grid'));
  tr8s.addEventListener('click', () => show('tr8s'));
}

function buildTr8sGrid() {
  const el = $('#tr8sGridView');
  // Header: blank corner + 16 step numbers
  const headerCells = Array.from({ length: 16 }, (_, s) =>
    `<span class="${s % 4 === 0 ? 'beat' : ''}">${s + 1}</span>`).join('');
  el.innerHTML =
    `<div class="tr8s-grid-header"><span></span>${headerCells}</div>` +
    TR8S.map((p, i) => {
      const label = `<div class="row-label" style="--pad:${p.color}">
        <span class="slot">${p.slot}</span>${escapeHtml(p.label)}</div>`;
      const cells = Array.from({ length: 16 }, (_, s) =>
        `<div class="cell ${s % 4 === 0 ? 'beat' : ''} ${gridPattern[i][s] ? 'on' : ''}"
              style="--pad:${p.color}" data-p="${i}" data-s="${s}"></div>`).join('');
      return `<div class="tr8s-grid-row">${label}${cells}</div>`;
    }).join('');

  // Attach the click handler ONCE (via a property, not addEventListener) so
  // repeated calls to buildTr8sGrid don't stack N handlers on the same
  // container — that was the "can't draw on pattern B/C" bug.
  el.onclick = (e) => {
    const c = e.target.closest('.cell'); if (!c) return;
    const p = +c.dataset.p, s = +c.dataset.s;
    gridPattern[p][s] = !gridPattern[p][s];
    c.classList.toggle('on', gridPattern[p][s]);
    setStatus(`${TR8S[p].slot} step ${s + 1} ${gridPattern[p][s] ? 'on' : 'off'}`);
    send({ type: 'setGridStep', pad: p, step: s, on: gridPattern[p][s] });
  };
}

function wireViewToggle() {
  const motion = $('#motionView'),  grid   = $('#tr8sGridView');
  const bM     = $('#viewMotion'),  bG     = $('#viewGrid');
  const show = (which) => {
    const isMotion = which === 'motion';
    motion.hidden = !isMotion; grid.hidden = isMotion;
    bM.classList.toggle('pill-active',  isMotion);
    bG.classList.toggle('pill-active', !isMotion);
    send({ type: 'setPatternView', view: which });
  };
  bM.addEventListener('click', () => show('motion'));
  bG.addEventListener('click', () => show('grid'));
}

function buildMotion() {
  // Populate the pad selector with every TR-8S slot.
  const sel = $('#motionPad');
  sel.innerHTML = TR8S.map((p, i) =>
    `<option value="${i}">${i + 1} · ${escapeHtml(p.slot)} · ${escapeHtml(p.label.replace(/^\d+\s+/, ''))}</option>`
  ).join('');
  sel.addEventListener('change', (e) => {
    send({ type: 'motionSelectPad', pad: +e.target.value });
    // TODO: swap motionVel to the selected pad's saved lane once we track per-pad.
  });

  const strip = $('#motionStrip');
  const steps = Array.from({ length: 16 }, (_, i) => {
    const v = motionVel[i];
    return `<div class="step ${v > 0 ? 'on' : ''} ${i === 4 ? 'sel' : ''}" data-i="${i}">${i + 1}</div>`;
  }).join('');
  const bars = Array.from({ length: 16 }, (_, i) => {
    const v = motionVel[i];
    return `<div class="bar" data-i="${i}"><i style="height:${(v / 127) * 100}%"></i></div>`;
  }).join('');
  strip.innerHTML = steps + bars;

  // Step-number buttons: click to toggle step on/off + select step. Use
  // property-style assignment so repeated buildMotion() calls (on pattern
  // switch) don't stack multiple listeners — the previous handler is replaced.
  strip.onclick = (e) => {
    const el = e.target.closest('.step'); if (!el) return;
    const i = +el.dataset.i;
    const on = el.classList.toggle('on');
    strip.querySelectorAll('.step').forEach(s => s.classList.remove('sel'));
    el.classList.add('sel');
    motionVel[i] = on ? 100 : 0;
    setBar(i, motionVel[i]);
    setStatus(`Step ${i + 1} ${on ? 'on' : 'off'}`);
    send({ type: 'setStep', step: i, vel: motionVel[i] });
  };

  // Velocity bars: click-and-drag paints velocity. Dragging across neighbours
  // sets each in turn (like real TR-8S motion painting).
  strip.querySelectorAll('.bar').forEach((bar, i) => {
    makeDraggable(bar, {
      min: 0, max: 127,
      absoluteMode: true,   // value follows the pointer's Y within the bar
      get: () => motionVel[i],
      set: (v) => { motionVel[i] = Math.round(v); setBar(i, motionVel[i]); },
      onCommit: (v) => send({ type: 'setStep', step: i, vel: Math.round(v) }),
    });
  });

  // Paint-across: mousedown on one bar then drag to neighbours = set each.
  // Same property-assignment trick as above — one handler only, replaced on
  // rebuild.
  let painting = false;
  strip.onmousedown = (e) => { if (e.target.closest('.bar')) painting = true; };
  // Global mouseup / mousemove attached once at boot below in wireMotionOnce.
  strip.onmousemove = (e) => {
    if (!painting) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const bar = el && el.closest('.bar');
    if (!bar || bar.parentElement !== strip) return;
    const i = +bar.dataset.i;
    const rect = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    motionVel[i] = Math.round(frac * 127);
    setBar(i, motionVel[i]);
    const step = strip.querySelector(`.step[data-i="${i}"]`);
    if (step) step.classList.toggle('on', motionVel[i] > 0);
  };
  // Global mouseup releases the paint state — attach once, lazily.
  if (!window.__paintGlobal) {
    document.addEventListener('mouseup', () => { painting = false; });
    window.__paintGlobal = true;
  }
}

function setBar(i, v) {
  const el = document.querySelector(`.motion-strip .bar[data-i="${i}"] > i`);
  if (el) el.style.height = `${(v / 127) * 100}%`;
  const step = document.querySelector(`.motion-strip .step[data-i="${i}"]`);
  if (step) step.classList.toggle('on', v > 0);
}

// Live knob values (mirrors FX_KNOBS values, mutated by drag/wheel).
const fxKnobVals = FX_KNOBS.map(k => k.val);

function buildKnobs() {
  const wrap = $('#fxKnobs');
  wrap.innerHTML = FX_KNOBS.map((k, i) => `
    <div class="fx-knob" data-i="${i}">${knobSvg(k.val)}<div class="lbl">${k.label}</div><div class="val">${k.val}</div></div>
  `).join('');

  wrap.querySelectorAll('.fx-knob').forEach((knob, i) => {
    // Re-query BOTH children every paint. outerHTML = ... replaces the SVG
    // node, so any stored reference goes stale after the first drag pixel
    // (that was the "can't turn the FILTER knob" bug — SEND still fired but
    // the dial visibly stopped moving and the reference detached).
    const paint = () => {
      const v = Math.round(fxKnobVals[i]);
      const svg = knob.querySelector('svg');
      if (svg) svg.outerHTML = knobSvg(v);
      const valEl = knob.querySelector('.val');
      if (valEl) valEl.textContent = v;
    };
    // Drag/wheel attach to the whole knob cell so labels/values are all hits.
    makeDraggable(knob, {
      min: 0, max: 100, pixelsPerFull: 120,
      get: () => fxKnobVals[i],
      set: (v) => { fxKnobVals[i] = v; paint(); },
      onCommit: (v) => send({ type: 'setFxKnob', knob: FX_KNOBS[i].label, value: Math.round(v) }),
    });
  });
}

// Access-Virus-style knob: chrome dial with a ring of 16 red LED dots around
// it. Lit dots up to the current value's angle; dim dots beyond. Small dark
// tick on the chrome shows exact position.
function knobSvg(val) {
  const cx = 16, cy = 16;
  const ringR = 14;    // dot ring radius
  const dialR = 9;     // chrome dial radius
  const N = 16;        // number of LED positions
  const start = Math.PI * 0.75;                 // 7 o'clock (135°)
  const sweep = Math.PI * 1.5;                  // 270° span
  const litN = Math.round((val / 100) * N);

  // LED ring — 16 dots. Lit ones bright red with a glow; unlit dim.
  let dots = '';
  for (let i = 0; i < N; ++i) {
    const t = start + (sweep * i) / (N - 1);
    const x = cx + ringR * Math.cos(t);
    const y = cy + ringR * Math.sin(t);
    const lit = i < litN;
    const color = lit ? '#ff2a1c' : '#4a1210';
    dots += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${lit ? 1.4 : 1}"
             fill="${color}"${lit ? ' filter="url(#glow)"' : ''} />`;
  }

  // Indicator tick — small dark line pointing from dial centre.
  const tickAngle = start + sweep * (val / 100);
  const tx1 = cx + (dialR - 6) * Math.cos(tickAngle);
  const ty1 = cy + (dialR - 6) * Math.sin(tickAngle);
  const tx2 = cx + (dialR - 1) * Math.cos(tickAngle);
  const ty2 = cy + (dialR - 1) * Math.sin(tickAngle);

  return `<svg viewBox="0 0 32 32">
    <defs>
      <radialGradient id="chrome" cx="35%" cy="30%" r="70%">
        <stop offset="0%"  stop-color="#eaeef4" />
        <stop offset="55%" stop-color="#b0b5be" />
        <stop offset="100%" stop-color="#6c727d" />
      </radialGradient>
      <filter id="glow">
        <feGaussianBlur stdDeviation="0.8" result="b" />
        <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
    </defs>
    ${dots}
    <circle cx="${cx}" cy="${cy}" r="${dialR}" fill="url(#chrome)" stroke="#3a3f48" stroke-width="0.5" />
    <line x1="${tx1.toFixed(2)}" y1="${ty1.toFixed(2)}"
          x2="${tx2.toFixed(2)}" y2="${ty2.toFixed(2)}"
          stroke="#1a1d24" stroke-width="1.4" stroke-linecap="round" />
  </svg>`;
}

function buildSwatches() {
  $('#swatches').innerHTML = SWATCHES.map((c) =>
    `<div class="swatch" style="background:${c}" data-c="${c}"></div>`
  ).join('');
  // Repaint highlight to match the currently-selected pad's colour on init.
  refreshSwatchHighlight();

  $('#swatches').addEventListener('click', (e) => {
    const s = e.target.closest('.swatch'); if (!s) return;
    const pad = window.__selectedPad ?? 0;
    const color = s.dataset.c;
    // Update the pad's colour in JS state.
    TR8S[pad].color = color;
    // Repaint the pad's --pad CSS variable so the tube, VU tick, colour of
    // the volume fader, TR-8S grid row-label border etc. all pick it up.
    const padEl = document.querySelector(`.pad[data-i="${pad}"]`);
    if (padEl) padEl.style.setProperty('--pad', color);
    // Also update every TR-8S-grid row-label + cells for that pad.
    document.querySelectorAll(`.tr8s-grid .row-label`).forEach((el, i) => {
      if (i === pad) el.style.setProperty('--pad', color);
    });
    document.querySelectorAll(`.tr8s-grid .cell[data-p="${pad}"]`)
      .forEach(el => el.style.setProperty('--pad', color));
    refreshSwatchHighlight();
    setStatus(`Pad ${pad + 1} colour changed`);
    send({ type: 'setPadColor', pad, color });
  });
}

// Highlight the swatch that matches the currently-selected pad.
function refreshSwatchHighlight() {
  const pad = window.__selectedPad ?? 0;
  const cur = TR8S[pad]?.color;
  document.querySelectorAll('#swatches .swatch').forEach(el =>
    el.classList.toggle('sel', el.dataset.c === cur));
}

// Draw the waveform of the currently-selected pad's sample. Uses real peak
// data pulled from C++ over the bridge — falls back to a decaying-envelope
// sketch when nothing's loaded so the panel doesn't look empty.
function drawWave() {
  const c = $('#wave'); if (!c) return;
  // Match the canvas' pixel resolution to its CSS size (crisp lines on HiDPI).
  const cssW = c.clientWidth  || c.width;
  const cssH = c.clientHeight || c.height;
  if (c.width !== cssW) c.width = cssW;
  if (c.height !== cssH) c.height = cssH;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  // faint centre line
  ctx.strokeStyle = 'rgba(107,255,154,0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

  const pad = window.__selectedPad ?? 0;
  const peaks = padState[pad] && padState[pad].peaks;
  ctx.strokeStyle = '#6bff9a';
  ctx.shadowColor = 'rgba(107,255,154,0.5)';
  ctx.shadowBlur  = 3;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const half = (h - 8) / 2;
  if (peaks && peaks.length) {
    const step = peaks.length / w;
    const reverse = padState[pad].reverse;
    for (let x = 0; x < w; x++) {
      const idx = reverse
        ? Math.floor((w - 1 - x) * step)
        : Math.floor(x * step);
      const pk = peaks[idx] || 0;
      const y = pk * half;
      ctx.moveTo(x + 0.5, h / 2 - y);
      ctx.lineTo(x + 0.5, h / 2 + y);
    }
  } else {
    // Fallback: decaying sine so the card doesn't read as "broken".
    for (let x = 0; x < w; x++) {
      const t = x / w;
      const env = Math.exp(-t * 6) * 0.9 + 0.05;
      const y = env * Math.sin(t * 60 + 2) * half;
      ctx.moveTo(x + 0.5, h / 2 - Math.abs(y));
      ctx.lineTo(x + 0.5, h / 2 + Math.abs(y));
    }
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// Request peaks for a pad and cache them, then redraw.
function requestPeaks(pad) {
  if (!nativeHost) return;
  send({ type: 'getSamplePeaks', pad });
}
function onSamplePeaks(msg) {
  if (msg.pad == null || !Array.isArray(msg.peaks)) return;
  padState[msg.pad].peaks = msg.peaks;
  if ((window.__selectedPad ?? 0) === msg.pad) drawWave();
}
// Available plugins (from SCAN) + the chain the user has assembled.
let availablePlugins = [];
let pluginChain = [];   // [{path, name, kind, bypassed}]
function onPluginList(msg) {
  availablePlugins = msg.list || [];
  const sel = $('#pluginList'); if (!sel) return;
  sel.innerHTML = '<option value="">— pick a plugin to add —</option>' +
    availablePlugins.map(p =>
      `<option value="${escapeAttr(p.path)}">${escapeHtml(p.name)} · ${p.kind.toUpperCase()}</option>`
    ).join('');
  setStatus(`Scanned ${availablePlugins.length} plugins`);
}

function renderPluginChain() {
  const wrap = $('#pluginChain'); if (!wrap) return;
  wrap.innerHTML = pluginChain.length
    ? pluginChain.map((p, i) => `
        <div class="plugin-row ${p.bypassed ? 'bypassed' : ''}" data-i="${i}">
          <span class="idx">${(i + 1).toString().padStart(2, '0')}</span>
          <span class="name" title="${escapeAttr(p.path)}">${escapeHtml(p.name)}</span>
          <span class="kind">${p.kind.toUpperCase()}</span>
          <button class="btn-mini" data-a="ui"     title="Open plugin editor">UI</button>
          <button class="btn-mini" data-a="bypass" title="Bypass in chain">${p.bypassed ? 'ON' : 'BYP'}</button>
          <button class="btn-mini rm" data-a="rm"  title="Remove from chain">×</button>
        </div>`).join('')
    : `<div class="plugin-empty">Chain is empty — add plugins below to build the master bus.</div>`;

  wrap.onclick = (e) => {
    const btn = e.target.closest('button.btn-mini');
    const row = e.target.closest('.plugin-row');
    if (!btn || !row) return;
    const i = +row.dataset.i;
    if (btn.dataset.a === 'rm') {
      pluginChain.splice(i, 1);
      renderPluginChain();
      pushPluginChain();
      setStatus(`Removed slot ${i + 1}`);
    } else if (btn.dataset.a === 'bypass') {
      pluginChain[i].bypassed = !pluginChain[i].bypassed;
      renderPluginChain();
      pushPluginChain();
    } else if (btn.dataset.a === 'ui') {
      send({ type: 'openPluginUi', slot: i });
      setStatus(`Open UI: ${pluginChain[i].name}`);
    }
  };
}
// Mirror the full chain state to the C++ side. Called after every mutation
// (add / remove / bypass / reorder) — C++ replaces its loaded chain to match.
// The chain is serialised as a JSON string in `body` so we don't need a
// nested-object parser on the C++ side.
function pushPluginChain() {
  const wire = pluginChain.map(x => ({ path: x.path, bypassed: !!x.bypassed }));
  send({ type: 'setPluginChain', body: JSON.stringify(wire) });
}
function wirePluginChain() {
  const add = $('#btnPluginAdd');
  if (add) add.addEventListener('click', () => {
    const sel = $('#pluginList');
    if (!sel || !sel.value) return;
    const p = availablePlugins.find(x => x.path === sel.value);
    if (!p) return;
    pluginChain.push({ ...p, bypassed: false });
    renderPluginChain();
    pushPluginChain();
    setStatus(`Added ${p.name} to chain (${pluginChain.length} plugins)`);
  });
}

// ── Transport / meter controls ────────────────────────────────────────────────
// Master volume — was a vertical fader, now a chrome rotary knob on the VU panel.
let levelVal = 75;
function wireLevelFader() {
  const knob = document.querySelector('#masterVolKnob');
  if (!knob) return;
  const dial = knob.querySelector('.vu-knob-dial');
  const paintKnob = () => {
    // Sweep from -135° (0) to +135° (100) — 270° travel like a real pot.
    const deg = -135 + (levelVal / 100) * 270;
    dial.style.setProperty('--rot', deg + 'deg');
  };
  paintKnob();
  makeDraggable(knob, {
    min: 0, max: 100, pixelsPerFull: 140,
    get: () => levelVal,
    set: (v) => { levelVal = v; paintKnob(); },
    onCommit: (v) => send({ type: 'setLevel', value: Math.round(v) }),
  });
  // Push the initial value now so the engine's default 50% isn't the starting point.
  send({ type: 'setLevel', value: Math.round(levelVal) });
}

// ── Analog VU meter ──────────────────────────────────────────────────────────
// Warm amber-backed round meter with a black bezel and a red arc past 0 dB.
// A second small canvas alongside shows compressor gain reduction as a downward
// red bar. Both driven by a 30 fps poll of the C++ meters snapshot.
let vuCurL = 0, vuCurR = 0;    // smoothed values 0..1
let vuGr   = 0;
let vuPoll = null;
function drawVuMeter() {
  const c = document.querySelector('#vuCanvas'); if (!c) return;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);

  // Warm cream backing with a gentle glow — evokes lamp-lit VU
  const grad = ctx.createRadialGradient(w * 0.5, h * 0.85, 20, w * 0.5, h * 0.85, w * 0.75);
  grad.addColorStop(0, '#fbdcc0');
  grad.addColorStop(0.7, '#e6b891');
  grad.addColorStop(1, '#8a5f3f');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(w / 2, h + 20, h + 10, Math.PI, 2 * Math.PI);
  ctx.fill();

  // Scale arc & ticks
  const cx = w / 2, cy = h + 8, r = h - 12;
  // -20 (left) to +5 (right); 0 dB at ~0.75 of the range
  const angFrom = Math.PI + 0.35;       // ≈203°
  const angTo   = 2 * Math.PI - 0.35;   // ≈337°
  const zeroFrac = 0.8;
  const zeroAng = angFrom + (angTo - angFrom) * zeroFrac;

  // Green scale arc
  ctx.strokeStyle = '#2a2320';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, r, angFrom, zeroAng);
  ctx.stroke();
  // Red arc past 0 dB
  ctx.strokeStyle = '#c8362a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, zeroAng, angTo);
  ctx.stroke();

  // Tick marks with dB labels
  ctx.fillStyle = '#2a2320';
  ctx.font = '9px "Barlow Condensed", sans-serif';
  ctx.textAlign = 'center';
  const marks = [
    { f: 0.00, l: '20' },{ f: 0.15, l: '10' },{ f: 0.30, l: '7' },
    { f: 0.45, l: '5'  },{ f: 0.60, l: '3'  },{ f: 0.75, l: '1' },
    { f: 0.80, l: '0'  },{ f: 0.88, l: '3'  },{ f: 0.95, l: '5' },
  ];
  marks.forEach(m => {
    const a = angFrom + (angTo - angFrom) * m.f;
    const x1 = cx + Math.cos(a) * (r - 2);
    const y1 = cy + Math.sin(a) * (r - 2);
    const x2 = cx + Math.cos(a) * (r - 7);
    const y2 = cy + Math.sin(a) * (r - 7);
    ctx.strokeStyle = m.f >= zeroFrac ? '#c8362a' : '#2a2320';
    ctx.lineWidth = m.l === '0' ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const tx = cx + Math.cos(a) * (r - 16);
    const ty = cy + Math.sin(a) * (r - 16) + 3;
    ctx.fillStyle = m.f >= zeroFrac ? '#c8362a' : '#2a2320';
    ctx.fillText(m.l, tx, ty);
  });
  // "VU" text
  ctx.font = 'bold 12px "Barlow Condensed", sans-serif';
  ctx.fillStyle = '#2a2320';
  ctx.fillText('VU', cx, cy - r * 0.28);

  // Needle — average of L & R, mapped exponentially so quiet signals show
  const level = 0.5 * (vuCurL + vuCurR);
  const displayed = Math.pow(Math.min(1, level * 1.4), 0.55);
  const angle = angFrom + (angTo - angFrom) * displayed;
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(angle) * (r - 4), cy + Math.sin(angle) * (r - 4));
  ctx.stroke();
  // Needle pivot cap
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = '#6a6a6a';
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 2 * Math.PI); ctx.stroke();
}
function drawGrMeter() {
  const c = document.querySelector('#grCanvas'); if (!c) return;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  // Ticks
  ctx.fillStyle = '#6a6f78';
  ctx.font = '8px "Barlow Condensed", sans-serif';
  ctx.textAlign = 'right';
  [0, 3, 6, 9, 12].forEach(db => {
    const y = 6 + (db / 15) * (h - 10);
    ctx.fillText(db, w - 4, y + 2);
    ctx.fillRect(w - 2, y, 2, 1);
  });
  // Bar (falls from top, red = more reduction)
  const gr = Math.max(0, Math.min(1, vuGr));
  const barH = gr * (h - 10);
  const grad = ctx.createLinearGradient(0, 6, 0, 6 + barH);
  grad.addColorStop(0,   '#ff5040');
  grad.addColorStop(1,   '#c02818');
  ctx.fillStyle = grad;
  ctx.fillRect(4, 6, w - 12, barH);
}
function meterTick() {
  if (nativeHost) send({ type: 'getMasterMeters' });
  // Smooth ballistics — even if the poll's a bit ragged, the needle glides.
  drawVuMeter();
  drawGrMeter();
}
function onMasterMeters(m) {
  // Peak with fast rise, slow decay — classic VU ballistics.
  const targL = Math.min(1, m.peakL);
  const targR = Math.min(1, m.peakR);
  vuCurL += (targL - vuCurL) * (targL > vuCurL ? 0.55 : 0.15);
  vuCurR += (targR - vuCurR) * (targR > vuCurR ? 0.55 : 0.15);
  vuGr    += (m.gr   - vuGr)    * (m.gr   > vuGr    ? 0.55 : 0.15);
}
function startMeterPolling() {
  if (vuPoll) return;
  vuPoll = setInterval(meterTick, 33);   // ~30 fps
}

function wireControls() {
  const btnPlay = $('#btnPlay');
  let playing = false;
  btnPlay.addEventListener('click', () => {
    playing = !playing;
    btnPlay.textContent = playing ? 'STOP' : 'PLAY';
    btnPlay.classList.toggle('on', playing);
    setStatus(playing ? 'Playing' : 'Stopped');
    send({ type: 'transport', cmd: playing ? 'play' : 'stop' });
    if (playing) seqStart(); else seqStop();
  });

  const btnRec = $('#btnRec');
  let rec = false;
  btnRec.addEventListener('click', () => {
    rec = !rec;
    btnRec.classList.toggle('on', rec);
    setStatus(rec ? 'Recording armed' : 'Recording off');
    send({ type: 'record', on: rec });
  });

  $('#btnStopAll').addEventListener('click', () => {
    setStatus('Panic — all voices stopped');
    send({ type: 'panic' });
  });

  // BPM changes also route through applyBpm so the running sequencer
  // interval + native engine track the value live, not just the visible field.
  const bpmEl = $('#bpm');
  bpmEl.addEventListener('change', (e) => applyBpm(parseFloat(e.target.value)));
  bpmEl.addEventListener('input',  (e) => applyBpm(parseFloat(e.target.value)));
  $('#swing').addEventListener('input', (e) => {
    $('#swingVal').textContent = `${e.target.value}%`;
    send({ type: 'setSwing', value: +e.target.value });
  });
  $('#vel').addEventListener('input', (e) => {
    $('#velVal').textContent = e.target.value;
  });

  $('#btnTrigger').addEventListener('click', (e) => {
    e.preventDefault();
    triggerPad(0);
  });

  // QWERTY → pad map (same as KB_MAP in kit/Pad.hpp).
  const KEY_MAP = { '1':0,'2':1,'3':2,'4':3, 'q':4,'w':5,'e':6,'r':7,
                    'a':8,'s':9,'d':10,'f':11 /* z-v map to pads 12+ which aren't on TR-8S */ };
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === ' ') { e.preventDefault(); btnPlay.click(); return; }
    const i = KEY_MAP[e.key.toLowerCase()];
    if (i != null && i < TR8S.length) triggerPad(i);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));
}

// ── JS-side sequencer ─────────────────────────────────────────────────────────
// Real sample-accurate scheduling lives on the C++ audio thread later. For now
// a setInterval-based sequencer fires padPress messages at 16th-note
// boundaries, using the TR-8S grid pattern for who plays when.
let seqTimer = null;
let seqStep  = 0;
let seqBpm   = 164;

function stepMs() { return 60000 / seqBpm / 4; }   // 16th note

// Single source of truth for BPM changes — updates the JS state, the visible
// input, restarts the interval if the sequencer is running, and pushes the
// value into the native engine. Used by the BPM input handlers AND by
// loadExternalKit so a kit's stored tempo takes effect immediately.
function applyBpm(v) {
  const bpm = Math.max(20, Math.min(300, parseFloat(v) || 120));
  seqBpm = bpm;
  const el = document.querySelector('#bpm');
  if (el && parseFloat(el.value) !== bpm) el.value = bpm.toFixed(1);
  if (seqTimer) {
    clearInterval(seqTimer);
    seqTimer = setInterval(seqTick, stepMs());
  }
  send({ type: 'setBpm', bpm });
}

function seqStart() {
  seqStop();
  seqStep = 0;
  // If chain is engaged and has entries, start on the first chain slot.
  if (chainOn && chain.length) {
    chainSlotIdx = 0;
    currentPatternIdx = -1;
    selectPattern(chain[0]);
    renderChain();
  }
  seqTimer = setInterval(seqTick, stepMs());
}
function seqStop() {
  if (seqTimer) { clearInterval(seqTimer); seqTimer = null; }
  // Clear the playhead highlight everywhere.
  document.querySelectorAll('.playhead').forEach(el => el.classList.remove('playhead'));
  document.querySelectorAll('.pad.playing').forEach(el => el.classList.remove('playing'));
}
function seqTick() {
  const s = seqStep;
  // Fire every pad that's active on this step.
  for (let p = 0; p < gridPattern.length; ++p) {
    if (gridPattern[p][s]) {
      send({ type: 'padPress', pad: p, vel: 1.0 });
      const pad = document.querySelector(`.pad[data-i="${p}"]`);
      if (pad) {
        pad.classList.add('hit');
        setTimeout(() => pad.classList.remove('hit'), 90);
      }
    }
  }
  // Motion strip lane also fires (selected pad in the motion dropdown).
  if (motionVel[s] > 0) {
    const p = +($('#motionPad')?.value ?? 0);
    send({ type: 'padPress', pad: p, vel: motionVel[s] / 127 });
  }
  // Playhead highlight.
  document.querySelectorAll('.playhead').forEach(el => el.classList.remove('playhead'));
  const stepEl = document.querySelector(`.motion-strip .step[data-i="${s}"]`);
  if (stepEl) stepEl.classList.add('playhead');
  document.querySelectorAll(`.tr8s-grid .cell[data-s="${s}"]`)
    .forEach(el => el.classList.add('playhead'));

  // Advance step. On bar boundary (wrap to 0) — if chain is ON and non-empty,
  // step to the next chain slot and swap the live pattern arrays.
  seqStep = (s + 1) % 16;
  if (seqStep === 0 && chainOn && chain.length > 0) {
    chainSlotIdx = (chainSlotIdx + 1) % chain.length;
    const pi = chain[chainSlotIdx];
    // Rebind + rebuild views. selectPattern is a no-op if pi === current, so
    // force it.
    currentPatternIdx = -1;
    selectPattern(pi);
    renderChain();
  }
}

// ── Settings modal ────────────────────────────────────────────────────────────
function wireSampleButtons() {
  const load    = document.querySelector('#btnLoadSample');
  const browse  = document.querySelector('#btnBrowseSample');
  const clr     = document.querySelector('#btnClearSample');
  if (load) load.addEventListener('click', () => {
    send({ type: 'loadSampleForPad', pad: window.__selectedPad ?? 0 });
  });
  if (browse) browse.addEventListener('click', () => openSampleBrowser());
  if (clr) clr.addEventListener('click', () => {
    send({ type: 'clearSampleForPad', pad: window.__selectedPad ?? 0 });
  });

  // Wave-manipulation buttons — non-destructive, snapshotted on next trigger.
  const rev  = document.querySelector('#btnReverse');
  const norm = document.querySelector('#btnNormalize');
  const prev = document.querySelector('#btnPreview');
  const rst  = document.querySelector('#btnResetSample');
  if (rev)  rev.addEventListener('click', () => {
    const p = window.__selectedPad ?? 0;
    padState[p].reverse = !padState[p].reverse;
    rev.classList.toggle('pill-active', padState[p].reverse);
    send({ type: 'setPadReverse', pad: p, on: padState[p].reverse ? 'true' : 'false' });
    drawWave();
  });
  if (norm) norm.addEventListener('click', () => {
    const p = window.__selectedPad ?? 0;
    padState[p].normalize = !padState[p].normalize;
    norm.classList.toggle('pill-active', padState[p].normalize);
    send({ type: 'setPadNormalize', pad: p, on: padState[p].normalize ? 'true' : 'false' });
  });
  if (prev) prev.addEventListener('click', () => triggerPad(window.__selectedPad ?? 0));
  if (rst)  rst.addEventListener('click', () => {
    const p = window.__selectedPad ?? 0;
    padState[p].reverse = false;
    padState[p].normalize = false;
    padState[p].pitchSemis = 0;
    padState[p].decaySec = 4.0;
    padState[p].gain = 1.0;
    if (rev)  rev.classList.remove('pill-active');
    if (norm) norm.classList.remove('pill-active');
    send({ type: 'setPadReverse',   pad: p, on: 'false' });
    send({ type: 'setPadNormalize', pad: p, on: 'false' });
    send({ type: 'setPadPitch',     pad: p, semis:   0 });
    send({ type: 'setPadDecay',     pad: p, seconds: 4.0 });
    send({ type: 'setPadGain',      pad: p, gain:    1.0 });
    refreshPadDetail(p);
    drawWave();
  });

  // Plugins scanner
  const pscan = document.querySelector('#btnPluginScan');
  if (pscan) pscan.addEventListener('click', () => send({ type: 'listPlugins' }));

  // Pad shape sliders — live sync to C++.
  const pitch = document.querySelector('#padPitch');
  const decay = document.querySelector('#padDecay');
  const gain  = document.querySelector('#padGain');
  if (pitch) pitch.addEventListener('input', (e) => {
    const pad = window.__selectedPad ?? 0;
    padState[pad].pitchSemis = +e.target.value;
    document.querySelector('#padPitchVal').textContent =
      `${padState[pad].pitchSemis > 0 ? '+' : ''}${padState[pad].pitchSemis}st`;
    send({ type: 'setPadPitch', pad, semis: padState[pad].pitchSemis });
  });
  if (decay) decay.addEventListener('input', (e) => {
    const pad = window.__selectedPad ?? 0;
    padState[pad].decaySec = +e.target.value;
    document.querySelector('#padDecayVal').textContent = padState[pad].decaySec.toFixed(2) + 's';
    send({ type: 'setPadDecay', pad, seconds: padState[pad].decaySec });
  });
  if (gain) gain.addEventListener('input', (e) => {
    const pad = window.__selectedPad ?? 0;
    padState[pad].gain = +e.target.value;
    document.querySelector('#padGainVal').textContent = padState[pad].gain.toFixed(2);
    send({ type: 'setPadGain', pad, gain: padState[pad].gain });
  });

  // Choke chips
  document.querySelectorAll('.choke-cells .chip').forEach((chip, i) => {
    chip.addEventListener('click', () => {
      const pad = window.__selectedPad ?? 0;
      padState[pad].choke = i;
      refreshPadDetail(pad);
      send({ type: 'setPadChoke', pad, group: i });
    });
  });
}

// ── Sample browser (folder walk driven by C++) ────────────────────────────────
let browserAllItems = [];
function openSampleBrowser() {
  const modal = document.querySelector('#browserModal'); if (!modal) return;
  const pad = window.__selectedPad ?? 0;
  document.querySelector('#browserPad').textContent = `→ Pad ${pad + 1} (${TR8S[pad].slot})`;
  modal.hidden = false;
  const root = localStorage.getItem('kitstation.sampleRoot') || '';
  if (root) {
    document.querySelector('#browserRoot').value = root;
    send({ type: 'listSamples', root });
  }
}
function onSampleRootPicked(msg) {
  if (!msg.path) return;
  localStorage.setItem('kitstation.sampleRoot', msg.path);
  document.querySelector('#browserRoot').value = msg.path;
  send({ type: 'listSamples', root: msg.path });
}
function onSampleList(msg) {
  browserAllItems = msg.list || [];
  renderSampleList(browserAllItems);
}
function renderSampleList(items) {
  const ul = document.querySelector('#sampleList');
  ul.innerHTML = items.map(s =>
    `<li data-p="${escapeAttr(s.path)}"><b>${escapeHtml(s.name)}</b>
      <span class="path">${escapeHtml(s.path.replace(/^.{0,40}[\\/]/, '…'))}</span></li>`
  ).join('');
  ul.querySelectorAll('li').forEach(li => {
    li.addEventListener('dblclick', () => {
      const pad = window.__selectedPad ?? 0;
      send({ type: 'assignSample', pad, path: li.dataset.p });
      document.querySelector('#browserModal').hidden = true;
    });
  });
}
function wireBrowser() {
  const close = () => document.querySelector('#browserModal').hidden = true;
  document.querySelector('#browserClose').addEventListener('click', close);
  document.querySelector('#browserPick').addEventListener('click', () =>
    send({ type: 'pickSampleRoot' }));
  document.querySelector('#browserRefresh').addEventListener('click', () => {
    const root = document.querySelector('#browserRoot').value;
    if (root) send({ type: 'listSamples', root });
  });
  document.querySelector('#browserFilter').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    renderSampleList(q ? browserAllItems.filter(s => s.name.toLowerCase().includes(q))
                       : browserAllItems);
  });
}

// ── Kit save / load ───────────────────────────────────────────────────────────
function currentKitJson() {
  return {
    name: (document.querySelector('#kitName')?.value || 'Untitled').trim(),
    pads: padState.map((p, i) => ({
      slot: TR8S[i].slot, label: TR8S[i].label,
      sample: p.sample, pitchSemis: p.pitchSemis, decaySec: p.decaySec,
      gain: p.gain, choke: p.choke, color: TR8S[i].color,
    })),
    patterns: patterns.map(pt => ({
      motionVel: pt.motionVel, gridPattern: pt.gridPattern,
    })),
    bpm: seqBpm,
  };
}
function saveCurrentKit() {
  const kit = currentKitJson();
  send({ type: 'saveKit', name: kit.name, body: JSON.stringify(kit) });
}
function openKitPicker() {
  document.querySelector('#kitsModal').hidden = false;
  send({ type: 'listKits' });
}
function onKitList(msg) {
  const ul = document.querySelector('#kitsPickerList');
  const list = msg.list || [];
  ul.innerHTML = list.length
    ? list.map(n => `<li data-n="${escapeAttr(n)}">${escapeHtml(n)}</li>`).join('')
    : '<li class="muted-sm">No kits saved yet.</li>';
  ul.querySelectorAll('li[data-n]').forEach(li => {
    li.addEventListener('click', () => {
      send({ type: 'loadKit', name: li.dataset.n });
      document.querySelector('#kitsModal').hidden = true;
    });
  });
}
function onKitLoaded(msg) {
  // C++ sends `body` as either a parsed object (if it re-serialised) or as a
  // raw string. Accept both — parse if needed.
  let kit = msg.body;
  if (typeof kit === 'string') {
    if (!kit.trim()) { setStatus(`Kit "${msg.name}" is empty on disk`); return; }
    try { kit = JSON.parse(kit); }
    catch (e) { setStatus(`Kit "${msg.name}" has invalid JSON`); console.error(e); return; }
  }
  if (!kit || typeof kit !== 'object') return;
  if (kit.name && document.querySelector('#kitName')) document.querySelector('#kitName').value = kit.name;
  if (Array.isArray(kit.pads)) {
    kit.pads.forEach((p, i) => {
      if (i >= padState.length) return;
      padState[i].sample     = p.sample     || '';
      padState[i].pitchSemis = p.pitchSemis ?? 0;
      padState[i].decaySec   = p.decaySec   ?? 4;
      padState[i].gain       = p.gain       ?? 1;
      padState[i].choke      = p.choke      ?? 0;
      // Push into C++ engine.
      if (p.sample) send({ type: 'assignSample', pad: i, path: p.sample });
      send({ type: 'setPadPitch', pad: i, semis:   padState[i].pitchSemis });
      send({ type: 'setPadDecay', pad: i, seconds: padState[i].decaySec });
      send({ type: 'setPadGain',  pad: i, gain:    padState[i].gain });
      send({ type: 'setPadChoke', pad: i, group:   padState[i].choke });
      const el = document.querySelector(`.pad[data-i="${i}"]`);
      if (el) el.classList.toggle('loaded', !!p.sample);
    });
  }
  if (Array.isArray(kit.patterns)) {
    kit.patterns.forEach((pt, i) => {
      if (i >= patterns.length) return;
      if (pt.motionVel)   patterns[i].motionVel   = pt.motionVel.slice();
      if (pt.gridPattern) patterns[i].gridPattern = pt.gridPattern.map(r => r.slice());
    });
    // Repaint from currently-selected pattern.
    selectPattern(0);
  }
  if (kit.bpm) {
    seqBpm = +kit.bpm;
    const bpmEl = document.querySelector('#bpm'); if (bpmEl) bpmEl.value = seqBpm;
  }
  refreshPadDetail(window.__selectedPad ?? 0);
  setStatus(`Kit loaded: ${kit.name || '(unnamed)'}`);
}
function wireKitButtons() {
  document.querySelector('#btnSaveKit').addEventListener('click', saveCurrentKit);
  document.querySelector('#btnLoadKit').addEventListener('click', openKitPicker);
  document.querySelector('#kitsClose').addEventListener('click', () =>
    document.querySelector('#kitsModal').hidden = true);
}

function wireSettings() {
  const modal = $('#settingsModal');
  const refresh = () => {
    send({ type: 'listAudioDevices' });
    send({ type: 'listMidiInputs' });
    send({ type: 'listMidiOutputs' });
  };
  const open  = () => { modal.hidden = false; refresh(); };
  const close = () => { modal.hidden = true; };
  $('#btnSettings').addEventListener('click', open);
  $('#settingsClose').addEventListener('click', close);
  $('#settingsDone').addEventListener('click', close);
  $('#settingsRefresh').addEventListener('click', refresh);
  $('#audioDeviceSel').addEventListener('change', (e) => {
    const id = e.target.value;
    send({ type: 'selectAudioDevice', id });
    setStatus('Audio device changed');
  });
  $('#midiInputSel').addEventListener('change', (e) => {
    const idx = +e.target.value;
    send({ type: 'selectMidiInput', index: idx });
    setStatus(idx < 0 ? 'MIDI input closed' : 'MIDI input opened');
  });
  const outSel = $('#midiOutputSel');
  if (outSel) outSel.addEventListener('change', (e) => {
    const idx = +e.target.value;
    virusOutIdx = idx;
    const name = virusOutputs.find(o => o.index === idx)?.name || '';
    virusOutName = name;
    send({ type: 'selectMidiOutput', index: idx });
    refreshVirusLcd();
    setStatus(idx < 0 ? 'MIDI out closed' : `MIDI out → ${name || 'device ' + idx}`);
    scheduleVirusAutoSave();
  });
}
function populateAudioDevices(msg) {
  const sel = $('#audioDeviceSel'); if (!sel) return;
  sel.innerHTML = (msg.list || []).map(d => {
    const tag = d.kind === 'asio' ? ' [ASIO]' : (d.default ? ' (default)' : '');
    const disabled = d.available === false ? ' disabled' : '';
    return `<option value="${escapeAttr(d.id)}"${d.id === msg.current ? ' selected' : ''}${disabled}>${escapeHtml(d.name)}${tag}</option>`;
  }).join('');
}
// ── External MIDI rack (Access rack panel) ────────────────────────────────
// State
let virusOutputs   = [];
let virusOutIdx    = -1;                 // WinMM device index (-1 = closed)
let virusChannel   = 0;                  // 0..15 — used ONLY by the rack CC knobs
let virusOn        = true;               // master enable
let virusPcOnPtn   = false;              // (retired — PC lives on each clip pad now)
// Knob values by CC number. Populated once wireVirusRack() runs so save/load
// can round-trip them without touching each closure. Default 64 = centre.
const virusKnobVals = { 74: 64, 71: 64, 73: 64, 75: 64, 91: 64, 93: 64, 7: 64, 1: 64 };
// Last-known output name (survives across sessions since WinMM indices don't).
let virusOutName   = '';
let virusPresets   = [];                 // list of saved preset names
let virusAutoSaveTimer = null;

// ── Song bank ────────────────────────────────────────────────────────────
// 16 songs × 8 MIDI-clip pads. Each pad has its own channel + program +
// clip. Selecting a song from the dropdown reveals its 8 pads. Click a pad
// to fire — sends its Program Change then plays its clip (or a single note
// if no clip is loaded) on the pad's own channel.
const SONG_COUNT    = 16;
const CLIPS_PER_SONG = 8;
const songs = Array.from({ length: SONG_COUNT }, (_, s) => ({
  name: `${String(s + 1).padStart(2, '0')} · Song ${s + 1}`,
  pads: Array.from({ length: CLIPS_PER_SONG }, (_, i) => ({
    name: `Pad ${i + 1}`,
    channel: 0,          // 0..15 (displayed as 1..16)
    program: 0,          // 0..127
    clipName: '',
    clipEvents: null,    // populated on .mid drop / load
    armed: true,         // if false, clicking the pad does nothing
  })),
}));
let currentSong = 0;

function populateMidiOutputs(msg) {
  virusOutputs = msg.list || [];
  // Adopt whatever the engine reports as active — the modal and the OUT
  // encoder each mutate virusOutIdx; the engine broadcasts the name it
  // currently has open, so re-resolve to an index here.
  if (msg.current) {
    const found = virusOutputs.find(o => o.name === msg.current);
    if (found) { virusOutIdx = found.index; virusOutName = found.name; }
  }
  // If we restored a saved name that isn't plugged in yet, keep the string
  // around anyway so the next boot with that device attached auto-connects.
  // Fill the settings modal dropdown too — the OUT encoder still works, but
  // a proper list is much friendlier when you have several devices.
  const sel = document.querySelector('#midiOutputSel');
  if (sel) {
    sel.innerHTML = '<option value="-1">(none)</option>' +
      virusOutputs.map(d =>
        `<option value="${d.index}"${d.index === virusOutIdx ? ' selected' : ''}>${escapeHtml(d.name)}</option>`).join('');
  }
  refreshVirusLcd();
  // Keep the OUT encoder dial in sync too.
  const outKnob = document.querySelector('#virusOutKnob .vencoder-dial');
  if (outKnob && virusOutputs.length) {
    const n = virusOutputs.length;
    const v = virusOutIdx < 0 ? 0 : (virusOutputs.findIndex(o => o.index === virusOutIdx) + 1) / (n + 1);
    outKnob.style.setProperty('--rot', knobToDeg(v) + 'deg');
  }
}
function refreshVirusLcd() {
  const l1 = document.querySelector('#rlcd1');
  const l2 = document.querySelector('#rlcd2');
  if (!l1 || !l2) return;
  const song = songs[currentSong];
  const songNo = String(currentSong + 1).padStart(2, '0');
  l1.textContent = `${songNo} ${song.name.substring(0, 12).padEnd(12)}`;
  const name = virusOutputs.find(o => o.index === virusOutIdx)?.name || 'no output';
  l2.textContent = (virusOn ? '' : 'MUTED · ') + name.substring(0, 24);
}

function knobToDeg(v01) {
  // -135° (min) → +135° (max) — 270° travel like a real pot.
  return -135 + v01 * 270;
}

function wireVirusRack() {
  // OUT encoder — click cycles through available outputs; drag also cycles.
  const outKnob = document.querySelector('#virusOutKnob');
  const chKnob  = document.querySelector('#virusChKnob');
  const paintOut = () => {
    const n = Math.max(1, virusOutputs.length);
    const v = virusOutIdx < 0 ? 0 : (virusOutputs.findIndex(o => o.index === virusOutIdx) + 1) / (n + 1);
    outKnob.querySelector('.vencoder-dial').style.setProperty('--rot', knobToDeg(v) + 'deg');
  };
  const paintCh = () => {
    chKnob.querySelector('.vencoder-dial').style.setProperty('--rot', knobToDeg(virusChannel / 15) + 'deg');
  };
  const cycleOut = (dir) => {
    if (virusOutputs.length === 0) { send({ type: 'listMidiOutputs' }); return; }
    const cur = virusOutputs.findIndex(o => o.index === virusOutIdx);
    let next = cur + dir;
    if (next < -1) next = virusOutputs.length - 1;
    if (next >= virusOutputs.length) next = -1;
    virusOutIdx = next < 0 ? -1 : virusOutputs[next].index;
    virusOutName = next < 0 ? '' : virusOutputs[next].name;
    send({ type: 'selectMidiOutput', index: virusOutIdx });
    refreshVirusLcd();
    paintOut();
    setStatus(virusOutIdx < 0 ? 'MIDI out closed' : `MIDI out → ${virusOutputs[next].name}`);
    scheduleVirusAutoSave();
  };
  outKnob.addEventListener('click', () => cycleOut(+1));
  outKnob.addEventListener('wheel', (e) => { e.preventDefault(); cycleOut(e.deltaY < 0 ? +1 : -1); }, { passive: false });
  makeDraggable(outKnob, {
    min: 0, max: Math.max(1, virusOutputs.length), pixelsPerFull: 60,
    get: () => 0,
    set: (v) => { /* no-op — cycleOut handles the state */ },
    onCommit: () => {},
  });

  chKnob.addEventListener('wheel', (e) => {
    e.preventDefault();
    virusChannel = (virusChannel + (e.deltaY < 0 ? 1 : 15)) % 16;
    paintCh();
    refreshVirusLcd();
    scheduleVirusAutoSave();
  }, { passive: false });
  makeDraggable(chKnob, {
    min: 0, max: 15, pixelsPerFull: 240,
    get: () => virusChannel,
    set: (v) => { virusChannel = Math.round(v); paintCh(); refreshVirusLcd(); scheduleVirusAutoSave(); },
    onCommit: () => {},
  });
  paintOut(); paintCh();

  // Big parameter knobs — each has a data-cc attribute. Values live in the
  // shared virusKnobVals map so save/restore can read and write them directly.
  document.querySelectorAll('.vknob').forEach((el) => {
    const cc  = +el.dataset.cc;
    const lbl = el.dataset.lbl;
    if (!(cc in virusKnobVals)) virusKnobVals[cc] = 64;
    const dial = el.querySelector('.vknob-dial');
    const paint = () => { dial.style.setProperty('--rot', knobToDeg(virusKnobVals[cc] / 127) + 'deg'); };
    el._paintKnob = paint;                            // let restore repaint later
    paint();
    makeDraggable(el, {
      min: 0, max: 127, pixelsPerFull: 140,
      get: () => virusKnobVals[cc],
      set: (v) => {
        virusKnobVals[cc] = Math.max(0, Math.min(127, v)); paint();
        // Live CC out on drag.
        if (virusOn) send({ type: 'midiOutCC', channel: virusChannel, cc, value: Math.round(virusKnobVals[cc]) });
        const l2 = document.querySelector('#rlcd2');
        if (l2) l2.textContent = `${lbl.padEnd(6)} CC${cc}=${Math.round(virusKnobVals[cc]).toString().padStart(3, '0')}`;
        scheduleVirusAutoSave();
      },
      onCommit: () => {},
    });
  });

  // Rack buttons
  document.querySelector('#virusOnBtn').addEventListener('click', function() {
    virusOn = !virusOn; this.classList.toggle('on', virusOn); refreshVirusLcd();
    scheduleVirusAutoSave();
  });
  document.querySelector('#virusEdit').addEventListener('click', function() {
    virusPcOnPtn = !virusPcOnPtn; this.classList.toggle('on', virusPcOnPtn);
    setStatus(`Program Change on pattern change: ${virusPcOnPtn ? 'ON' : 'off'}`);
    scheduleVirusAutoSave();
  });
  document.querySelector('#virusMute').addEventListener('click', () => {
    send({ type: 'midiOutPanic' });
    setStatus('MIDI panic — all-notes-off on every channel');
  });
  // STORE — save the current rack state as a named preset (recall via the
  // adjacent dropdown). The current state is also auto-saved on every edit,
  // so this only exists to snapshot named versions you can jump back to.
  document.querySelector('#virusStore').addEventListener('click', () => {
    const name = prompt('Save Virus preset as…', suggestNextPresetName());
    if (!name) return;
    send({ type: 'virusPresetSave', name, body: JSON.stringify(virusSnapshot()) });
  });
  wireVirusPresetPicker();
  document.querySelector('#virusEdit').classList.toggle('on', virusPcOnPtn);

  buildSongBank();
  refreshVirusLcd();
  // Ask the engine for our most recent snapshot + the list of named presets.
  send({ type: 'virusLoad' });
  send({ type: 'virusPresetList' });
}

// ── Virus state persistence ──────────────────────────────────────────────
// One coherent snapshot object for both the auto-save file and named presets.
function virusSnapshot() {
  return {
    v: 1,
    outName:  virusOutName,               // device name, not index
    channel:  virusChannel,
    on:       virusOn,
    pcOnPtn:  virusPcOnPtn,
    knobs:    { ...virusKnobVals },
    currentSong,
    songs:    songs,                      // includes per-pad channel/program/clip
  };
}

function virusRestore(state) {
  if (!state || typeof state !== 'object') return;
  if (state.outName)   virusOutName = state.outName;
  if (Number.isInteger(state.channel)) virusChannel = state.channel;
  if (typeof state.on      === 'boolean') virusOn      = state.on;
  if (typeof state.pcOnPtn === 'boolean') virusPcOnPtn = state.pcOnPtn;
  if (state.knobs) Object.assign(virusKnobVals, state.knobs);
  if (Array.isArray(state.songs) && state.songs.length === songs.length) {
    for (let s = 0; s < songs.length; s++) {
      const src = state.songs[s]; if (!src) continue;
      if (typeof src.name === 'string') songs[s].name = src.name;
      if (Array.isArray(src.pads)) {
        for (let p = 0; p < songs[s].pads.length; p++) {
          const sp = src.pads[p]; if (!sp) continue;
          Object.assign(songs[s].pads[p], {
            name:       sp.name       ?? songs[s].pads[p].name,
            channel:    sp.channel    ?? songs[s].pads[p].channel,
            program:    sp.program    ?? songs[s].pads[p].program,
            clipName:   sp.clipName   ?? '',
            clipEvents: sp.clipEvents ?? null,
            armed:      sp.armed      ?? true,
          });
        }
      }
    }
  }
  if (Number.isInteger(state.currentSong) && state.currentSong >= 0 && state.currentSong < songs.length) {
    currentSong = state.currentSong;
  }
  // Repaint everything the UI cares about.
  document.querySelectorAll('.vknob').forEach((el) => { if (el._paintKnob) el._paintKnob(); });
  const chDial = document.querySelector('#virusChKnob .vencoder-dial');
  if (chDial) chDial.style.setProperty('--rot', knobToDeg(virusChannel / 15) + 'deg');
  document.querySelector('#virusOnBtn')?.classList.toggle('on', virusOn);
  document.querySelector('#virusEdit')?.classList.toggle('on', virusPcOnPtn);
  const songSel = document.querySelector('#songSelect');
  if (songSel) songSel.value = String(currentSong);
  const songName = document.querySelector('#songName');
  if (songName) songName.value = songs[currentSong].name;
  renderClipPads();
  // If the previously-saved output is still plugged in, reopen it. Otherwise
  // the modal / OUT encoder just stays at "no output" until the user picks.
  if (virusOutName && virusOutputs.length) {
    const match = virusOutputs.find(o => o.name === virusOutName);
    if (match) {
      virusOutIdx = match.index;
      send({ type: 'selectMidiOutput', index: virusOutIdx });
    }
  }
  refreshVirusLcd();
}

// Debounced — every knob wiggle would otherwise write the file dozens of times.
function scheduleVirusAutoSave() {
  clearTimeout(virusAutoSaveTimer);
  virusAutoSaveTimer = setTimeout(() => {
    send({ type: 'virusSave', body: JSON.stringify(virusSnapshot()) });
  }, 400);
}

function onVirusLoaded(m) {
  if (m.body) virusRestore(m.body);
}
function onVirusPresetLoaded(m) {
  if (!m.body) { setStatus(`Preset "${m.name}" was empty`); return; }
  virusRestore(m.body);
  scheduleVirusAutoSave();
  setStatus(`Loaded Virus preset: ${m.name}`);
}
function onVirusPresetSaved(m) {
  setStatus(`Saved Virus preset: ${m.name}`);
  send({ type: 'virusPresetList' });          // refresh the recall dropdown
}
function onVirusPresetDeleted(m) {
  setStatus(`Deleted Virus preset: ${m.name}`);
  send({ type: 'virusPresetList' });
}
function onVirusPresetList(m) {
  virusPresets = m.list || [];
  const sel = document.querySelector('#virusPresetSel');
  if (!sel) return;
  sel.innerHTML = '<option value="">— recall preset —</option>' +
    virusPresets.map(n => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join('');
}
function suggestNextPresetName() {
  const base = 'Preset ';
  let n = 1;
  const taken = new Set(virusPresets);
  while (taken.has(base + n)) n++;
  return base + n;
}
function wireVirusPresetPicker() {
  const sel = document.querySelector('#virusPresetSel');
  const del = document.querySelector('#virusPresetDel');
  if (sel) sel.addEventListener('change', (e) => {
    const name = e.target.value;
    if (!name) return;
    send({ type: 'virusPresetLoad', name });
    e.target.value = '';                       // reset so re-picking the same fires again
  });
  if (del) del.addEventListener('click', () => {
    const name = prompt('Delete which Virus preset? (exact name)');
    if (!name) return;
    send({ type: 'virusPresetDelete', name });
  });
}

// ── Song bank + clip pads ────────────────────────────────────────────────
function buildSongBank() {
  const sel = document.querySelector('#songSelect');
  if (sel) {
    sel.innerHTML = songs.map((s, i) =>
      `<option value="${i}"${i === currentSong ? ' selected' : ''}>${escapeHtml(s.name)}</option>`
    ).join('');
    sel.onchange = (e) => {
      currentSong = +e.target.value;
      renderClipPads();
      refreshSongNameField();
      refreshVirusLcd();
      scheduleVirusAutoSave();
    };
  }
  refreshSongNameField();
  const nameField = document.querySelector('#songName');
  if (nameField) nameField.oninput = (e) => {
    songs[currentSong].name = e.target.value || `${String(currentSong + 1).padStart(2, '0')} · Song ${currentSong + 1}`;
    // Update the dropdown option text without rebuilding the whole select.
    const opt = document.querySelector(`#songSelect option[value="${currentSong}"]`);
    if (opt) opt.textContent = songs[currentSong].name;
    refreshVirusLcd();
    scheduleVirusAutoSave();
  };
  renderClipPads();
}
function refreshSongNameField() {
  const f = document.querySelector('#songName');
  if (f) f.value = songs[currentSong].name;
}
function renderClipPads() {
  const wrap = document.querySelector('#songClips'); if (!wrap) return;
  const song = songs[currentSong];
  wrap.innerHTML = song.pads.map((p, i) => `
    <div class="clip-pad ${p.armed ? '' : 'muted'} ${p.clipEvents ? 'hasClip' : ''}"
         data-i="${i}" title="Click to fire · drag a .mid file to load">
      <div class="cp-head">
        <input class="cp-name" data-i="${i}" value="${escapeAttr(p.name)}" />
        <button class="cp-arm ${p.armed ? 'on' : ''}" data-i="${i}" title="Arm / mute this pad"></button>
      </div>
      <div class="cp-mididata">
        <label><span>CH</span><input type="number" min="1" max="16"  value="${p.channel + 1}" data-i="${i}" data-k="channel" /></label>
        <label><span>PGM</span><input type="number" min="0" max="127" value="${p.program}" data-i="${i}" data-k="program" /></label>
      </div>
      <div class="cp-clip">
        <span class="cp-clipname">${escapeHtml(p.clipName || '— no clip —')}</span>
        <button data-a="load" data-i="${i}" title="Load .mid file">↳ MID</button>
      </div>
    </div>`).join('');

  // Fire pad on click of the body (anywhere except the input/buttons).
  wrap.querySelectorAll('.clip-pad').forEach(el => {
    el.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      const i = +el.dataset.i;
      fireClipPad(i);
    });
    // Drag-drop .mid files onto the pad body.
    el.addEventListener('dragover',  (e) => { e.preventDefault(); el.classList.add('dragover'); });
    el.addEventListener('dragleave', ()  =>   el.classList.remove('dragover'));
    el.addEventListener('drop',      async (e) => {
      e.preventDefault(); el.classList.remove('dragover');
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      await loadClipPad(+el.dataset.i, f);
    });
  });

  // Name field
  wrap.querySelectorAll('.cp-name').forEach(el => {
    el.addEventListener('input', (e) => {
      songs[currentSong].pads[+e.target.dataset.i].name = e.target.value;
      scheduleVirusAutoSave();
    });
    el.addEventListener('mousedown', (e) => e.stopPropagation());
  });
  // Ch / Pgm number fields
  wrap.querySelectorAll('.cp-mididata input').forEach(el => {
    el.addEventListener('input', (e) => {
      const i = +e.target.dataset.i;
      const k = e.target.dataset.k;
      const v = Math.max(0, Math.min(k === 'channel' ? 16 : 127, +e.target.value || 0));
      songs[currentSong].pads[i][k] = (k === 'channel') ? Math.max(0, v - 1) : v;
      scheduleVirusAutoSave();
    });
    el.addEventListener('mousedown', (e) => e.stopPropagation());
  });
  // Arm toggle
  wrap.querySelectorAll('.cp-arm').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = +el.dataset.i;
      const pad = songs[currentSong].pads[i];
      pad.armed = !pad.armed;
      el.classList.toggle('on', pad.armed);
      el.closest('.clip-pad').classList.toggle('muted', !pad.armed);
      scheduleVirusAutoSave();
    });
  });
  // Load button
  wrap.querySelectorAll('button[data-a="load"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = +el.dataset.i;
      pickClipFor(i);
    });
  });
}

// Fire a clip pad: PC first (so the Virus swaps patch), then note events.
function fireClipPad(padIdx) {
  const pad = songs[currentSong].pads[padIdx];
  if (!pad || !pad.armed) return;
  if (!virusOn || virusOutIdx < 0) { setStatus('MIDI out not connected'); return; }

  // Program Change so the external synth loads the right patch.
  send({ type: 'midiOutPC', channel: pad.channel, program: pad.program });

  // Update the LCD to show what's playing.
  const l1 = document.querySelector('#rlcd1');
  const l2 = document.querySelector('#rlcd2');
  if (l1) l1.textContent = `CH ${String(pad.channel + 1).padStart(2, '0')} · PGM ${String(pad.program).padStart(3, '0')}`;
  if (l2) l2.textContent = pad.name.substring(0, 24);

  // Visual flash on the pad.
  const el = document.querySelector(`.clip-pad[data-i="${padIdx}"]`);
  if (el) { el.classList.add('firing'); setTimeout(() => el.classList.remove('firing'), 180); }

  if (pad.clipEvents && pad.clipEvents.length) {
    // Full clip playback — schedule each event on the pad's channel.
    for (const ev of pad.clipEvents) {
      setTimeout(() => {
        if (ev.off) send({ type: 'midiOutNoteOff', channel: pad.channel, note: ev.note });
        else        send({ type: 'midiOutNoteOn',  channel: pad.channel, note: ev.note, vel: ev.vel });
      }, ev.time);
    }
    setStatus(`♪ ${pad.name} — ${pad.clipEvents.length} events on CH ${pad.channel + 1}`);
  } else {
    // No clip — single note C3 with 300ms gate. Handy for quick preview.
    send({ type: 'midiOutNoteOn',  channel: pad.channel, note: 60, vel: 100 });
    setTimeout(() => send({ type: 'midiOutNoteOff', channel: pad.channel, note: 60 }), 300);
    setStatus(`♪ ${pad.name} — preview note on CH ${pad.channel + 1}`);
  }
}

// Read a .mid file, parse note-on/off events, save on the current song's pad.
async function loadClipPad(padIdx, file) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const events = parseMidiFile(buf);
    const pad = songs[currentSong].pads[padIdx];
    pad.clipEvents = events;
    pad.clipName   = file.name.replace(/\.midi?$/i, '').substring(0, 20);
    scheduleVirusAutoSave();
    // Repaint just this pad.
    const cell = document.querySelector(`.clip-pad[data-i="${padIdx}"]`);
    if (cell) {
      cell.classList.add('hasClip');
      const nm = cell.querySelector('.cp-clipname');
      if (nm) nm.textContent = pad.clipName;
    }
    setStatus(`Loaded "${pad.clipName}" onto ${pad.name} (${events.length} events)`);
  } catch (err) {
    setStatus(`Failed to parse MIDI: ${err.message}`);
  }
}
function pickClipFor(padIdx) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.mid,.midi';
  inp.onchange = () => { if (inp.files[0]) loadClipPad(padIdx, inp.files[0]); };
  inp.click();
}

// Tiny SMF parser — format 0/1, extracts note-on/off events with real times.
function parseMidiFile(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  const read4 = () => { const v = dv.getUint32(p); p += 4; return v; };
  const read2 = () => { const v = dv.getUint16(p); p += 2; return v; };
  const read1 = () => u8[p++];
  const readVLQ = () => {
    let v = 0, b;
    do { b = read1(); v = (v << 7) | (b & 0x7F); } while (b & 0x80);
    return v;
  };
  if (read4() !== 0x4d546864) throw new Error('not a MIDI file');
  const hdrLen = read4(); const format = read2(); const nTracks = read2();
  const division = read2();
  if (hdrLen > 6) p += hdrLen - 6;
  const ticksPerQ = (division & 0x8000) ? 96 : division;   // fallback if SMPTE

  const merged = [];                        // {tick, type, note, vel}
  let tempoUsPerQ = 500000;                 // default 120 BPM
  for (let t = 0; t < nTracks; t++) {
    if (read4() !== 0x4d54726b) throw new Error('bad track chunk');
    const tlen = read4();
    const end = p + tlen;
    let runStatus = 0, tick = 0;
    while (p < end) {
      tick += readVLQ();
      let status = u8[p];
      if (status < 0x80) { status = runStatus; } else { p++; runStatus = status; }
      const hi = status & 0xF0;
      if (status === 0xFF) {
        const meta = read1(); const len = readVLQ();
        if (meta === 0x51 && len === 3) {
          tempoUsPerQ = (u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2];
        }
        p += len;
      } else if (status === 0xF0 || status === 0xF7) {
        const len = readVLQ(); p += len;
      } else if (hi === 0x80 || hi === 0x90 || hi === 0xA0 ||
                 hi === 0xB0 || hi === 0xE0) {
        const d1 = read1(); const d2 = read1();
        if (hi === 0x90 || hi === 0x80) {
          const off = (hi === 0x80) || d2 === 0;
          merged.push({ tick, off, note: d1, vel: d2 });
        }
      } else if (hi === 0xC0 || hi === 0xD0) {
        p += 1;    // one-byte messages
      }
    }
    if (merged.length) break;   // first track with notes wins for format 0/1
  }
  // Convert ticks → ms using tempo (assumes single tempo — good enough MVP).
  const usPerTick = tempoUsPerQ / ticksPerQ;
  return merged.map(e => ({
    time: (e.tick * usPerTick) / 1000,
    off: e.off, note: e.note, vel: e.vel || 100,
  }));
}

// Retired: the drum pads no longer mirror out to external MIDI. External
// MIDI now lives entirely in the song-bank / clip-pad section below. Kept
// as a no-op so any legacy caller (triggerPad) doesn't error out.
function firePadMidi() { /* no-op */ }

function populateMidiInputs(msg) {
  const sel = $('#midiInputSel'); if (!sel) return;
  const cur = msg.current || '';
  sel.innerHTML = '<option value="-1">(none)</option>' +
    (msg.list || []).map(d =>
      `<option value="${d.index}"${d.name === cur ? ' selected' : ''}>${escapeHtml(d.name)}</option>`).join('');
}
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  buildKits();
  buildPads();
  buildPatternRow();
  buildMotion();
  buildTr8sGrid();
  wireViewToggle();
  wirePadsToggle();
  buildKnobs();
  wireLevelFader();
  buildSwatches();
  drawWave();
  wireControls();
  wireSettings();
  wireSampleButtons();
  wireBrowser();
  wireKitButtons();
  wireChainControls();
  wirePluginChain();
  wireVirusRack();                     // external-MIDI rack module (Virus TI)
  startMeterPolling();
  // Kick an initial plugin scan so the dropdown fills without a click.
  if (nativeHost) {
    // Announce page-ready so C++ can send its deferred audio-init status
    // (posting straight from init() races the page-load and gets dropped).
    send({ type: 'hello' });
    send({ type: 'listPlugins' });
    send({ type: 'listMidiOutputs' });
  }
  if (nativeHost) setStatus('Ready — connected to KitStation native engine');
  loadKitsFromDisk();   // real kits into the left column
});

// tauri-shim.js — polyfill window.chrome.webview against Tauri 2.
//
// Loaded BEFORE kit.js. kit.js runs synchronously and:
//   1. Reads window.KitStation.host to decide if it's native.
//   2. Registers a message handler via
//      window.chrome.webview.addEventListener('message', cb).
//   3. Sends messages via window.chrome.webview.postMessage(obj).
//
// Both of those surfaces must exist by the time kit.js runs. We can't
// wait for Tauri's __TAURI__ injection to finish before installing them,
// so the shim installs a BUFFERED stub synchronously:
//   - postMessage queues onto an outgoing array;
//   - addEventListener records the listener;
//   - once __TAURI__ appears, we upgrade: drain postMessage queue through
//     invoke(), route Rust 'ks-bridge' events into the recorded listener.
//
// Non-goals: no origin filtering, no event-registration tokens. kit.js
// only ever uses the one listener + postMessage pair.

(function () {
  // ─── Synchronous setup — must land before kit.js runs ──────────────────
  window.KitStation = { host: 'native', send: (obj) => window.chrome.webview.postMessage(obj) };

  let outgoing       = [];    // postMessage calls queued before invoke is ready
  let msgListener    = null;  // kit.js's registered 'message' handler
  const earlyEvents  = [];    // events from Rust that arrived pre-listener
  let   invokeReal   = null;  // set once Tauri is live

  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage(obj) {
      if (!obj || !obj.type) return;
      if (invokeReal) sendOne(obj);
      else            outgoing.push(obj);
    },
    addEventListener(evt, cb) {
      if (evt !== 'message') return;
      msgListener = cb;
      while (earlyEvents.length) deliver(earlyEvents.shift());
    },
  };

  const toSnake = (s) => String(s).replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

  function sendOne(obj) {
    const { type, ...rest } = obj;
    invokeReal(toSnake(type), rest).catch((e) =>
      console.warn('[kit-engine] invoke "' + type + '" failed:', e));
  }

  function deliver(payload) {
    if (!msgListener) { earlyEvents.push(payload); return; }
    try { msgListener({ data: payload }); }
    catch (e) { console.error('[kit-engine] handler threw', e); }
  }

  // ─── Asynchronous: wait for Tauri 2's window.__TAURI__ to appear ───────
  function tauriReady(T) {
    const invoke = (T.core && T.core.invoke) ? T.core.invoke.bind(T.core) : T.invoke.bind(T);
    const listen = (T.event && T.event.listen) ? T.event.listen.bind(T.event) : null;
    invokeReal = invoke;

    if (listen) {
      listen('ks-bridge', (ev) => deliver(ev.payload));
    } else {
      console.warn('[kit-engine] no T.event.listen — no bridge events will arrive');
    }

    // Drain anything queued before Tauri was live.
    while (outgoing.length) sendOne(outgoing.shift());

    // Breadcrumb — proves end-to-end we can reach Rust.
    invoke('debug', { msg: 'shim ready, listen=' + !!listen + ', outgoing was ' + outgoing.length })
      .catch((e) => console.warn('[kit-engine] debug invoke failed', e));
  }

  if (window.__TAURI__) {
    tauriReady(window.__TAURI__);
  } else {
    let tries = 0;
    const t = setInterval(() => {
      if (window.__TAURI__) { clearInterval(t); tauriReady(window.__TAURI__); }
      else if (++tries > 100) { clearInterval(t); console.warn('[kit-engine] window.__TAURI__ never appeared'); }
    }, 20);
  }
})();

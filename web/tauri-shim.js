// tauri-shim.js — makes the existing kit.js (written for a WebView2 /
// window.chrome.webview bridge) work unchanged under Tauri.
//
// Loaded BEFORE kit.js in index.html. The shim:
//
//   1. Polyfills window.chrome.webview.postMessage(obj) → tauri invoke.
//      Each outgoing message has a `type` field in camelCase; we convert
//      it to snake_case and invoke the matching #[tauri::command].
//
//   2. Polyfills window.chrome.webview.addEventListener('message', cb)
//      against Tauri's event bus: the Rust side emits "ks-bridge" with
//      the raw object (type field already set), the shim re-dispatches
//      to any registered listener as a {data: obj} event.
//
// Non-goals: this does NOT replicate chrome.webview's event-registration
// token system or its message-origin filtering. The real app only ever
// uses postMessage + a single addEventListener('message') pair, so a
// tiny polyfill covers everything.

(function () {
  const T = window.__TAURI__;
  if (!T) { console.warn('[kit-engine] not running under Tauri — shim idle'); return; }

  // kit.js gates every bridge send on `nativeHost`, which is derived from
  // `window.KitStation.host === 'native'`. The C++ build injected this
  // marker via WebView2's AddScriptToExecuteOnDocumentCreated. We set it
  // here before kit.js runs so the entire bridge path lights up.
  window.KitStation = {
    host: 'native',
    send: (obj) => window.chrome.webview.postMessage(obj),
  };

  const invoke = T.core && T.core.invoke
    ? T.core.invoke.bind(T.core)
    : T.invoke.bind(T);

  const listen  = (T.event && T.event.listen)
    ? T.event.listen.bind(T.event)
    : null;

  function toSnake(s) {
    return String(s).replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  }

  // The web UI uses setStatus to show one line. If we don't have the
  // listener registered yet, we buffer the first few events so nothing
  // from Rust's setup() hook gets lost.
  const earlyBuffer = [];
  let   messageListener = null;

  const dispatch = (obj) => {
    if (messageListener) {
      try { messageListener({ data: obj }); }
      catch (e) { console.error('[kit-engine] message handler threw', e); }
    } else {
      earlyBuffer.push(obj);
    }
  };

  if (listen) {
    listen('ks-bridge', (ev) => dispatch(ev.payload));
  }

  window.chrome = window.chrome || {};
  window.chrome.webview = {
    postMessage(obj) {
      if (!obj || !obj.type) return;
      const { type, ...rest } = obj;
      const cmd = toSnake(type);
      invoke(cmd, rest).catch((e) => {
        // Unknown command → log it; the UI stays running. Easier than
        // chasing silent no-ops.
        console.warn(`[kit-engine] invoke "${cmd}" failed:`, e);
      });
    },
    addEventListener(evt, cb) {
      if (evt !== 'message') return;
      messageListener = cb;
      // Drain anything that arrived before kit.js got around to listening.
      while (earlyBuffer.length) dispatch(earlyBuffer.shift());
    },
  };
})();

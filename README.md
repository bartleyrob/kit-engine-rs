# kit-engine-rs

Rust + Tauri rewrite of KitStation. The native C++ build at
[`bartleyrob/kit-engine`](https://github.com/bartleyrob/kit-engine) stays
on the shelf for Windows + WebView2 reference; this tree targets macOS
and Windows from one source and drops VST3 hosting on purpose.

## What's here today

| Layer | Status | Crate / file |
|---|---|---|
| Sample player (polyphony, mono-cut, choke groups, meters) | ✅ | [`crates/engine/src/lib.rs`](crates/engine/src/lib.rs) |
| cpal audio backend (WASAPI / CoreAudio / ALSA) | ✅ | [`src-tauri/src/audio.rs`](src-tauri/src/audio.rs) |
| midir MIDI I/O (WinMM / CoreMIDI / ALSA) | ✅ | [`src-tauri/src/midi.rs`](src-tauri/src/midi.rs) |
| Tauri shell + full bridge-handler set | ✅ | [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) |
| Web UI (unchanged from the C++ build) | ✅ | [`web/`](web) |
| Chrome.webview shim for the existing UI | ✅ | [`web/tauri-shim.js`](web/tauri-shim.js) |
| Kit save/load + Virus rack save/recall | ✅ | `src-tauri/src/lib.rs` |
| Doctest-style tests on the engine | ✅ | [`crates/engine/tests/basic.rs`](crates/engine/tests/basic.rs) |
| CI (Windows + mac universal) | ✅ | [`.github/workflows/`](.github/workflows) |
| VST3 hosting | ❌ (dropped) | — |
| FX chain (filter/delay/reverb/comp/crush/gate) | ⏳ stub | engine has master gain + soft-clip only |
| Sequencer tick | ⏳ JS-side only | engine is purely sample-triggered |

## Build

```bash
# One-time:
rustup toolchain install stable
npm install -g @tauri-apps/cli@^2

# Windows / Linux dev loop:
cargo tauri dev

# Release:
cargo tauri build
```

Output lands in `src-tauri/target/release/bundle/` — a `.msi` + `.exe`
installer on Windows, a `.app` + `.dmg` on macOS.

## Tests

```bash
cargo test -p kit-engine
```

Runs the engine crate's own suite — no WASAPI/MIDI/WebView needed. CI runs
this on every push.

## Layout

```
kit-engine-rs/
├── Cargo.toml                    — workspace: engine (lib) + app (bin)
├── crates/
│   └── engine/                   — pure Rust: sample player + mixer
│       ├── src/lib.rs
│       └── tests/basic.rs
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json           — bundle id, window size, icons
│   ├── build.rs
│   └── src/
│       ├── main.rs               — entry
│       ├── lib.rs                — tauri commands + state
│       ├── audio.rs              — cpal
│       ├── midi.rs               — midir
│       └── paths.rs              — %LOCALAPPDATA% / ~/Library/Application Support
├── web/                          — HTML/CSS/JS UI (ports unchanged)
│   └── tauri-shim.js             — makes window.chrome.webview resolve to invoke()
└── .github/workflows/
    ├── windows.yml
    └── mac.yml
```

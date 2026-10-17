//! KitStation Tauri shell.
//!
//! Keeps the engine, the cpal audio stream, and the midir handles alive for
//! the life of the app in a single `AppState`. Bridge handlers are plain
//! `#[tauri::command]` fns — one per bridge message type that the web UI
//! already speaks.

mod audio;
mod midi;
mod paths;

use std::sync::{Arc, Mutex};

use kit_engine::Engine;
use serde::Serialize;
use tauri::{Emitter, Manager};

use crate::audio::AudioHost;
use crate::midi::{MidiHost, MidiInputFn};

// ─── Bring-up logging ────────────────────────────────────────────────────
// Writes to %LOCALAPPDATA%\KitStation\bridge.log so we can see which
// commands actually reach the Rust side without needing a visible
// console. Each command handler calls `trace("…")` at entry.
use std::io::Write;
use std::sync::OnceLock;
fn trace(line: &str) {
    static LOG: OnceLock<std::sync::Mutex<Option<std::fs::File>>> = OnceLock::new();
    let m = LOG.get_or_init(|| {
        let dir = crate::paths::app_data_dir();
        let _   = std::fs::create_dir_all(&dir);
        let f   = std::fs::OpenOptions::new()
            .create(true).write(true).truncate(true)
            .open(dir.join("bridge.log")).ok();
        std::sync::Mutex::new(f)
    });
    if let Ok(mut g) = m.lock() {
        if let Some(f) = g.as_mut() {
            let _ = writeln!(f, "{line}");
            let _ = f.flush();
        }
    }
}

pub struct AppState {
    pub engine: Arc<Engine>,
    pub audio:  Mutex<AudioHost>,
    pub midi:   Mutex<MidiHost>,
}

// ─── Bridge messages the UI expects ───────────────────────────────────────

#[derive(Serialize, Clone)]
// `rename_all` renames the enum variants (MasterMeters → masterMeters),
// `rename_all_fields` renames fields WITHIN each variant (peak_l → peakL),
// which is what the JS UI expects (meter JS reads m.peakL, not m.peak_l).
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum BridgeEvent {
    Status      { text: String },
    SampleAssigned { pad: i32, ok: bool, path: String },
    MasterMeters { peak_l: f32, peak_r: f32, rms_l: f32, rms_r: f32, gr: f32 },
    AudioDevices { current: String, list: Vec<audio::DeviceInfo> },
    MidiInputs   { current: String, list: Vec<midi::DeviceInfo> },
    MidiOutputs  { current: String, list: Vec<midi::DeviceInfo> },
    TextFile     { path: String, ok: bool, body: String },
    KitSaved     { name: String },
    KitLoaded    { name: String, body: serde_json::Value },
    KitList      { list: Vec<String> },
    PluginList   { list: Vec<String> },
    SamplePeaks  { pad: i32, peaks: Vec<f32> },
    VirusLoaded  { body: Option<serde_json::Value> },
    VirusPresetList    { list: Vec<String> },
    VirusPresetSaved   { name: String },
    VirusPresetLoaded  { name: String, body: Option<serde_json::Value> },
    VirusPresetDeleted { name: String },
}

fn emit(app: &tauri::AppHandle, ev: BridgeEvent) {
    // The JS listens on window.chrome.webview.addEventListener in the C++
    // build, and on window.__TAURI__.event.listen here. The frontend shim
    // (see web/kit.js) unifies them.
    let _ = app.emit("ks-bridge", ev);
}

// ─── Commands (one per message type the UI sends) ─────────────────────────

#[tauri::command]
fn pad_press(state: tauri::State<AppState>, pad: i32, vel: f32) {
    // vel comes in as 0..1 from JS; convert to 0..127.
    let v = (vel * 127.0 + 0.5).clamp(0.0, 127.0) as u8;
    state.engine.trigger_pad(pad, v);
}

#[tauri::command]
fn panic_all(state: tauri::State<AppState>) {
    state.engine.panic();
    state.midi.lock().unwrap().all_notes_off();
}

#[tauri::command]
fn assign_sample(app: tauri::AppHandle, state: tauri::State<AppState>, pad: i32, path: String) {
    let ok = pad >= 0 && (pad as usize) < kit_engine::PAD_COUNT
        && state.engine.assign_sample(pad as usize, &path).is_ok();
    emit(&app, BridgeEvent::SampleAssigned { pad, ok, path });
}

#[tauri::command]
fn clear_sample(state: tauri::State<AppState>, pad: i32) {
    if pad >= 0 { state.engine.clear_sample(pad as usize); }
}

#[tauri::command]
fn set_pad_pitch(state: tauri::State<AppState>, pad: i32, semis: f32) {
    if pad >= 0 { state.engine.set_pad_pitch(pad as usize, semis); }
}
#[tauri::command]
fn set_pad_decay(state: tauri::State<AppState>, pad: i32, seconds: f32) {
    if pad >= 0 { state.engine.set_pad_decay(pad as usize, seconds); }
}
#[tauri::command]
fn set_pad_gain(state: tauri::State<AppState>, pad: i32, gain: f32) {
    if pad >= 0 { state.engine.set_pad_gain(pad as usize, gain); }
}
#[tauri::command]
fn set_pad_choke(state: tauri::State<AppState>, pad: i32, group: i32) {
    if pad >= 0 { state.engine.set_pad_choke(pad as usize, group); }
}
#[tauri::command]
fn set_master_level(state: tauri::State<AppState>, value: f32) {
    state.engine.set_master_level(value);
}
#[tauri::command]
fn get_master_meters(app: tauri::AppHandle, state: tauri::State<AppState>) {
    let m = state.engine.meters();
    emit(&app, BridgeEvent::MasterMeters {
        peak_l: m.master_peak_l, peak_r: m.master_peak_r,
        rms_l:  m.master_peak_l, rms_r:  m.master_peak_r,  // placeholder
        gr:     0.0,
    });
}

// ─── Audio device enum / selection ────────────────────────────────────────
#[tauri::command]
fn list_audio_devices(app: tauri::AppHandle, state: tauri::State<AppState>) {
    let host = state.audio.lock().unwrap();
    let list = host.list();
    trace(&format!("list_audio_devices → {} devices (current='{}')",
                   list.len(), host.current_name()));
    emit(&app, BridgeEvent::AudioDevices {
        current: host.current_name(),
        list,
    });
}
#[tauri::command]
fn select_audio_device(state: tauri::State<AppState>, id: String) -> Result<(), String> {
    let mut host = state.audio.lock().unwrap();
    host.open(&id, state.engine.clone()).map_err(|e| e.to_string())
}

// ─── MIDI I/O ─────────────────────────────────────────────────────────────
#[tauri::command]
fn list_midi_inputs(app: tauri::AppHandle, state: tauri::State<AppState>) {
    let host = state.midi.lock().unwrap();
    emit(&app, BridgeEvent::MidiInputs { current: host.input_name(), list: host.list_inputs() });
}
#[tauri::command]
fn list_midi_outputs(app: tauri::AppHandle, state: tauri::State<AppState>) {
    let host = state.midi.lock().unwrap();
    emit(&app, BridgeEvent::MidiOutputs { current: host.output_name(), list: host.list_outputs() });
}
#[tauri::command]
fn select_midi_input(state: tauri::State<AppState>, index: i32) -> Result<(), String> {
    let mut host = state.midi.lock().unwrap();
    let engine = state.engine.clone();
    if index < 0 { host.close_input(); return Ok(()); }
    // GM drum map → pad index, same mapping as the C++ build.
    let cb: MidiInputFn = Arc::new(move |status: u8, d1: u8, d2: u8| {
        if (status & 0xF0) != 0x90 || d2 == 0 { return; }
        let pad = match d1 {
            36 => 0, 38 => 1, 41 => 2, 43 => 3, 45 => 4,
            39 => 5, 42 => 6, 46 => 7, 49 => 8, 51 => 9,
            _  => return,
        };
        engine.trigger_pad(pad, d2);
    });
    host.open_input(index as usize, cb).map_err(|e| e.to_string())
}
#[tauri::command]
fn select_midi_output(state: tauri::State<AppState>, index: i32) -> Result<(), String> {
    let mut host = state.midi.lock().unwrap();
    if index < 0 { host.close_output(); Ok(()) }
    else         { host.open_output(index as usize).map_err(|e| e.to_string()) }
}
#[tauri::command]
fn midi_out_cc(state: tauri::State<AppState>, channel: u8, cc: u8, value: u8) {
    state.midi.lock().unwrap().send_cc(channel, cc, value);
}
#[tauri::command]
fn midi_out_note_on(state: tauri::State<AppState>, channel: u8, note: u8, vel: u8) {
    state.midi.lock().unwrap().send_note_on(channel, note, vel);
}
#[tauri::command]
fn midi_out_note_off(state: tauri::State<AppState>, channel: u8, note: u8) {
    state.midi.lock().unwrap().send_note_off(channel, note);
}
#[tauri::command]
fn midi_out_pc(state: tauri::State<AppState>, channel: u8, program: u8) {
    state.midi.lock().unwrap().send_program_change(channel, program);
}
#[tauri::command]
fn midi_out_panic(state: tauri::State<AppState>) {
    state.midi.lock().unwrap().all_notes_off();
}

// ─── File I/O ─────────────────────────────────────────────────────────────
#[tauri::command]
fn read_text_file(app: tauri::AppHandle, path: String) {
    let body = std::fs::read(&path).unwrap_or_default();
    // Strip UTF-8 BOM — some editors add it, and JSON.parse rejects it.
    let bytes: Vec<u8> = if body.starts_with(&[0xEF, 0xBB, 0xBF]) { body[3..].to_vec() } else { body };
    let s   = String::from_utf8_lossy(&bytes).into_owned();
    let ok  = !s.is_empty();
    emit(&app, BridgeEvent::TextFile { path, ok, body: s });
}

#[tauri::command]
fn save_kit(app: tauri::AppHandle, name: String, body: String) {
    let dir  = paths::kits_dir();
    let _    = std::fs::create_dir_all(&dir);
    let file = dir.join(format!("{name}.json"));
    let _    = std::fs::write(&file, body);
    emit(&app, BridgeEvent::KitSaved { name });
}
#[tauri::command]
fn load_kit(app: tauri::AppHandle, name: String) {
    let file = paths::kits_dir().join(format!("{name}.json"));
    let body = std::fs::read_to_string(&file).unwrap_or_default();
    let json: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    emit(&app, BridgeEvent::KitLoaded { name, body: json });
}
#[tauri::command]
fn list_kits(app: tauri::AppHandle) {
    let dir  = paths::kits_dir();
    let mut list = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if let Some(ext) = e.path().extension() {
                if ext == "json" {
                    if let Some(stem) = e.path().file_stem() {
                        list.push(stem.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    emit(&app, BridgeEvent::KitList { list });
}

// ─── Virus rack persistence ───────────────────────────────────────────────
#[tauri::command]
fn virus_save(body: String) {
    let _ = std::fs::create_dir_all(paths::app_data_dir());
    let _ = std::fs::write(paths::app_data_dir().join("virus.json"), body);
}
#[tauri::command]
fn virus_load(app: tauri::AppHandle) {
    let body = std::fs::read_to_string(paths::app_data_dir().join("virus.json")).ok();
    let json = body.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    emit(&app, BridgeEvent::VirusLoaded { body: json });
}
#[tauri::command]
fn virus_preset_save(app: tauri::AppHandle, name: String, body: String) {
    let safe: String = name.chars()
        .filter(|c| c.is_ascii_alphanumeric() || " -_.".contains(*c))
        .collect();
    if safe.is_empty() { return; }
    let dir = paths::virus_presets_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(format!("{safe}.json")), body);
    emit(&app, BridgeEvent::VirusPresetSaved { name: safe });
}
#[tauri::command]
fn virus_preset_load(app: tauri::AppHandle, name: String) {
    let file = paths::virus_presets_dir().join(format!("{name}.json"));
    let body = std::fs::read_to_string(&file).ok();
    let json = body.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    emit(&app, BridgeEvent::VirusPresetLoaded { name, body: json });
}
#[tauri::command]
fn virus_preset_list(app: tauri::AppHandle) {
    let dir  = paths::virus_presets_dir();
    let mut list = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if let Some(ext) = e.path().extension() {
                if ext == "json" {
                    if let Some(stem) = e.path().file_stem() {
                        list.push(stem.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    emit(&app, BridgeEvent::VirusPresetList { list });
}
#[tauri::command]
fn virus_preset_delete(app: tauri::AppHandle, name: String) {
    let _ = std::fs::remove_file(paths::virus_presets_dir().join(format!("{name}.json")));
    emit(&app, BridgeEvent::VirusPresetDeleted { name });
}

// ─── Stubs the UI expects but we haven't ported yet ──────────────────────
#[tauri::command]
fn list_plugins(app: tauri::AppHandle) {
    // VST3 hosting is intentionally not in the Rust build. Empty list keeps
    // the master-bus Plugins panel visible but inert.
    emit(&app, BridgeEvent::PluginList { list: vec![] });
}
#[tauri::command]
fn get_sample_peaks(app: tauri::AppHandle, pad: i32) {
    emit(&app, BridgeEvent::SamplePeaks { pad, peaks: vec![] });
}
#[tauri::command]
fn hello() { trace("hello  (JS bridge is live)"); }

// Catch-all diagnostic hook — the shim can send `{type:'debug', msg:'…'}`
// and anything stuck in the WebView surfaces in bridge.log.
#[tauri::command]
fn debug(msg: String) { trace(&format!("debug: {msg}")); }

// ─── Setup ────────────────────────────────────────────────────────────────

pub fn run() {
    env_logger::init();
    let engine = Arc::new(Engine::new());

    tauri::Builder::default()
        .manage({
            let audio = AudioHost::new();
            let midi  = MidiHost::new();
            AppState {
                engine: engine.clone(),
                audio:  Mutex::new(audio),
                midi:   Mutex::new(midi),
            }
        })
        .setup(move |app| {
            trace("=== KitStation bring-up ===");
            trace(&format!("app_data_dir = {}", paths::app_data_dir().display()));
            // Open the default audio device straight away so pads play on
            // first boot. If it fails, the status bar announces it; the
            // user can pick a different device from the Audio & MIDI modal.
            let state: tauri::State<AppState> = app.state();
            let mut audio = state.audio.lock().unwrap();
            match audio.open("", engine.clone()) {
                Ok(()) => {
                    trace(&format!("audio opened: {} @ {} Hz, {} ch",
                                   audio.current_name(), audio.sample_rate(), audio.channels()));
                    emit(&app.handle(), BridgeEvent::Status { text:
                        format!("Audio: {} @ {} Hz, {} ch",
                                audio.current_name(), audio.sample_rate(), audio.channels()) });
                }
                Err(e) => {
                    trace(&format!("audio FAILED: {e}"));
                    emit(&app.handle(), BridgeEvent::Status {
                        text: format!("Audio: FAILED to open default device — {e}") });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pad_press, panic_all,
            assign_sample, clear_sample,
            set_pad_pitch, set_pad_decay, set_pad_gain, set_pad_choke,
            set_master_level, get_master_meters,
            list_audio_devices, select_audio_device,
            list_midi_inputs, list_midi_outputs,
            select_midi_input, select_midi_output,
            midi_out_cc, midi_out_note_on, midi_out_note_off, midi_out_pc, midi_out_panic,
            read_text_file,
            save_kit, load_kit, list_kits,
            virus_save, virus_load,
            virus_preset_save, virus_preset_load, virus_preset_list, virus_preset_delete,
            list_plugins, get_sample_peaks, hello, debug,
        ])
        .run(tauri::generate_context!())
        .expect("tauri app crashed");
}

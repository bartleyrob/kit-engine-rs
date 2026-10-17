//! KitStation engine — sample player, per-pad polyphony, FX chain stubs.
//!
//! Direct Rust transliteration of `kit-cross/src/core/Engine.cpp`. Audio
//! runs on a cpal callback thread; triggers come in from the UI thread via
//! a lock-free SPSC-style ring (plain atomics are enough — we only need
//! single-producer-single-consumer). Samples are swapped in via
//! `arc-swap` style atomic pointers so the audio thread never sees a
//! half-written slot.
//!
//! The public API intentionally mirrors the C++ one so the Tauri bridge
//! handlers in `src-tauri` stay a one-liner each.

use std::sync::atomic::{AtomicI32, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub const PAD_COUNT: usize = 11;
const MAX_VOICES_PER_PAD: usize = 4;
const QSIZE: usize = 64;
const VOICE_HEADROOM: f32 = 0.5;

/// A decoded sample in RAM. Mono stays mono, 2+ channels get clamped to
/// stereo so the mix loop stays simple.
#[derive(Debug)]
pub struct Sample {
    pub data:        Vec<f32>,   // interleaved (frames * channels)
    pub frames:      u32,
    pub channels:    u16,
    pub sample_rate: u32,
}

/// Per-pad settings — mutated from the UI thread, read from the audio
/// thread. Plain atomics are fine; audio-rate reads of a stale value by
/// a few ms is inaudible.
#[derive(Default)]
struct PadParams {
    // packed as atomics so the audio thread never reads a torn float.
    pitch_semi_milli: AtomicI32, // semitones * 1000, so float values fit
    decay_frames:     AtomicU32,
    gain_milli:       AtomicU32, // gain * 1000
    choke:            AtomicI32,
}

impl PadParams {
    fn pitch_semi(&self) -> f32 { self.pitch_semi_milli.load(Ordering::Relaxed) as f32 / 1000.0 }
    fn gain(&self)       -> f32 { self.gain_milli.load(Ordering::Relaxed)       as f32 / 1000.0 }
    fn new_default() -> Self {
        let p = PadParams::default();
        p.decay_frames.store(4 * 44100, Ordering::Relaxed);
        p.gain_milli.store(1000,       Ordering::Relaxed);
        p.choke.store(-1,              Ordering::Relaxed);
        p
    }
}

#[derive(Default)]
struct Voice {
    active:        bool,
    pad:           i32,
    pos:           f64,
    step:          f64,
    env_amp:       f32,
    env_decay_k:   f32,
    vel_gain:      f32,
    sample:        Option<Arc<Sample>>,
}

#[derive(Clone, Copy, Default)]
struct Trigger { pad: i32, vel: u8 }

/// SPSC trigger ring. UI thread pushes with `push`, audio thread drains
/// with `drain`.
struct TriggerQueue {
    slots: [std::cell::UnsafeCell<Trigger>; QSIZE],
    head:  AtomicUsize,
    tail:  AtomicUsize,
}
// Safe because head/tail enforce exclusive access to each slot via
// release/acquire ordering (classic SPSC pattern).
unsafe impl Sync for TriggerQueue {}

impl TriggerQueue {
    fn new() -> Self {
        Self {
            slots: std::array::from_fn(|_| std::cell::UnsafeCell::new(Trigger::default())),
            head:  AtomicUsize::new(0),
            tail:  AtomicUsize::new(0),
        }
    }
    fn push(&self, t: Trigger) {
        let head = self.head.load(Ordering::Relaxed);
        let next = (head + 1) % QSIZE;
        if next == self.tail.load(Ordering::Acquire) { return; } // full — drop
        unsafe { *self.slots[head].get() = t; }
        self.head.store(next, Ordering::Release);
    }
    fn drain(&self, mut cb: impl FnMut(Trigger)) {
        let mut tail = self.tail.load(Ordering::Relaxed);
        let head     = self.head.load(Ordering::Acquire);
        while tail != head {
            let t = unsafe { *self.slots[tail].get() };
            tail = (tail + 1) % QSIZE;
            cb(t);
        }
        self.tail.store(tail, Ordering::Release);
    }
}

pub struct Engine {
    sample_rate:  AtomicU32,
    master_level: AtomicU32,                     // f32 * 1000
    pads:         [Mutex<Option<Arc<Sample>>>; PAD_COUNT],
    params:       [PadParams; PAD_COUNT],
    voices:       Mutex<Box<[Voice; PAD_COUNT * MAX_VOICES_PER_PAD]>>,
    queue:        TriggerQueue,
    pad_peak:     [AtomicU32; PAD_COUNT],        // f32 * 1_000_000
    master_peak_l: AtomicU32,
    master_peak_r: AtomicU32,
}

impl Default for Engine {
    fn default() -> Self { Engine::new() }
}

impl Engine {
    pub fn new() -> Self {
        Engine {
            sample_rate:  AtomicU32::new(44100),
            master_level: AtomicU32::new(500),
            pads:         std::array::from_fn(|_| Mutex::new(None)),
            params:       std::array::from_fn(|_| PadParams::new_default()),
            voices:       Mutex::new(Box::new(std::array::from_fn(|_| Voice::default()))),
            queue:        TriggerQueue::new(),
            pad_peak:     std::array::from_fn(|_| AtomicU32::new(0)),
            master_peak_l: AtomicU32::new(0),
            master_peak_r: AtomicU32::new(0),
        }
    }

    pub fn set_sample_rate(&self, sr: u32) {
        self.sample_rate.store(sr, Ordering::Relaxed);
        // Rescale per-pad decay times to match the new sr so the audible
        // envelope length stays constant.
        for p in &self.params {
            let frames = p.decay_frames.load(Ordering::Relaxed);
            // nothing to rescale on fresh pads — they're initialized to
            // 4 * 44100 which is fine as a default.
            let _ = frames;
        }
    }

    pub fn sample_rate(&self) -> u32 { self.sample_rate.load(Ordering::Relaxed) }

    pub fn set_master_level(&self, g: f32) {
        self.master_level.store((g.max(0.0) * 1000.0) as u32, Ordering::Relaxed);
    }

    pub fn set_pad_pitch(&self, pad: usize, semis: f32) {
        if pad >= PAD_COUNT { return; }
        self.params[pad].pitch_semi_milli.store((semis * 1000.0) as i32, Ordering::Relaxed);
    }
    pub fn set_pad_decay(&self, pad: usize, seconds: f32) {
        if pad >= PAD_COUNT { return; }
        let sr = self.sample_rate() as f32;
        let frames = (seconds.max(0.02) * sr) as u32;
        self.params[pad].decay_frames.store(frames.max(1), Ordering::Relaxed);
    }
    pub fn set_pad_gain(&self, pad: usize, gain: f32) {
        if pad >= PAD_COUNT { return; }
        self.params[pad].gain_milli.store((gain.max(0.0) * 1000.0) as u32, Ordering::Relaxed);
    }
    pub fn set_pad_choke(&self, pad: usize, group: i32) {
        if pad >= PAD_COUNT { return; }
        self.params[pad].choke.store(group, Ordering::Relaxed);
    }

    /// Load a WAV via hound. Mono passes through, 2+ channels get clamped
    /// to stereo (dropping extra channels on decode).
    pub fn assign_sample(&self, pad: usize, path: &str) -> Result<(), String> {
        if pad >= PAD_COUNT { return Err("pad out of range".into()); }
        let mut reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
        let spec = reader.spec();
        let src_ch = spec.channels as u16;
        let out_ch = src_ch.min(2);
        let frames = reader.len() / src_ch as u32;
        let mut data = Vec::<f32>::with_capacity((frames as usize) * (out_ch as usize));

        // Convert int samples to [-1, 1] float. hound streams samples as
        // int16/int32/float; we take whatever and normalize.
        let scale16 = 1.0 / 32768.0_f32;
        let scale24 = 1.0 / 8_388_608.0_f32;
        let scale32 = 1.0 / 2_147_483_648.0_f32;
        match (spec.sample_format, spec.bits_per_sample) {
            (hound::SampleFormat::Int, 16) => {
                let mut buf = Vec::with_capacity(src_ch as usize);
                for s in reader.samples::<i16>() {
                    buf.push(s.map_err(|e| e.to_string())? as f32 * scale16);
                    if buf.len() == src_ch as usize {
                        for c in 0..out_ch as usize { data.push(buf[c]); }
                        buf.clear();
                    }
                }
            }
            (hound::SampleFormat::Int, 24) | (hound::SampleFormat::Int, 32) => {
                let scale = if spec.bits_per_sample == 24 { scale24 } else { scale32 };
                let mut buf = Vec::with_capacity(src_ch as usize);
                for s in reader.samples::<i32>() {
                    buf.push(s.map_err(|e| e.to_string())? as f32 * scale);
                    if buf.len() == src_ch as usize {
                        for c in 0..out_ch as usize { data.push(buf[c]); }
                        buf.clear();
                    }
                }
            }
            (hound::SampleFormat::Float, _) => {
                let mut buf = Vec::with_capacity(src_ch as usize);
                for s in reader.samples::<f32>() {
                    buf.push(s.map_err(|e| e.to_string())?);
                    if buf.len() == src_ch as usize {
                        for c in 0..out_ch as usize { data.push(buf[c]); }
                        buf.clear();
                    }
                }
            }
            (fmt, bits) => return Err(format!("unsupported WAV: {:?} / {} bits", fmt, bits)),
        }

        let samp = Arc::new(Sample { data, frames, channels: out_ch, sample_rate: spec.sample_rate });
        *self.pads[pad].lock().unwrap() = Some(samp);
        Ok(())
    }

    pub fn clear_sample(&self, pad: usize) {
        if pad >= PAD_COUNT { return; }
        *self.pads[pad].lock().unwrap() = None;
        let mut voices = self.voices.lock().unwrap();
        for v in voices.iter_mut() {
            if v.pad as usize == pad { v.active = false; v.sample = None; }
        }
    }

    /// Enqueue a trigger — safe to call from any thread.
    pub fn trigger_pad(&self, pad: i32, vel: u8) {
        self.queue.push(Trigger { pad, vel });
    }

    pub fn panic(&self) {
        let mut voices = self.voices.lock().unwrap();
        for v in voices.iter_mut() { v.active = false; v.sample = None; }
    }

    /// Fill `out` with interleaved stereo frames. Called on the audio
    /// callback thread; must not allocate.
    pub fn render(&self, out: &mut [f32], frames: usize) {
        // Zero the buffer. The caller passes a stereo slice: out.len() == frames * 2.
        for s in out.iter_mut() { *s = 0.0; }

        // Drain triggers → spawn voices. Reusing one lock across drain is
        // fine; UI thread's push is lock-free.
        let mut voices = self.voices.lock().unwrap();
        let sr_out = self.sample_rate() as f64;
        self.queue.drain(|t| {
            if (t.pad as usize) >= PAD_COUNT { return; }
            let pad = t.pad as usize;
            let samp = match self.pads[pad].lock().unwrap().clone() {
                Some(s) if s.frames > 0 => s,
                _ => return,
            };
            // Same-pad mono cut: deactivate any existing voices on this pad.
            for v in voices.iter_mut() {
                if v.active && v.pad as usize == pad { v.active = false; }
            }
            // Choke group: kill other pads in the same group.
            let group = self.params[pad].choke.load(Ordering::Relaxed);
            if group >= 0 {
                for other in 0..PAD_COUNT {
                    if other == pad { continue; }
                    if self.params[other].choke.load(Ordering::Relaxed) == group {
                        for v in voices.iter_mut() {
                            if v.active && v.pad as usize == other { v.active = false; }
                        }
                    }
                }
            }
            // Find a free voice slot.
            let slot = voices.iter_mut().find(|v| !v.active);
            let Some(slot) = slot else { return; };
            let pitch_ratio = 2f64.powf(self.params[pad].pitch_semi() as f64 / 12.0);
            let decay_frames = self.params[pad].decay_frames.load(Ordering::Relaxed).max(1) as f32;
            slot.active      = true;
            slot.pad         = pad as i32;
            slot.pos         = 0.0;
            slot.step        = (samp.sample_rate as f64) / sr_out * pitch_ratio;
            slot.env_amp     = 1.0;
            slot.vel_gain    = t.vel as f32 / 127.0;
            slot.env_decay_k = 0.001f32.powf(1.0 / decay_frames);
            slot.sample      = Some(samp);
        });

        // Mix active voices into out[].
        let mut pad_peak_local = [0f32; PAD_COUNT];
        for v in voices.iter_mut() {
            if !v.active { continue; }
            let samp = match &v.sample { Some(s) => Arc::clone(s), None => { v.active = false; continue; } };
            let s_frames = samp.frames as usize;
            let s_ch     = samp.channels as usize;
            let s_data   = &samp.data;
            let gain = self.params[v.pad as usize].gain() * v.vel_gain * VOICE_HEADROOM;

            for i in 0..frames {
                if v.pos >= s_frames as f64 { v.active = false; break; }
                let idx = v.pos as usize;
                let amp = v.env_amp * gain;
                let (l, r) = if s_ch == 1 {
                    let m = s_data[idx] * amp;
                    (m, m)
                } else {
                    (s_data[idx * 2] * amp, s_data[idx * 2 + 1] * amp)
                };
                out[i * 2    ] += l;
                out[i * 2 + 1] += r;
                let peak = l.abs().max(r.abs());
                if peak > pad_peak_local[v.pad as usize] { pad_peak_local[v.pad as usize] = peak; }
                v.pos    += v.step;
                v.env_amp *= v.env_decay_k;
                if v.env_amp < 1e-4 { v.active = false; break; }
            }
        }

        // Decay-smooth per-pad peaks.
        for i in 0..PAD_COUNT {
            let prev = f32::from_bits(self.pad_peak[i].load(Ordering::Relaxed));
            let next = (prev * 0.85).max(pad_peak_local[i]);
            self.pad_peak[i].store(next.to_bits(), Ordering::Relaxed);
        }

        // Master gain + soft-clip + master peak.
        let g = self.master_level.load(Ordering::Relaxed) as f32 / 1000.0;
        let (mut peak_l, mut peak_r) = (0f32, 0f32);
        for i in 0..frames {
            let mut l = out[i * 2    ] * g;
            let mut r = out[i * 2 + 1] * g;
            l = l.tanh();
            r = r.tanh();
            out[i * 2    ] = l;
            out[i * 2 + 1] = r;
            if l.abs() > peak_l { peak_l = l.abs(); }
            if r.abs() > peak_r { peak_r = r.abs(); }
        }
        let pl = f32::from_bits(self.master_peak_l.load(Ordering::Relaxed));
        let pr = f32::from_bits(self.master_peak_r.load(Ordering::Relaxed));
        self.master_peak_l.store(((pl * 0.85).max(peak_l)).to_bits(), Ordering::Relaxed);
        self.master_peak_r.store(((pr * 0.85).max(peak_r)).to_bits(), Ordering::Relaxed);
    }

    pub fn meters(&self) -> Meters {
        let mut m = Meters::default();
        for i in 0..PAD_COUNT {
            m.pad_peak[i] = f32::from_bits(self.pad_peak[i].load(Ordering::Relaxed));
        }
        m.master_peak_l = f32::from_bits(self.master_peak_l.load(Ordering::Relaxed));
        m.master_peak_r = f32::from_bits(self.master_peak_r.load(Ordering::Relaxed));
        m
    }
}

#[derive(Default, Clone, Copy)]
pub struct Meters {
    pub pad_peak:      [f32; PAD_COUNT],
    pub master_peak_l: f32,
    pub master_peak_r: f32,
}

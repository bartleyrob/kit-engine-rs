//! Smoke tests mirroring the doctest suite from the C++ scaffold.
//! Run with: cargo test -p kit-engine

use kit_engine::{Engine, PAD_COUNT};
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

fn write_ramp_wav(path: &PathBuf, channels: u16, sr: u32, frames: u32) {
    let data_size = frames * channels as u32 * 2;
    let chunk     = 36 + data_size;
    let mut f = File::create(path).unwrap();
    f.write_all(b"RIFF").unwrap();
    f.write_all(&chunk.to_le_bytes()).unwrap();
    f.write_all(b"WAVE").unwrap();
    f.write_all(b"fmt ").unwrap();
    f.write_all(&16u32.to_le_bytes()).unwrap();
    f.write_all(&1u16.to_le_bytes()).unwrap();                  // PCM
    f.write_all(&channels.to_le_bytes()).unwrap();
    f.write_all(&sr.to_le_bytes()).unwrap();
    let block_align = channels * 2;
    f.write_all(&(sr * block_align as u32).to_le_bytes()).unwrap();
    f.write_all(&block_align.to_le_bytes()).unwrap();
    f.write_all(&16u16.to_le_bytes()).unwrap();                 // bits per sample
    f.write_all(b"data").unwrap();
    f.write_all(&data_size.to_le_bytes()).unwrap();
    for i in 0..frames {
        let s = (i as i32 * 300) as i16;
        for _ in 0..channels { f.write_all(&s.to_le_bytes()).unwrap(); }
    }
}

#[test]
fn silent_before_any_assign() {
    let e = Engine::new();
    e.set_sample_rate(48000);
    let mut buf = vec![0.5f32; 1024 * 2];
    e.render(&mut buf, 1024);
    for s in buf.iter() { assert!(s.abs() < 1e-4); }
}

#[test]
fn assign_stereo_and_trigger_makes_sound() {
    let e = Engine::new();
    e.set_sample_rate(48000);
    let p = std::env::temp_dir().join("kit_engine_rs_stereo.wav");
    write_ramp_wav(&p, 2, 48000, 100);
    e.assign_sample(0, p.to_str().unwrap()).unwrap();
    e.set_master_level(1.0);
    e.trigger_pad(0, 127);
    let mut buf = vec![0f32; 256 * 2];
    e.render(&mut buf, 256);
    let peak = buf.iter().map(|v| v.abs()).fold(0f32, f32::max);
    assert!(peak > 0.001, "peak was {}", peak);
}

#[test]
fn mono_sample_fans_to_stereo() {
    let e = Engine::new();
    e.set_sample_rate(48000);
    let p = std::env::temp_dir().join("kit_engine_rs_mono.wav");
    write_ramp_wav(&p, 1, 48000, 100);
    e.assign_sample(1, p.to_str().unwrap()).unwrap();
    e.trigger_pad(1, 100);
    let mut buf = vec![0f32; 256 * 2];
    e.render(&mut buf, 256);
    let peak = buf.iter().map(|v| v.abs()).fold(0f32, f32::max);
    assert!(peak > 0.001);
}

#[test]
fn out_of_range_pads_do_not_panic() {
    let e = Engine::new();
    e.set_sample_rate(48000);
    e.trigger_pad(-1, 100);
    e.trigger_pad(999, 100);
    e.set_pad_pitch(999, 12.0);
    e.set_pad_gain(999, 2.0);
    let mut buf = vec![0f32; 64 * 2];
    e.render(&mut buf, 64);
}

#[test]
fn queue_overflow_is_silent() {
    let e = Engine::new();
    e.set_sample_rate(48000);
    let p = std::env::temp_dir().join("kit_engine_rs_stereo.wav");
    write_ramp_wav(&p, 2, 48000, 100);
    e.assign_sample(0, p.to_str().unwrap()).unwrap();
    for _ in 0..500 { e.trigger_pad(0, 100); }
    let mut buf = vec![0f32; 1024 * 2];
    e.render(&mut buf, 1024);
}

#[test]
fn pad_count_matches_const() {
    assert_eq!(PAD_COUNT, 11);
}

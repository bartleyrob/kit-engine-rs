//! cpal-based audio backend.
//!
//! Enumerates and opens output devices across WASAPI/CoreAudio/ALSA; feeds
//! the kit-engine render callback on cpal's audio thread.

use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;

use kit_engine::Engine;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id:        String,
    pub name:      String,
    #[serde(rename = "default")] pub is_default: bool,
    pub available: bool,
    pub kind:      String,
}

pub struct AudioHost {
    stream:       Option<cpal::Stream>,
    current_name: String,
    sample_rate:  u32,
    channels:     u16,
}

// cpal::Stream contains a raw pointer that's not Send on some backends. We
// only move it inside AudioHost (held in a Mutex at the app level), never
// across threads directly, so this is sound.
unsafe impl Send for AudioHost {}

impl AudioHost {
    pub fn new() -> Self {
        AudioHost { stream: None, current_name: String::new(), sample_rate: 0, channels: 0 }
    }

    pub fn current_name(&self) -> String { self.current_name.clone() }
    pub fn sample_rate(&self)  -> u32    { self.sample_rate }
    pub fn channels(&self)     -> u16    { self.channels }

    pub fn list(&self) -> Vec<DeviceInfo> {
        let host    = cpal::default_host();
        let default = host.default_output_device().and_then(|d| d.name().ok()).unwrap_or_default();
        let kind    = host.id().name().to_string();
        let mut out = Vec::new();
        if let Ok(devs) = host.output_devices() {
            for d in devs {
                let name = d.name().unwrap_or_else(|_| "(unnamed)".into());
                out.push(DeviceInfo {
                    id:         name.clone(),
                    name:       name.clone(),
                    is_default: name == default,
                    available:  true,
                    kind:       kind.clone(),
                });
            }
        }
        out
    }

    /// Open the named device (empty string = system default) and start the
    /// render callback. Any previous stream is dropped first.
    pub fn open(&mut self, id: &str, engine: Arc<Engine>) -> Result<(), cpal::BuildStreamError> {
        self.stream = None;   // drop first so WASAPI releases the old endpoint
        let host    = cpal::default_host();
        let device  = if id.is_empty() {
            host.default_output_device()
        } else {
            host.output_devices().ok().and_then(|mut it|
                it.find(|d| d.name().as_deref().unwrap_or("") == id))
        };
        let Some(device) = device else {
            return Err(cpal::BuildStreamError::DeviceNotAvailable);
        };
        let config = device.default_output_config().map_err(|_| cpal::BuildStreamError::DeviceNotAvailable)?;
        self.current_name = device.name().unwrap_or_default();
        self.sample_rate  = config.sample_rate().0;
        self.channels     = config.channels();
        engine.set_sample_rate(self.sample_rate);

        let err_fn = |e| log::error!("cpal stream error: {e}");
        let channels = self.channels as usize;

        // cpal picks the device's preferred sample format at default; branch
        // once and build the right stream.
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                let eng = engine.clone();
                device.build_output_stream(
                    &config.into(),
                    move |data: &mut [f32], _| {
                        let frames = data.len() / channels;
                        if channels == 2 {
                            eng.render(data, frames);
                        } else {
                            // Render stereo into a scratch buffer and fan out
                            // / fold into the device's channel count.
                            let mut tmp = vec![0f32; frames * 2];
                            eng.render(&mut tmp, frames);
                            for i in 0..frames {
                                for c in 0..channels {
                                    data[i * channels + c] = tmp[i * 2 + (c & 1)];
                                }
                            }
                        }
                    },
                    err_fn,
                    None,
                )?
            }
            cpal::SampleFormat::I16 => {
                let eng = engine.clone();
                device.build_output_stream(
                    &config.into(),
                    move |data: &mut [i16], _| {
                        let frames = data.len() / channels;
                        let mut tmp = vec![0f32; frames * 2];
                        eng.render(&mut tmp, frames);
                        for i in 0..frames {
                            let l = (tmp[i * 2    ].clamp(-1.0, 1.0) * 32767.0) as i16;
                            let r = (tmp[i * 2 + 1].clamp(-1.0, 1.0) * 32767.0) as i16;
                            for c in 0..channels {
                                data[i * channels + c] = if c & 1 == 0 { l } else { r };
                            }
                        }
                    },
                    err_fn,
                    None,
                )?
            }
            cpal::SampleFormat::U16 => {
                let eng = engine.clone();
                device.build_output_stream(
                    &config.into(),
                    move |data: &mut [u16], _| {
                        let frames = data.len() / channels;
                        let mut tmp = vec![0f32; frames * 2];
                        eng.render(&mut tmp, frames);
                        for i in 0..frames {
                            let l = ((tmp[i * 2    ].clamp(-1.0, 1.0) * 32767.0) + 32768.0) as u16;
                            let r = ((tmp[i * 2 + 1].clamp(-1.0, 1.0) * 32767.0) + 32768.0) as u16;
                            for c in 0..channels {
                                data[i * channels + c] = if c & 1 == 0 { l } else { r };
                            }
                        }
                    },
                    err_fn,
                    None,
                )?
            }
            fmt => {
                log::warn!("unsupported cpal sample format {:?}", fmt);
                return Err(cpal::BuildStreamError::StreamConfigNotSupported);
            }
        };
        stream.play().map_err(|_| cpal::BuildStreamError::DeviceNotAvailable)?;
        self.stream = Some(stream);
        Ok(())
    }
}

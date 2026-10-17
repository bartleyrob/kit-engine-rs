//! midir-based MIDI I/O. Short messages only.

use std::sync::Arc;

use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::Serialize;

pub type MidiInputFn = Arc<dyn Fn(u8, u8, u8) + Send + Sync>;

#[derive(Serialize, Clone)]
pub struct DeviceInfo { pub index: usize, pub name: String }

pub struct MidiHost {
    in_conn:  Option<MidiInputConnection<()>>,
    in_name:  String,
    out_conn: Option<MidiOutputConnection>,
    out_name: String,
}

impl MidiHost {
    pub fn new() -> Self {
        MidiHost { in_conn: None, in_name: String::new(), out_conn: None, out_name: String::new() }
    }

    pub fn input_name(&self)  -> String { self.in_name.clone() }
    pub fn output_name(&self) -> String { self.out_name.clone() }

    pub fn list_inputs(&self) -> Vec<DeviceInfo> {
        let m = match MidiInput::new("kit-engine") { Ok(m) => m, Err(_) => return vec![] };
        m.ports().iter().enumerate().map(|(i, p)| DeviceInfo {
            index: i, name: m.port_name(p).unwrap_or_default(),
        }).collect()
    }
    pub fn list_outputs(&self) -> Vec<DeviceInfo> {
        let m = match MidiOutput::new("kit-engine") { Ok(m) => m, Err(_) => return vec![] };
        m.ports().iter().enumerate().map(|(i, p)| DeviceInfo {
            index: i, name: m.port_name(p).unwrap_or_default(),
        }).collect()
    }

    pub fn open_input(&mut self, index: usize, cb: MidiInputFn) -> Result<(), String> {
        self.close_input();
        let m = MidiInput::new("kit-engine").map_err(|e| e.to_string())?;
        let ports = m.ports();
        let port = ports.get(index).ok_or("midi input index out of range")?;
        let name = m.port_name(port).unwrap_or_default();
        let conn = m.connect(port, "kit-engine-in", move |_t, msg, _| {
            if msg.len() >= 3 { cb(msg[0], msg[1], msg[2]); }
            else if msg.len() == 2 { cb(msg[0], msg[1], 0); }
        }, ()).map_err(|e| e.to_string())?;
        self.in_conn = Some(conn);
        self.in_name = name;
        Ok(())
    }
    pub fn close_input(&mut self) {
        self.in_conn.take();   // drop closes the port
        self.in_name.clear();
    }

    pub fn open_output(&mut self, index: usize) -> Result<(), String> {
        self.close_output();
        let m = MidiOutput::new("kit-engine").map_err(|e| e.to_string())?;
        let ports = m.ports();
        let port = ports.get(index).ok_or("midi output index out of range")?;
        let name = m.port_name(port).unwrap_or_default();
        let conn = m.connect(port, "kit-engine-out").map_err(|e| e.to_string())?;
        self.out_conn = Some(conn);
        self.out_name = name;
        Ok(())
    }
    pub fn close_output(&mut self) {
        self.out_conn.take();
        self.out_name.clear();
    }

    pub fn send_cc(&mut self, ch: u8, cc: u8, v: u8) {
        self.send(&[0xB0 | (ch & 0x0F), cc & 0x7F, v & 0x7F]);
    }
    pub fn send_note_on(&mut self, ch: u8, note: u8, vel: u8) {
        self.send(&[0x90 | (ch & 0x0F), note & 0x7F, vel & 0x7F]);
    }
    pub fn send_note_off(&mut self, ch: u8, note: u8) {
        self.send(&[0x80 | (ch & 0x0F), note & 0x7F, 0]);
    }
    pub fn send_program_change(&mut self, ch: u8, program: u8) {
        self.send(&[0xC0 | (ch & 0x0F), program & 0x7F]);
    }
    pub fn all_notes_off(&mut self) {
        for ch in 0u8..16 {
            self.send(&[0xB0 | ch, 123, 0]);
            self.send(&[0xB0 | ch, 120, 0]);
        }
    }
    fn send(&mut self, bytes: &[u8]) {
        if let Some(c) = self.out_conn.as_mut() { let _ = c.send(bytes); }
    }
}

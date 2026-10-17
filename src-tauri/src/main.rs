// Tauri entry point — hides the console on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kit_engine_app::run();
}

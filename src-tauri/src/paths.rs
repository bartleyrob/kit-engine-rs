//! Cross-platform well-known paths.
//!   Windows → %LOCALAPPDATA%\KitStation
//!   macOS   → ~/Library/Application Support/KitStation
//!   Linux   → $XDG_DATA_HOME/KitStation (fallback ~/.local/share/KitStation)

use std::path::PathBuf;

pub fn app_data_dir() -> PathBuf {
    let base = dirs_minimal::data_local_dir()
        .unwrap_or_else(|| std::env::temp_dir());
    let dir = base.join("KitStation");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

pub fn kits_dir() -> PathBuf {
    let d = app_data_dir().join("kits");
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn virus_presets_dir() -> PathBuf {
    let d = app_data_dir().join("virus-presets");
    let _ = std::fs::create_dir_all(&d);
    d
}

// Tiny inline resolver — Tauri gives us `app.path()` once there's an
// AppHandle, but we need paths before any command runs too (e.g. for
// logging). This avoids pulling in the whole `dirs` crate.
mod dirs_minimal {
    use std::path::PathBuf;
    pub fn data_local_dir() -> Option<PathBuf> {
        #[cfg(target_os = "windows")]
        { std::env::var_os("LOCALAPPDATA").map(PathBuf::from) }
        #[cfg(target_os = "macos")]
        { std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support")) }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::env::var_os("XDG_DATA_HOME").map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        }
    }
}

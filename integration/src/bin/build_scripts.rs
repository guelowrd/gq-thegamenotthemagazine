//! Assembles the prize and shot note scripts and writes them, serialized, where the web app
//! loads them from (`web/public/scripts/`). Prints the script roots.
//!
//! Run from the repo root after editing anything under `masm/`:
//!   cargo run --release --bin build_scripts

use std::path::Path;

use anyhow::Result;
use integration::scripts::{shot_script, record_script};
use miden_client::utils::Serializable;

fn main() -> Result<()> {
    let out = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../web/public/scripts"));
    std::fs::create_dir_all(out)?;
    for (name, script) in [("record", record_script()?), ("shot", shot_script()?)] {
        let path = out.join(format!("{name}.bin"));
        std::fs::write(&path, script.to_bytes())?;
        println!("{name:<10} root {}  -> {}", script.root(), path.display());
    }
    Ok(())
}

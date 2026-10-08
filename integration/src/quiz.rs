//! Deterministic quiz selection and dataset identity. Mirrors `web/src/lib/quiz.ts`; the two are
//! checked against `rules/quiz_vectors.json`.

use miden_client::Word;
use sha2::{Digest, Sha256};

use crate::{
    felt,
    rules::{City, ROUNDS},
};

/// A seed's byte form: its four field elements as u64 little-endian.
pub fn seed_bytes(seed: Word) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, f) in seed.as_elements().iter().enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&f.as_canonical_u64().to_le_bytes());
    }
    out
}

/// `sha256(seed_bytes || counter as u32 BE)`, first 4 bytes as u32 BE, mod the dataset size,
/// skipping repeats, until ROUNDS distinct indices are found.
pub fn pick_indices(seed: Word, dataset_size: u32) -> [u32; ROUNDS] {
    let bytes = seed_bytes(seed);
    let mut picked = Vec::with_capacity(ROUNDS);
    let mut counter: u32 = 0;
    while picked.len() < ROUNDS {
        let mut h = Sha256::new();
        h.update(bytes);
        h.update(counter.to_be_bytes());
        let d = h.finalize();
        let idx = u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % dataset_size;
        if !picked.contains(&idx) {
            picked.push(idx);
        }
        counter += 1;
    }
    picked.try_into().unwrap()
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Place {
    pub name: String,
    pub country: String,
    pub lat: f64,
    pub lon: f64,
}

pub fn lat_to_cd(lat: f64) -> u32 {
    ((lat + 90.0) * 100.0).round() as u32
}
pub fn lon_to_cd(lon: f64) -> u32 {
    ((((lon + 180.0) * 100.0).round() as i64 + 36000) % 36000) as u32
}
pub fn cos_x100(lat: f64) -> u32 {
    (lat.to_radians().cos() * 100.0).round() as u32
}

pub fn quiz_cities(seed: Word, dataset: &[Place]) -> [City; ROUNDS] {
    pick_indices(seed, dataset.len() as u32).map(|idx| {
        let p = &dataset[idx as usize];
        City { idx, lat: lat_to_cd(p.lat), lon: lon_to_cd(p.lon), cos: cos_x100(p.lat) }
    })
}

/// Dataset identity: sha256 of the exact file bytes, first 16 bytes as four u32 little-endian.
pub fn dataset_word(file_bytes: &[u8]) -> Word {
    let d = Sha256::digest(file_bytes);
    let u = |i: usize| felt(u32::from_le_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]) as u64);
    Word::new([u(0), u(4), u(8), u(12)])
}

pub fn load_dataset() -> anyhow::Result<(Vec<Place>, Word)> {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../web/public/cities.json"))?;
    Ok((serde_json::from_slice(&bytes)?, dataset_word(&bytes)))
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct QuizVector {
    /// decimal strings: u64 seeds do not survive JSON number parsing in JavaScript
    pub seed: [String; 4],
    pub dataset_size: u32,
    pub indices: [u32; ROUNDS],
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(a: [u64; 4]) -> Word {
        Word::new(a.map(felt))
    }

    #[test]
    fn indices_are_distinct_and_in_range() {
        for s in 0..50u64 {
            let idx = pick_indices(w([s, 7, 11, 13]), 243);
            let mut sorted = idx.to_vec();
            sorted.sort();
            sorted.dedup();
            assert_eq!(sorted.len(), ROUNDS, "seed {s}");
            assert!(idx.iter().all(|&i| i < 243));
        }
    }

    #[test]
    fn write_quiz_vectors_json() {
        let vectors: Vec<QuizVector> = [[0u64, 0, 0, 0], [1, 2, 3, 4], [u64::MAX >> 1, 42, 0, 9]]
            .into_iter()
            .map(|seed| QuizVector { seed: seed.map(|v| v.to_string()), dataset_size: 243, indices: pick_indices(w(seed), 243) })
            .collect();
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../rules/quiz_vectors.json");
        std::fs::write(path, serde_json::to_string_pretty(&vectors).unwrap() + "\n").unwrap();
    }

    #[test]
    fn dataset_loads_and_hashes() {
        let (places, word) = load_dataset().unwrap();
        assert_eq!(places.len(), 243);
        assert_ne!(word, Word::default());
        let paris = places.iter().find(|p| p.name == "Paris").unwrap();
        assert!((48.8..49.0).contains(&paris.lat) && (2.2..2.5).contains(&paris.lon));
        assert_eq!((lat_to_cd(48.85), lon_to_cd(2.35), cos_x100(48.85)), (13885, 18235, 66));
        assert_eq!(lon_to_cd(-179.999), 0);
    }
}

//! GeoQuizz scoring, rules version 2. Host-side reference implementation.
//!
//! The on-chain truth is `masm/games/gq_score.masm`; the MockChain tests assert that the MASM
//! procedure agrees with this module on every vector in `rules/vectors.json`, and the web app's
//! `lib/rules.ts` is tested against the same file.
//!
//! Coordinates are centi-degrees shifted to be non-negative:
//! `lat_cd = round((lat + 90) * 100)` in `0..=18000`, `lon_cd = round((lon + 180) * 100)` in
//! `0..36000`. Time is in units of 10 ms, capped at 1500 (15 s).
//!
//! One round scores `accuracy + speed` with a closeness `a` in per-mille that falls off as
//! `exp(-distance / 500 km)`:
//!   accuracy = 850 * a / 1000
//!   speed    = 150 * a * (1500 - t) / (1000 * 1500)
//! so a perfect, instant answer is 1000 and a quiz of ten is 10 000. The distance is the flat
//! approximation `sqrt(dlat² + (dlon * cos)²)` in centi-degrees (1 cd ≈ 1.112 km), and `a` comes
//! from a table of 128 bands of 25 cd (≈ 27.8 km): band `i` is `d2 <= ((i + 1) * 25)²` and
//! scores `round(1000 * exp(-i * 25 * 1.11195 / 500))`. Beyond the table `a` is 0.

use miden_client::{note::NoteStorage, Felt, Word};

pub const RULES_VERSION: u32 = 2;
pub const ROUNDS: usize = 10;
pub const LON_WRAP: u32 = 36000;
pub const TIME_CAP: u32 = 1500;
/// Band width in centi-degrees.
pub const BAND_CD: u32 = 25;
/// Kilometres per centi-degree of great circle, the only place the curve meets the real Earth.
pub const KM_PER_CD: f64 = 1.11195;
pub const ACCURACY_MAX: u32 = 850;
pub const SPEED_MAX: u32 = 150;
pub const ROUND_MAX: u32 = ACCURACY_MAX + SPEED_MAX;
pub const QUIZ_MAX: u32 = ROUND_MAX * ROUNDS as u32;

/// Closeness per band, in per-mille: `round(1000 * exp(-i * BAND_CD * KM_PER_CD / 500))`.
/// Pinned by `exp_table_is_the_curve`; copied verbatim into the MASM and TypeScript mirrors.
#[rustfmt::skip]
pub const EXP_MILLI: [u32; 128] = [
    1000, 946, 895, 846, 801, 757, 716, 678, 641, 606, 574, 542, 513, 485, 459, 434,
    411, 389, 368, 348, 329, 311, 294, 278, 263, 249, 236, 223, 211, 199, 189, 178,
    169, 160, 151, 143, 135, 128, 121, 114, 108, 102, 97, 92, 87, 82, 77, 73,
    69, 66, 62, 59, 56, 53, 50, 47, 44, 42, 40, 38, 36, 34, 32, 30,
    28, 27, 25, 24, 23, 22, 20, 19, 18, 17, 16, 15, 15, 14, 13, 12,
    12, 11, 10, 10, 9, 9, 8, 8, 8, 7, 7, 6, 6, 6, 5, 5,
    5, 5, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
];

/// A city as stored in the note: index into the dataset plus its truth.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct City {
    pub idx: u32,
    pub lat: u32,
    pub lon: u32,
    /// `round(cos(latitude) * 100)`, in `0..=100`
    pub cos: u32,
}

/// One answered round, as the player's client submits it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Answer {
    pub lat: u32,
    pub lon: u32,
    /// 10 ms units
    pub t: u32,
}

/// Squared flat distance between the city and the answer, in centi-degrees².
pub fn distance2(city: City, a: Answer) -> u32 {
    let dlat = city.lat.abs_diff(a.lat);
    let raw = city.lon.abs_diff(a.lon);
    let dlon = raw.min(LON_WRAP - raw) * city.cos / 100;
    dlat * dlat + dlon * dlon
}

/// Closeness in per-mille for a squared distance: the first band that contains it.
pub fn closeness(d2: u32) -> u32 {
    (0..EXP_MILLI.len() as u32)
        .find(|i| d2 <= ((i + 1) * BAND_CD).pow(2))
        .map_or(0, |i| EXP_MILLI[i as usize])
}

pub fn round_score(city: City, a: Answer) -> u32 {
    let closeness = closeness(distance2(city, a));
    let accuracy = ACCURACY_MAX * closeness / 1000;
    let speed = SPEED_MAX * closeness * (TIME_CAP - a.t.min(TIME_CAP)) / (1000 * TIME_CAP);
    accuracy + speed
}

pub fn quiz_score(cities: &[City; ROUNDS], answers: &[Answer; ROUNDS]) -> u32 {
    cities
        .iter()
        .zip(answers)
        .map(|(c, a)| round_score(*c, *a))
        .sum()
}

/// `felt = lat << 32 | (lon * 2048 + t)`. Fits a field element: `lat <= 18000`.
pub fn pack_round(a: Answer) -> u64 {
    assert!(a.lat <= 18000 && a.lon < LON_WRAP && a.t < 2048, "answer out of range");
    (a.lat as u64) << 32 | (a.lon as u64 * 2048 + a.t as u64)
}

pub fn unpack_round(v: u64) -> Answer {
    let lo = v as u32;
    Answer {
        lat: (v >> 32) as u32,
        lon: lo / 2048,
        t: lo % 2048,
    }
}

/// The answers as they travel in the advice map: one field element per round.
pub fn pack_answers(answers: &[Answer; ROUNDS]) -> [u64; ROUNDS] {
    answers.map(pack_round)
}

/// The note argument: the commitment to the packed answers, the same hash a note storage of those
/// felts would have (`note::compute_storage_commitment` on chain).
pub fn answer_commitment(answers: &[Answer; ROUNDS]) -> Word {
    let felts: Vec<Felt> = pack_answers(answers).iter().map(|&v| crate::felt(v)).collect();
    NoteStorage::new(felts).expect("ten items").commitment()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARIS: City = City { idx: 0, lat: 13885, lon: 18235, cos: 66 }; // 48.85N 2.35E

    fn ans(lat: u32, lon: u32, t: u32) -> Answer {
        Answer { lat, lon, t }
    }

    #[test]
    fn exp_table_is_the_curve() {
        for (i, &a) in EXP_MILLI.iter().enumerate() {
            let km = i as f64 * BAND_CD as f64 * KM_PER_CD;
            assert_eq!(a, (1000.0 * (-km / 500.0).exp()).round() as u32, "band {i}");
        }
        assert_eq!(ROUND_MAX, 1000);
        assert_eq!(QUIZ_MAX, 10_000);
    }

    #[test]
    fn exact_and_instant_is_round_max() {
        assert_eq!(round_score(PARIS, ans(13885, 18235, 0)), ROUND_MAX);
    }

    #[test]
    fn speed_falls_linearly_to_zero_at_the_cap() {
        assert_eq!(round_score(PARIS, ans(13885, 18235, 750)), 850 + 75);
        assert_eq!(round_score(PARIS, ans(13885, 18235, 1500)), 850);
        // beyond the cap counts as the cap
        assert_eq!(round_score(PARIS, ans(13885, 18235, 2047)), 850);
    }

    #[test]
    fn band_edges_on_latitude() {
        // cos only scales longitude, so pure-latitude misses hit the bands exactly
        assert_eq!(round_score(PARIS, ans(13885 + 25, 18235, 1500)), 850); // band 0
        assert_eq!(round_score(PARIS, ans(13885 + 26, 18235, 1500)), 850 * 946 / 1000); // band 1
        assert_eq!(round_score(PARIS, ans(13885 - 50, 18235, 1500)), 850 * 946 / 1000);
        assert_eq!(round_score(PARIS, ans(13885 - 51, 18235, 1500)), 850 * 895 / 1000); // band 2
        // 500 km ≈ 450 cd: band 17
        assert_eq!(closeness(450 * 450), EXP_MILLI[17]);
        assert_eq!(round_score(PARIS, ans(13885 + 450, 18235, 0)), 850 * 389 / 1000 + 150 * 389 / 1000);
        // the last band, then nothing
        assert_eq!(closeness(3200 * 3200), 1);
        assert_eq!(closeness(3200 * 3200 + 1), 0);
        assert_eq!(round_score(PARIS, ans(13885 + 3201, 18235, 0)), 0);
    }

    #[test]
    fn a_far_miss_scores_nothing_however_fast() {
        assert_eq!(round_score(PARIS, ans(0, 0, 0)), 0);
    }

    #[test]
    fn longitude_is_scaled_by_cos() {
        // 37 centi-degrees east at Paris = 37 * 66 / 100 = 24 -> band 0
        assert_eq!(round_score(PARIS, ans(13885, 18235 + 37, 1500)), 850);
        // 39 * 66 / 100 = 25 -> band 0; 40 * 66 / 100 = 26 -> band 1
        assert_eq!(round_score(PARIS, ans(13885, 18235 + 39, 1500)), 850);
        assert_eq!(round_score(PARIS, ans(13885, 18235 + 40, 1500)), 850 * 946 / 1000);
    }

    #[test]
    fn antimeridian_wraps() {
        let fiji = City { idx: 1, lat: 7200, lon: 35800, cos: 95 }; // 18S 178E
        // 300 centi-degrees further east wraps to lon 100: dlon = 300 * 95 / 100 = 285 -> band 11
        assert_eq!(round_score(fiji, ans(7200, 100, 1500)), 850 * EXP_MILLI[11] / 1000);
        // and the long way round is never used
        assert_eq!(round_score(fiji, ans(7200, 35800, 1500)), 850);
    }

    #[test]
    fn extremes_do_not_overflow_u32() {
        let pole = City { idx: 2, lat: 18000, lon: 0, cos: 0 };
        assert_eq!(round_score(pole, ans(0, 35999, 0)), 0);
        let eq = City { idx: 3, lat: 9000, lon: 0, cos: 100 };
        assert_eq!(round_score(eq, ans(18000, 18000, 0)), 0);
    }

    #[test]
    fn pack_round_trips() {
        for a in [ans(0, 0, 0), ans(18000, 35999, 2047), ans(13885, 18235, 437)] {
            assert_eq!(unpack_round(pack_round(a)), a);
        }
        assert_eq!(pack_round(ans(1, 2, 3)), (1u64 << 32) | (2 * 2048 + 3));
    }

    #[test]
    fn quiz_sums_rounds() {
        let cities = [PARIS; ROUNDS];
        let answers = [ans(13885, 18235, 0); ROUNDS];
        assert_eq!(quiz_score(&cities, &answers), QUIZ_MAX);
    }
}

/// One scoring test vector shared with the MASM and TypeScript tests.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct Vector {
    pub name: String,
    pub cities: [City; ROUNDS],
    pub answers: [Answer; ROUNDS],
    /// decimal strings: u64 values do not survive JSON number parsing in JavaScript
    pub packed: [String; ROUNDS],
    /// the note argument, as its hex
    pub commitment: String,
    pub score: u32,
}

pub const VECTOR_CITIES: [City; ROUNDS] = [
    City { idx: 0, lat: 13885, lon: 18235, cos: 66 }, // Paris 48.85N 2.35E
    City { idx: 1, lat: 6709, lon: 13683, cos: 92 },  // Rio de Janeiro 22.91S 43.17W
    City { idx: 2, lat: 12569, lon: 31969, cos: 81 }, // Tokyo 35.69N 139.69E
    City { idx: 3, lat: 5607, lon: 19842, cos: 83 },  // Cape Town 33.93S 18.42E
    City { idx: 4, lat: 7200, lon: 35800, cos: 95 },  // Suva 18S 178E
    City { idx: 5, lat: 9000, lon: 18000, cos: 100 }, // Null Island 0 0
    City { idx: 6, lat: 15411, lon: 15810, cos: 44 }, // Reykjavik 64.11N 21.90W
    City { idx: 7, lat: 8871, lon: 21682, cos: 100 }, // Nairobi 1.29S 36.82E
    City { idx: 8, lat: 7795, lon: 10297, cos: 98 },  // Lima 12.05S 77.03W
    City { idx: 9, lat: 5613, lon: 33121, cos: 83 },  // Sydney 33.87S 151.21E
];

pub fn vectors() -> Vec<Vector> {
    let cities = VECTOR_CITIES;
    let mk = |name: &str, answers: [Answer; ROUNDS]| Vector {
        name: name.into(),
        cities,
        packed: pack_answers(&answers).map(|v| v.to_string()),
        commitment: answer_commitment(&answers).to_hex(),
        score: quiz_score(&cities, &answers),
        answers,
    };
    let a = |lat: u32, lon: u32, t: u32| Answer { lat, lon, t };
    let mut mixed = cities.map(|c| a(c.lat, c.lon, 1500));
    mixed[0] = a(13885 + 25, 18235, 0); // band 0, instant: 1000
    mixed[1] = a(6709, 13683 + 55, 750); // dlon = 55*92/100 = 50 -> band 1: 804 + 70
    mixed[2] = a(12569 - 450, 31969, 300); // band 17: 330 + 46
    mixed[3] = a(5607, 19842 + 3900, 10); // dlon = 3900*83/100 = 3237 -> beyond: 0
    mixed[4] = a(7200, 100, 1499); // wraps: dlon 300*95/100 = 285 -> band 11: 460 + 0
    vec![
        mk("perfect_instant", cities.map(|c| a(c.lat, c.lon, 0))),
        mk("perfect_at_the_cap", cities.map(|c| a(c.lat, c.lon, 1500))),
        mk("all_missed", cities.map(|c| a((c.lat + 9000) % 18000, (c.lon + 18000) % 36000, 50))),
        mk("mixed_bands", mixed),
    ]
}

#[cfg(test)]
mod vector_tests {
    use super::*;

    #[test]
    fn write_vectors_json() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../rules/vectors.json");
        let json = serde_json::to_string_pretty(&vectors()).unwrap();
        std::fs::write(path, json + "\n").unwrap();
    }

    #[test]
    fn vector_scores_are_as_designed() {
        let v: std::collections::HashMap<_, _> =
            vectors().into_iter().map(|v| (v.name.clone(), v.score)).collect();
        assert_eq!(v["perfect_instant"], QUIZ_MAX);
        assert_eq!(v["perfect_at_the_cap"], 8500);
        assert_eq!(v["all_missed"], 0);
        assert_eq!(v["mixed_bands"], 1000 + 874 + 376 + 0 + 460 + 5 * 850);
    }
}

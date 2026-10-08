//! GeoQuiz scoring, rules version 1. Host-side reference implementation.
//!
//! The on-chain truth is `masm/games/gq_score.masm`; the MockChain tests assert that the MASM
//! procedure agrees with this module on every vector in `rules/vectors.json`, and the web app's
//! `lib/rules.ts` is tested against the same file.
//!
//! Coordinates are centi-degrees shifted to be non-negative:
//! `lat_cd = round((lat + 90) * 100)` in `0..=18000`, `lon_cd = round((lon + 180) * 100)` in
//! `0..36000`. Time is in units of 10 ms, capped by the client at 1500 (15 s).

pub const RULES_VERSION: u32 = 1;
pub const ROUNDS: usize = 4;
pub const LON_WRAP: u32 = 36000;
pub const TIME_CAP: u32 = 1500;

/// (max squared distance in centi-degrees², points)
pub const DISTANCE_BANDS: [(u32, u32); 4] = [
    (100 * 100, 1000),
    (300 * 300, 700),
    (800 * 800, 400),
    (2000 * 2000, 150),
];
/// (max time in 10 ms units, bonus), only awarded when distance points are non-zero
pub const SPEED_BANDS: [(u32, u32); 3] = [(300, 300), (600, 200), (1000, 100)];
pub const ROUND_MAX: u32 = 1300;
pub const QUIZ_MAX: u32 = ROUND_MAX * ROUNDS as u32;

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

pub fn round_score(city: City, a: Answer) -> u32 {
    let dlat = city.lat.abs_diff(a.lat);
    let raw = city.lon.abs_diff(a.lon);
    let dlon = raw.min(LON_WRAP - raw) * city.cos / 100;
    let d2 = dlat * dlat + dlon * dlon;
    let dist = DISTANCE_BANDS
        .iter()
        .find(|(max, _)| d2 <= *max)
        .map_or(0, |(_, pts)| *pts);
    if dist == 0 {
        return 0;
    }
    let speed = SPEED_BANDS
        .iter()
        .find(|(max, _)| a.t <= *max)
        .map_or(0, |(_, pts)| *pts);
    dist + speed
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

/// The note argument: one field element per round.
pub fn pack_answers(answers: &[Answer; ROUNDS]) -> [u64; ROUNDS] {
    answers.map(pack_round)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARIS: City = City { idx: 0, lat: 13885, lon: 18235, cos: 66 }; // 48.85N 2.35E

    fn ans(lat: u32, lon: u32, t: u32) -> Answer {
        Answer { lat, lon, t }
    }

    #[test]
    fn exact_and_fast_is_round_max() {
        assert_eq!(round_score(PARIS, ans(13885, 18235, 0)), ROUND_MAX);
        assert_eq!(round_score(PARIS, ans(13885, 18235, 300)), 1300);
    }

    #[test]
    fn speed_band_edges() {
        assert_eq!(round_score(PARIS, ans(13885, 18235, 301)), 1200);
        assert_eq!(round_score(PARIS, ans(13885, 18235, 600)), 1200);
        assert_eq!(round_score(PARIS, ans(13885, 18235, 601)), 1100);
        assert_eq!(round_score(PARIS, ans(13885, 18235, 1000)), 1100);
        assert_eq!(round_score(PARIS, ans(13885, 18235, 1001)), 1000);
        assert_eq!(round_score(PARIS, ans(13885, 18235, TIME_CAP)), 1000);
    }

    #[test]
    fn distance_band_edges_on_latitude() {
        // cos only scales longitude, so pure-latitude misses hit the bands exactly
        assert_eq!(round_score(PARIS, ans(13885 + 100, 18235, 2000)), 1000);
        assert_eq!(round_score(PARIS, ans(13885 + 101, 18235, 2000)), 700);
        assert_eq!(round_score(PARIS, ans(13885 - 300, 18235, 2000)), 700);
        assert_eq!(round_score(PARIS, ans(13885 - 301, 18235, 2000)), 400);
        assert_eq!(round_score(PARIS, ans(13885 + 800, 18235, 2000)), 400);
        assert_eq!(round_score(PARIS, ans(13885 + 801, 18235, 2000)), 150);
        assert_eq!(round_score(PARIS, ans(13885 - 2000, 18235, 2000)), 150);
        assert_eq!(round_score(PARIS, ans(13885 - 2001, 18235, 2000)), 0);
    }

    #[test]
    fn miss_gets_no_speed_bonus() {
        assert_eq!(round_score(PARIS, ans(0, 0, 0)), 0);
    }

    #[test]
    fn longitude_is_scaled_by_cos() {
        // 150 centi-degrees east at Paris = 150 * 66 / 100 = 99 -> still band 1
        assert_eq!(round_score(PARIS, ans(13885, 18235 + 150, 2000)), 1000);
        // 153 * 66 / 100 = 100 -> band 1; 154 * 66 / 100 = 101 -> band 2
        assert_eq!(round_score(PARIS, ans(13885, 18235 + 153, 2000)), 1000);
        assert_eq!(round_score(PARIS, ans(13885, 18235 + 154, 2000)), 700);
    }

    #[test]
    fn antimeridian_wraps() {
        let fiji = City { idx: 1, lat: 7200, lon: 35800, cos: 95 }; // 18S 178E
        // 300 centi-degrees further east wraps to lon 100
        assert_eq!(round_score(fiji, ans(7200, 100, 2000)), 700);
        // and the long way round is never used
        assert_eq!(round_score(fiji, ans(7200, 35800, 2000)), 1000);
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
    pub packed: [u64; ROUNDS],
    pub score: u32,
}

pub fn vectors() -> Vec<Vector> {
    let cities = [
        City { idx: 0, lat: 13885, lon: 18235, cos: 66 }, // Paris 48.85N 2.35E
        City { idx: 1, lat: 6709, lon: 13683, cos: 92 },  // Rio de Janeiro 22.91S 43.17W
        City { idx: 2, lat: 12569, lon: 31969, cos: 81 }, // Tokyo 35.69N 139.69E
        City { idx: 3, lat: 5607, lon: 19842, cos: 83 },  // Cape Town 33.93S 18.42E
    ];
    let mk = |name: &str, answers: [Answer; ROUNDS]| Vector {
        name: name.into(),
        cities,
        packed: pack_answers(&answers),
        score: quiz_score(&cities, &answers),
        answers,
    };
    let a = |lat: u32, lon: u32, t: u32| Answer { lat, lon, t };
    vec![
        mk("perfect_fast", cities.map(|c| a(c.lat, c.lon, 100))),
        mk("perfect_slow", cities.map(|c| a(c.lat, c.lon, 1400))),
        mk("all_missed", cities.map(|c| a((c.lat + 9000) % 18000, (c.lon + 18000) % 36000, 50))),
        mk(
            "mixed_bands",
            [
                a(13885 + 50, 18235, 250),   // 1000 + 300
                a(6709, 13683 + 250, 650),   // dlon = 250*92/100 = 230 -> 700 + 100
                a(12569 - 700, 31969, 1200), // 400 + 0
                a(5607, 19842 + 2300, 10),   // dlon = 2300*83/100 = 1909 -> 150 + 300
            ],
        ),
        mk(
            "antimeridian",
            [
                a(13885, 18235, 0),
                a(6709, 13683, 0),
                a(12569, (31969 + 4100) % 36000, 0), // wraps: dlon_raw 4100 -> *81/100 = 3321 -> 0
                a(5607, 19842, 0),
            ],
        ),
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
        assert_eq!(v["perfect_fast"], QUIZ_MAX);
        assert_eq!(v["perfect_slow"], 4000);
        assert_eq!(v["all_missed"], 0);
        assert_eq!(v["mixed_bands"], 1300 + 800 + 400 + 450);
        assert_eq!(v["antimeridian"], 1300 * 3);
    }
}

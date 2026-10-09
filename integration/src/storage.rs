//! Host-side view of the shot note storage (`masm/shot/challenge_core.masm`).
//!
//! Both the record note and the shot note use this 64-felt layout; a shot note is its
//! record note's storage with `rival`, `shot_deadline` and `record_id` filled in.
//! Layout: champion(2) target min_stake expiry | rival(2) shot_deadline | RECORD_ID(4) |
//! SHOT_ROOT(4) | game data(48).

use miden_client::{account::AccountId, note::NoteId, Felt, Word};

use crate::{felt, rules::{City, ROUNDS}};

pub const NUM_STORAGE_ITEMS: usize = 64;
pub const GAME_DATA_LEN: usize = 8 + 4 * ROUNDS;
pub const SHOT_DEADLINE_INDEX: usize = 7;

/// Game-specific payload (48 felts): seed, dataset hash, ten cities.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GqGameData {
    pub seed: Word,
    pub dataset: Word,
    pub cities: [City; ROUNDS],
}

impl GqGameData {
    pub fn to_felts(&self) -> [Felt; GAME_DATA_LEN] {
        let mut out = [felt(0); GAME_DATA_LEN];
        out[..4].copy_from_slice(self.seed.as_elements());
        out[4..8].copy_from_slice(self.dataset.as_elements());
        for (i, c) in self.cities.iter().enumerate() {
            let base = 8 + 4 * i;
            out[base] = felt(c.idx as u64);
            out[base + 1] = felt(c.lat as u64);
            out[base + 2] = felt(c.lon as u64);
            out[base + 3] = felt(c.cos as u64);
        }
        out
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChallengeStorage {
    pub expiry_block: u32,
    pub target: u32,
    pub min_stake: u64,
    pub champion: AccountId,
    /// `None` in a record note.
    pub rival: Option<AccountId>,
    /// Zero in a record note.
    pub record_id: Word,
    pub shot_root: Word,
    pub game: [Felt; GAME_DATA_LEN],
    /// Block by which the rival must settle; zero in a record note. A shot is settleable
    /// before `min(shot_deadline, expiry_block)`.
    pub shot_deadline: u32,
}

impl ChallengeStorage {
    /// The record note's storage.
    pub fn record(
        expiry_block: u32,
        target: u32,
        min_stake: u64,
        champion: AccountId,
        shot_root: Word,
        game: [Felt; GAME_DATA_LEN],
    ) -> Self {
        Self {
            expiry_block,
            target,
            min_stake,
            champion,
            rival: None,
            record_id: Word::default(),
            shot_root,
            game,
            shot_deadline: 0,
        }
    }

    /// The shot note's storage for `rival` against the record note `record_id`, settleable
    /// until `deadline`.
    pub fn shot_for(&self, rival: AccountId, record_id: NoteId, deadline: u32) -> Self {
        Self {
            rival: Some(rival),
            record_id: record_id.as_word(),
            shot_deadline: deadline,
            ..self.clone()
        }
    }

    pub fn to_felts(&self) -> Vec<Felt> {
        let (rival_suffix, rival_prefix) = match self.rival {
            Some(id) => (id.suffix(), Felt::from(id.prefix())),
            None => (felt(0), felt(0)),
        };
        let mut v = vec![
            self.champion.suffix(),
            Felt::from(self.champion.prefix()),
            felt(self.target as u64),
            felt(self.min_stake),
            felt(self.expiry_block as u64),
            rival_suffix,
            rival_prefix,
            felt(self.shot_deadline as u64),
        ];
        v.extend_from_slice(self.record_id.as_elements());
        v.extend_from_slice(self.shot_root.as_elements());
        v.extend_from_slice(&self.game);
        debug_assert_eq!(v.len(), NUM_STORAGE_ITEMS);
        v
    }
}

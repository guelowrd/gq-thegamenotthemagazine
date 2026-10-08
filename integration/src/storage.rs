//! Host-side view of the challenge note storage (`masm/challenge/challenge_core.masm`).
//!
//! Both the prize note and the challenge note use this 44-felt layout; a challenge note is its
//! prize note's storage with `player`, `prize_id` and `challenge_deadline` filled in.

use miden_client::{account::AccountId, note::NoteId, Felt, Word};

use crate::{felt, rules::{City, ROUNDS}};

pub const STORAGE_VERSION: u64 = 1;
pub const NUM_STORAGE_ITEMS: usize = 44;
pub const GAME_DATA_LEN: usize = 24;
pub const CHALLENGE_DEADLINE_INDEX: usize = 40;

/// Game-specific payload (24 felts): seed, dataset hash, four cities.
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
    /// `None` in a prize note.
    pub player: Option<AccountId>,
    /// Zero in a prize note.
    pub prize_id: Word,
    pub challenge_root: Word,
    pub game: [Felt; GAME_DATA_LEN],
    /// Block by which the player must settle; zero in a prize note. A challenge is settleable
    /// before `min(challenge_deadline, expiry_block)`.
    pub challenge_deadline: u32,
}

impl ChallengeStorage {
    /// The prize note's storage.
    pub fn prize(
        expiry_block: u32,
        target: u32,
        min_stake: u64,
        champion: AccountId,
        challenge_root: Word,
        game: [Felt; GAME_DATA_LEN],
    ) -> Self {
        Self {
            expiry_block,
            target,
            min_stake,
            champion,
            player: None,
            prize_id: Word::default(),
            challenge_root,
            game,
            challenge_deadline: 0,
        }
    }

    /// The challenge note's storage for `player` against the prize note `prize_id`, settleable
    /// until `deadline`.
    pub fn challenge_for(&self, player: AccountId, prize_id: NoteId, deadline: u32) -> Self {
        Self {
            player: Some(player),
            prize_id: prize_id.as_word(),
            challenge_deadline: deadline,
            ..self.clone()
        }
    }

    pub fn to_felts(&self) -> Vec<Felt> {
        let (player_suffix, player_prefix) = match self.player {
            Some(id) => (id.suffix(), Felt::from(id.prefix())),
            None => (felt(0), felt(0)),
        };
        let mut v = vec![
            felt(STORAGE_VERSION),
            felt(self.expiry_block as u64),
            felt(self.target as u64),
            felt(self.min_stake),
            self.champion.suffix(),
            Felt::from(self.champion.prefix()),
            player_suffix,
            player_prefix,
        ];
        v.extend_from_slice(self.prize_id.as_elements());
        v.extend_from_slice(self.challenge_root.as_elements());
        v.extend_from_slice(&self.game);
        v.extend_from_slice(&[felt(self.challenge_deadline as u64), felt(0), felt(0), felt(0)]);
        debug_assert_eq!(v.len(), NUM_STORAGE_ITEMS);
        v
    }
}

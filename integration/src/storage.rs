//! Host-side view of the challenge note storage (`masm/challenge/challenge_core.masm`).
//!
//! Both the prize note and the challenge note use this 64-felt layout; a challenge note is its
//! prize note's storage with `player`, `challenge_deadline` and `prize_id` filled in.
//! Layout: champion(2) target min_stake expiry | player(2) challenge_deadline | PRIZE_ID(4) |
//! CHALLENGE_ROOT(4) | game data(48).

use miden_client::{account::AccountId, note::NoteId, Felt, Word};

use crate::{felt, rules::{City, ROUNDS}};

pub const NUM_STORAGE_ITEMS: usize = 64;
pub const GAME_DATA_LEN: usize = 8 + 4 * ROUNDS;
pub const CHALLENGE_DEADLINE_INDEX: usize = 7;

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
            self.champion.suffix(),
            Felt::from(self.champion.prefix()),
            felt(self.target as u64),
            felt(self.min_stake),
            felt(self.expiry_block as u64),
            player_suffix,
            player_prefix,
            felt(self.challenge_deadline as u64),
        ];
        v.extend_from_slice(self.prize_id.as_elements());
        v.extend_from_slice(self.challenge_root.as_elements());
        v.extend_from_slice(&self.game);
        debug_assert_eq!(v.len(), NUM_STORAGE_ITEMS);
        v
    }
}

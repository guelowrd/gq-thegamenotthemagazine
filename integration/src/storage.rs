//! The challenge mechanic's note storage, host side (`masm/challenge/challenge_core.masm`).
//!
//! A record note and its shot notes share one layout: a 16-felt header the core owns, then the
//! game's data in whole words, any length. A shot note is its record note's storage with `rival`,
//! `shot_deadline` and `record_id` filled in; that is how the record recognises its shots.
//! Header: champion(2) target min_stake expiry | rival(2) shot_deadline | RECORD_ID(4) | SHOT_ROOT(4).

use miden_client::{account::AccountId, note::NoteId, Felt, Word};

use crate::felt;

pub const HEADER_ITEMS: usize = 16;
pub const SHOT_DEADLINE_INDEX: usize = 7;

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
    /// The game's own data, whole words (GeoQuizz: `quiz::GqGameData`).
    pub game: Vec<Felt>,
    /// Block by which the rival must settle; zero in a record note. A shot is settleable
    /// before `min(shot_deadline, expiry_block)`.
    pub shot_deadline: u32,
}

impl ChallengeStorage {
    /// The record note's storage.
    pub fn record(expiry_block: u32, target: u32, min_stake: u64, champion: AccountId, shot_root: Word, game: Vec<Felt>) -> Self {
        assert!(game.len().is_multiple_of(4), "game data must be whole words");
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
        v
    }
}

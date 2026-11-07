# The five stages for the link preview: id -> the card's title. Mirrors src/lib/stages.ts.
STAGES = {"world": "WORLD TOUR", "america": "AMERICA", "africa": "AFRICA", "europe": "EUROPE", "asia": "ASIA"}


def stage(m):
    """The stage's (id, title) for a link's `m`, the World Tour when it is missing or unknown."""
    m = m if m in STAGES else "world"
    return m, STAGES[m]


def score(s):
    """The link's score as an int, None when missing or not a plausible score."""
    try:
        n = int(s)
    except (TypeError, ValueError):
        return None
    return n if 0 <= n <= 99_999 else None

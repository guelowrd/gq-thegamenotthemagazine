# The link preview of a record, 1200 x 628, one of three arcade screens picked by the record id (so a record keeps its
# card): ARCADE (CAN YOU BEAT, the score huge, the champion's arcade name), TABLE (CAN YOU DO BETTER: 1ST the champion, 2ND YOU
# ????) and VERSUS (the champion against you, VS between). Over the stage's pixel map (a World Tour record gets the splash's
# globe half the time), dimmed, fading to black at the bottom where X paints the post's title. The wordmark, the stage in a cyan box, INSERT 1 GAMECOIN TO PLAY, the boy or the
# girl of the splash (also by the record id), the TV pass and the splash's cyan and pink frame. Query: s (score), m (stage
# id), n (champion name), r (record id).
import hashlib, os, sys
from http.server import BaseHTTPRequestHandler
from io import BytesIO
from urllib.parse import parse_qs, urlparse
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

sys.path.insert(0, os.getcwd())
from og.stages import score as parse_score, stage as parse_stage

OG = os.path.join(os.getcwd(), "og")
W, H = 1200, 628
VOID, CYAN, YELLOW, PINK, WHITE = (12, 8, 39, 255), (64, 228, 255, 255), (255, 232, 59, 255), (255, 44, 156, 255), (255, 247, 244, 255)
FONT = lambda size: ImageFont.truetype(os.path.join(OG, "geoquizz-pixel.ttf"), size)
SAFE = 540  # below this X's title band may cover the card: nothing to read there


def rng(seed):
    """Deterministic picks over the record id, ints in [0, n), each from its own byte of the id's hash (independent of each other)."""
    h, i = hashlib.sha256(seed.encode()).digest(), 0

    def pick(n):
        nonlocal i
        i += 1
        return h[i - 1] % n

    return pick


def background(stage_id, title, art):
    """The stage's map scaled to cover the card, cropped around its cities (the splash's globe when `art`), dimmed, black at the bottom; the wordmark and the stage."""
    if art:
        c = Image.blend(Image.open(os.path.join(OG, "arena.jpg")).convert("RGBA"), Image.new("RGBA", (W, H), VOID), 0.5)
    else:
        m = Image.open(os.path.join(OG, f"map-{stage_id}.png")).convert("RGBA")
        k = max(W / m.width, H / m.height)
        m = m.resize((round(m.width * k), round(m.height * k)), Image.NEAREST)
        top = (m.height - H) // 2 if stage_id == "world" else min(m.height - H, 40)  # a region's bottom sixth is empty
        c = Image.blend(m.crop(((m.width - W) // 2, top, (m.width - W) // 2 + W, top + H)), Image.new("RGBA", (W, H), VOID), 0.55)
    fade = Image.new("RGBA", c.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(fade)
    for y in range(470, H):
        d.line([(0, y), (W, y)], fill=(0, 0, 0, int(200 * ((y - 470) / (H - 470)) ** 1.2)))
    c.alpha_composite(fade)
    d = ImageDraw.Draw(c)
    logo = Image.open(os.path.join(OG, "wordmark.png")).convert("RGBA")
    logo = logo.resize((420, round(logo.height * 420 / logo.width)), Image.NEAREST)
    c.alpha_composite(logo, (36, 22))
    f = FONT(30)
    tw = d.textlength(title, f)
    d.rectangle([W - 48 - tw - 28, 44, W - 48, 100], fill=VOID, outline=CYAN, width=4)
    d.text((W - 48 - tw - 14, 57), title, font=f, fill=CYAN)
    return c


def sprite(who, height, mirror=False):
    """The boy ("rival") or the girl, `height` tall."""
    fig = Image.open(os.path.join(OG, f"{who}.png")).convert("RGBA")
    fig = fig.resize((round(fig.width * height / fig.height), height), Image.NEAREST)
    return ImageOps.mirror(fig) if mirror else fig


def run(d, x, y, parts, off=4):
    """Text runs [(text, font, fill)] on one baseline from x, over a dark shadow."""
    for t, f, fill in parts:
        d.text((x + off, y + off), t, font=f, fill=VOID)
        d.text((x, y), t, font=f, fill=fill)
        x += d.textlength(t, f)


def centred(d, cx, y, parts, off=4):
    run(d, cx - sum(d.textlength(t, f) for t, f, _ in parts) / 2, y, parts, off)


def big(d, x, y, text, size, unit="", usize=56):
    """Display text, yellow on a pink shadow like the wordmark; `unit` smaller on the same baseline."""
    f2, f3 = FONT(size), FONT(usize)
    for off, fill in ((14, VOID), (7, PINK), (0, YELLOW)):
        d.text((x + off, y + off), text, font=f2, fill=fill)
        if unit:
            d.text((x + d.textlength(text, f2) + off, y + size - usize - 6 + off), unit, font=f3, fill=fill)


def coin(d, y, cx=W / 2):
    """INSERT 1 GAMECOIN TO PLAY with a blinking cursor, centred on cx."""
    f = FONT(34)
    t = "INSERT 1 GAMECOIN TO PLAY"
    w = d.textlength(t, f)
    x = cx - (w + 34) / 2
    run(d, x, y, [(t, f, YELLOW)])
    d.rectangle([x + w + 12, y + 2, x + w + 34, y + 32], fill=PINK)


def aside(c, who, pick):
    """The sprite on one side of the card; the centre of the column left for the text."""
    left = pick(2) == 0
    fig = sprite(who, 250, left)
    c.alpha_composite(fig, (60 if left else W - 60 - fig.width, 300))
    return (fig.width + 60 + W - 40) / 2 if left else (40 + W - 60 - fig.width) / 2


def arcade(c, d, score, name, who, pick):
    cx = aside(c, who, pick)
    centred(d, cx, 150, [("CAN YOU BEAT", FONT(46), WHITE)])
    text, unit, size = (str(score), " PTS", 150) if score is not None else ("MY RECORD", "?", 104)
    w = d.textlength(text, FONT(size)) + d.textlength(unit, FONT(56))
    big(d, cx - w / 2, 206, text, size, unit)
    if name:
        centred(d, cx, 372, [("CHAMPION ", FONT(36), CYAN), (name, FONT(36), WHITE)])
    coin(d, 446, cx)


def table(c, d, score, name, who, pick):
    cx = aside(c, who, pick)
    centred(d, cx, 140, [("CAN YOU DO BETTER", FONT(46), WHITE)])
    f, fs = FONT(72), FONT(40)
    rows = [("1ST", name or "???", str(score) if score is not None else "????", YELLOW), ("2ND", "YOU", "????", PINK)]
    wmax = max(d.textlength(f"{r[0]} {r[1]:<4} {r[2]:>5}", f) for r in rows)
    for i, (rank, player, pts, colour) in enumerate(rows):
        y, x = 212 + i * 96, cx - wmax / 2
        run(d, x, y + 22, [(rank, fs, CYAN)])
        run(d, x + d.textlength("1ST ", f), y, [(player, f, WHITE)])
        run(d, x + wmax - d.textlength(pts, f), y, [(pts, f, colour)], off=6)
    coin(d, 428, cx)


def versus(c, d, score, name, who, pick):
    a, b = sprite(who, 230), sprite("girl" if who == "rival" else "rival", 230, True)
    ax, bx = 200, W - 200 - b.width
    c.alpha_composite(a, (ax, 192))
    c.alpha_composite(b, (bx, 192))
    centred(d, W / 2, 150, [("CAN YOU BEAT ", FONT(32), WHITE), (name or "THE CHAMPION", FONT(32), CYAN)])
    big(d, W / 2 - d.textlength("VS", FONT(170)) / 2, 226, "VS", 170)
    centred(d, ax + a.width / 2, 426, [(name or "CHAMPION", FONT(44), WHITE)])
    if score is not None:
        centred(d, ax + a.width / 2, 474, [(f"{score} PTS", FONT(36), YELLOW)])
    centred(d, bx + b.width / 2, 426, [("YOU", FONT(44), WHITE)])
    centred(d, bx + b.width / 2, 474, [("???? PTS", FONT(36), PINK)])


LAYOUTS = [arcade, table, versus]


def tv(card):
    """The TV pass: a soft bloom, a scanline every third row, a vignette toward the edges."""
    bloom = card.filter(ImageFilter.GaussianBlur(6))
    card = Image.blend(card, ImageChops.lighter(card, bloom), 0.3)
    scan = Image.new("L", card.size, 255)
    d = ImageDraw.Draw(scan)
    for y in range(0, card.height, 3):
        d.line([(0, y), (card.width, y)], fill=205)
    card = Image.composite(card, Image.new("RGBA", card.size, (0, 0, 0, 255)), scan)
    v = Image.new("L", (300, 157), 0)
    ImageDraw.Draw(v).ellipse([-40, -30, 340, 187], fill=255)
    v = v.resize(card.size, Image.LANCZOS).filter(ImageFilter.GaussianBlur(70))
    return Image.composite(card, Image.new("RGBA", card.size, (4, 4, 14, 255)), v.point(lambda p: 130 + p * 125 // 255))


def frame(c):
    """The splash's border: cyan outside, a dark gap, pink inside."""
    d = ImageDraw.Draw(c)
    d.rectangle([0, 0, W - 1, H - 1], outline=CYAN, width=6)
    d.rectangle([6, 6, W - 7, H - 7], outline=VOID, width=4)
    d.rectangle([10, 10, W - 11, H - 11], outline=PINK, width=6)


def draw(stage_id, title, score, name, seed, layout=None):
    """The card as RGB; `layout` 0..2 forces one, else the record id picks. `score` None is an old link without one."""
    pick = rng(seed)
    which, who, art = pick(3), ["rival", "girl"][pick(2)], stage_id == "world" and pick(2) == 0
    c = background(stage_id, title, art)
    LAYOUTS[which if layout is None else layout](c, ImageDraw.Draw(c), score, name, who, pick)
    c = tv(c)
    frame(c)
    return c.convert("RGB")


def card(s, m, n, r):
    """The JPEG bytes for a link's query values."""
    stage_id, title = parse_stage(m)
    out = BytesIO()
    draw(stage_id, title, parse_score(s), (n or "")[:12].upper(), r or "").save(out, "JPEG", quality=88)
    return out.getvalue()


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        body = card(q.get("s", [None])[0], q.get("m", [None])[0], q.get("n", [""])[0], q.get("r", [""])[0])
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Cache-Control", "public, max-age=86400, s-maxage=31536000, immutable")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

# The link preview of a record, 1200 x 628: an arcade attract screen. The stage's pixel map with a few pins and a dashed
# route, dimmed; the wordmark; CAN YOU BEAT over the score, huge, yellow on a pink shadow like the wordmark; the champion's
# arcade name; INSERT 1 GAMECOIN on a black bar; the rival sprite on one side; then the TV pass and the splash's cyan and
# pink frame. Pins and the sprite's side come from the record id, so a record keeps its card. Query: s (score), m (stage
# id), n (champion name), r (record id).
import os, sys
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
BAR, FIG = 528, 250  # the coin slot's top; the sprite's height
# a pin on the pixel grid (7 wide): the head, then the point
PIN = ["..###..", ".#####.", "##.#.##", "##...##", ".#####.", "..###..", "..###..", "...#...", "...#..."]


def rng(seed):
    """A tiny deterministic generator over the record id: ints in [0, n)."""
    h = sum(ord(c) * (i + 1) for i, c in enumerate(seed)) or 7

    def pick(n):
        nonlocal h
        h = (h * 1103515245 + 12345) % 2 ** 31
        return h % n

    return pick


def background(stage_id, pick):
    """The stage's map scaled to cover the card, cropped around its cities, with the route, dimmed toward the void."""
    m = Image.open(os.path.join(OG, f"map-{stage_id}.png")).convert("RGBA")
    k = max(W / m.width, H / m.height)
    m = m.resize((round(m.width * k), round(m.height * k)), Image.NEAREST)
    top = (m.height - H) // 2 if stage_id == "world" else min(m.height - H, 40)  # a region's bottom sixth is empty
    m = m.crop(((m.width - W) // 2, top, (m.width - W) // 2 + W, top + H))
    route(m, pick)
    return Image.blend(m, Image.new("RGBA", m.size, VOID), 0.55)


def route(c, pick):
    """Five pins across the map, joined by a dashed pink route with yellow nodes, like the splash."""
    d = ImageDraw.Draw(c)
    xs = sorted(60 + pick(1080) for _ in range(5))
    pts = [(x, 130 + pick(380)) for x in xs]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(1, int(((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5 / 14))
        for i in range(0, n, 2):
            a, b = i / n, min(1, (i + 1) / n)
            d.line([(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a), (x0 + (x1 - x0) * b, y0 + (y1 - y0) * b)], fill=PINK, width=4)
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        d.rectangle([mx - 6, my - 6, mx + 6, my + 6], fill=YELLOW)
    for x, y in pts:
        for j, row in enumerate(PIN):
            for i, ch in enumerate(row):
                if ch == "#":
                    d.rectangle([x - 14 + i * 4, y - 36 + j * 4, x - 11 + i * 4, y - 33 + j * 4], fill=PINK)
        d.rectangle([x - 2, y - 24, x + 1, y - 21], fill=YELLOW)


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


def draw(stage_id, title, score, name, seed):
    """The card as RGB. `score` None asks CAN YOU BEAT MY RECORD?, no `name` leaves the champion line out."""
    pick = rng(seed)
    c = background(stage_id, pick)
    d = ImageDraw.Draw(c)
    logo = Image.open(os.path.join(OG, "wordmark.png")).convert("RGBA")
    logo = logo.resize((420, round(logo.height * 420 / logo.width)), Image.NEAREST)
    c.alpha_composite(logo, (36, 22))
    # the stage, top right, in a cyan box
    f = FONT(30)
    tw = d.textlength(title, f)
    d.rectangle([W - 48 - tw - 28, 44, W - 48, 44 + 56], fill=VOID, outline=CYAN, width=4)
    d.text((W - 48 - tw - 14, 44 + 13), title, font=f, fill=CYAN)
    # the sprite takes one side; the text column is centred on the rest
    fig = Image.open(os.path.join(OG, "rival.png")).convert("RGBA")
    fig = fig.resize((round(fig.width * FIG / fig.height), FIG), Image.NEAREST)
    left = pick(2) == 0
    if left:
        fig = ImageOps.mirror(fig)
    c.alpha_composite(fig, (60 if left else W - 60 - fig.width, BAR - FIG + 24))
    cx = (fig.width + 60 + W - 40) / 2 if left else (40 + W - 60 - fig.width) / 2

    def centred(y, parts, shadow=VOID, off=4):
        """Text runs [(text, font, fill)] on one baseline, centred on the column, over a dark shadow."""
        w = sum(d.textlength(t, f) for t, f, _ in parts)
        x = cx - w / 2
        for t, f, fill in parts:
            d.text((x + off, y + off), t, font=f, fill=shadow)
            d.text((x, y), t, font=f, fill=fill)
            x += d.textlength(t, f)

    centred(156, [("CAN YOU BEAT", FONT(46), WHITE)])
    big, unit, size = (f"{score:,}", " PTS", 150) if score is not None else ("MY RECORD", "?", 104)
    f2, f3 = FONT(size), FONT(56)
    w = d.textlength(big, f2) + d.textlength(unit, f3)
    x, y = cx - w / 2, 212
    for off, fill in ((14, VOID), (7, PINK), (0, YELLOW)):
        d.text((x + off, y + off), big, font=f2, fill=fill)
        d.text((x + d.textlength(big, f2) + off, y + size - 56 - 6 + off), unit, font=f3, fill=fill)
    if name:
        centred(392, [("CHAMPION ", FONT(36), CYAN), (name, FONT(36), WHITE)])
    # the coin slot
    d.rectangle([0, BAR, W, BAR + 72], fill=(0, 0, 0, 215))
    f5 = FONT(34)
    coin = "INSERT 1 GAMECOIN TO PLAY"
    kx = (W - d.textlength(coin, f5)) / 2
    d.text((kx, BAR + 18), coin, font=f5, fill=YELLOW)
    d.rectangle([kx + d.textlength(coin, f5) + 12, BAR + 20, kx + d.textlength(coin, f5) + 34, BAR + 50], fill=PINK)  # the cursor
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

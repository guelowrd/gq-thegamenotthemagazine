# A record link (/r?record=…&s=…&m=…&n=…, rewritten here by vercel.json): the game's page with the preview tags set to that
# record's card, so X, Telegram and the rest show the score to beat instead of the generic card. Everything else in the page
# is untouched. The link has its own path because Vercel serves the static page for / before any rewrite, whatever the query.
import os, re, sys, urllib.request
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlencode, urlparse

sys.path.insert(0, os.getcwd())
from og.stages import score as parse_score, stage as parse_stage


def rewrite(html, origin, record, s, m, n):
    stage_id, title = parse_stage(m)
    score = parse_score(s)
    name = (n or "")[:12].upper()
    q = {"record": record, "s": score if score is not None else "", "m": stage_id, "n": name}
    url = f"{origin}/r?{urlencode(q)}"
    image = f"{origin}/api/card?{urlencode({'s': q['s'], 'm': stage_id, 'n': name, 'r': record})}"
    pts = f"{score:,} pts" if score is not None else "my record"
    where = "GeoQuizz" if stage_id == "world" else f"GeoQuizz {title.title()}"
    heading = f"Can you beat {pts} on {where}?" + (f" {name}'s record." if name else "")
    alt = f"GeoQuizz arcade screen over the {title.title()} map: CAN YOU BEAT {pts.upper()}, INSERT 1 GAMECOIN TO PLAY"
    tags = {"og:url": url, "og:image": image, "og:title": heading, "og:image:alt": alt, "twitter:image:alt": alt}
    for key, value in tags.items():
        html = re.sub(rf'(<meta (?:property|name)="{re.escape(key)}" content=")[^"]*(")', lambda v: v.group(1) + value.replace("&", "&amp;").replace('"', "&quot;") + v.group(2), html)
    return html


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        host = self.headers.get("x-forwarded-host") or self.headers.get("host")
        origin = f"https://{host}"
        record = q.get("record", [""])[0]
        args = [q.get(k, [None])[0] for k in ("s", "m", "n")]
        try:
            with urllib.request.urlopen(f"{origin}/", timeout=5) as r:  # the built page, served static
                html = r.read().decode("utf-8")
        except Exception:
            self.send_response(302)  # the page without its preview rather than nothing
            self.send_header("Location", f"/?{urlencode({'record': record})}")
            self.end_headers()
            return
        body = rewrite(html, origin, record, *args).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "public, max-age=0, s-maxage=86400")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

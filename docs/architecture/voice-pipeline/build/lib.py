"""Tiny SVG helpers for the voice pipeline C4 page. Pure stdlib."""
from html import escape as esc

class Svg:
    def __init__(self, w, h, label, sid):
        self.w, self.h, self.aria, self.sid = w, h, label, sid
        self.zones, self.edges, self.nodes, self.texts = [], [], [], []

    # boundary: dotted zone with caption top-left
    def zone(self, x, y, w, h, caption, kind="zone", dx=12):
        self.zones.append(
            f'<rect class="{kind}" x="{x}" y="{y}" width="{w}" height="{h}" rx="10"/>'
            f'<text class="z" x="{x+dx}" y="{y+19}">{esc(caption)}</text>')

    def raw(self, frag):
        self.zones.append(frag)

    # C4 box: name, [type: tech], description lines
    def node(self, x, y, w, h, name, tech, lines, kind="container", accent=False):
        cls = f"box {kind}" + (" accent" if accent else "")
        out = [f'<rect class="{cls}" x="{x}" y="{y}" width="{w}" height="{h}" rx="6"/>']
        cx = x + w / 2
        ty = y + 20
        out.append(f'<text class="t" x="{cx}" y="{ty}" text-anchor="middle">{esc(name)}</text>')
        if tech:
            ty += 15
            out.append(f'<text class="k" x="{cx}" y="{ty}" text-anchor="middle">{esc(tech)}</text>')
        for ln in lines:
            ty += 14
            out.append(f'<text class="s" x="{cx}" y="{ty}" text-anchor="middle">{esc(ln)}</text>')
        self.nodes.append("".join(out))

    # orthogonal polyline with r=8 rounded corners; horizontal runs hop over
    # the vertical runs of edges drawn before them
    def edge(self, pts, cls="", start=False, end=True):
        r = 8
        verts = getattr(self, "_verts", None)
        if verts is None:
            verts = self._verts = []
        def line_to(cur, tgt):
            (cx, cy), (tx, ty) = cur, tgt
            if abs(cy - ty) > 0.01 or abs(cx - tx) < 30:
                return f" L{tx:g} {ty:g}"
            lo, hi = sorted((cx, tx))
            hops = sorted({vx for (vx, y1, y2) in verts if lo + 10 < vx < hi - 10 and y1 + 1 < cy < y2 - 1})
            if not hops:
                return f" L{tx:g} {ty:g}"
            sgn = 1 if tx > cx else -1
            out = ""
            for vx in (hops if sgn > 0 else hops[::-1]):
                out += f" L{vx - 6 * sgn:g} {cy:g} a6 6 0 0 {1 if sgn > 0 else 0} {12 * sgn} 0"
            return out + f" L{tx:g} {ty:g}"
        d = f"M{pts[0][0]} {pts[0][1]}"
        cur = pts[0]
        for i in range(1, len(pts) - 1):
            (x0, y0), (x1, y1), (x2, y2) = pts[i - 1], pts[i], pts[i + 1]
            def toward(ax, ay, bx, by, k):
                dx, dy = bx - ax, by - ay
                n = max(abs(dx), abs(dy)) or 1
                return ax + dx / n * k, ay + dy / n * k
            k1 = min(r, (abs(x1 - x0) + abs(y1 - y0)) / 2)
            k2 = min(r, (abs(x2 - x1) + abs(y2 - y1)) / 2)
            ax, ay = toward(x1, y1, x0, y0, k1)
            bx, by = toward(x1, y1, x2, y2, k2)
            d += line_to(cur, (ax, ay)) + f" Q{x1} {y1} {bx:g} {by:g}"
            cur = (bx, by)
        d += line_to(cur, pts[-1])
        for (xa, ya), (xb, yb) in zip(pts, pts[1:]):
            if abs(xa - xb) < 0.01:
                verts.append((xa, min(ya, yb), max(ya, yb)))
        acc = "accent" in cls
        me = f' marker-end="url(#{"aa" if acc else "a"}{self.sid})"' if end else ""
        ms = f' marker-start="url(#{"as"}{self.sid})"' if start else ""
        self.edges.append(f'<path class="edge {cls}" d="{d}"{me}{ms}/>')

    def raw_edge(self, d, cls="", end=True):
        acc = "accent" in cls
        me = f' marker-end="url(#{"aa" if acc else "a"}{self.sid})"' if end else ""
        self.edges.append(f'<path class="edge {cls}" d="{d}"{me}/>')

    def label(self, x, y, text, anchor="middle", cls=""):
        parts = text.split("|")
        for i, p in enumerate(parts):
            self.texts.append(
                f'<text class="l {cls}" x="{x}" y="{y + i*13}" text-anchor="{anchor}">{esc(p)}</text>')

    def note(self, x, y, text, cls="s"):
        self.texts.append(f'<text class="{cls}" x="{x}" y="{y}">{esc(text)}</text>')

    def badge(self, x, y, n, accent=False):
        c = "bdg acc" if accent else "bdg"
        self.texts.append(
            f'<circle class="{c}" cx="{x}" cy="{y}" r="10"/>'
            f'<text class="bn" x="{x}" y="{y+4}" text-anchor="middle">{n}</text>')

    def render(self, title, desc):
        s = self.sid
        marker = lambda i, fill, d, rx: (
            f'<marker id="{i}{s}" viewBox="0 0 10 10" refX="{rx}" refY="5" markerWidth="7" markerHeight="7" '
            f'orient="auto-start-reverse"><path d="{d}" {fill}/></marker>')
        defs = ("<defs>" + marker("a", 'fill="currentColor"', "M0 0 L10 5 L0 10 z", 9)
                + marker("aa", 'class="accentfill"', "M0 0 L10 5 L0 10 z", 9)
                + marker("as", 'fill="currentColor"', "M10 0 L0 5 L10 10 z", 1) + "</defs>")
        return (f'<svg viewBox="0 0 {self.w} {self.h}" style="min-width:{self.w}px" role="img" '
                f'aria-labelledby="t{s} d{s}" xmlns="http://www.w3.org/2000/svg">'
                f'<title id="t{s}">{esc(title)}</title><desc id="d{s}">{esc(desc)}</desc>{defs}'
                + "".join(self.zones) + "".join(self.edges) + "".join(self.nodes) + "".join(self.texts)
                + "</svg>")

def figure(svg, caption, extra=""):
    return f'<figure><div class="scroll">{svg}</div><p class="hint">Wider than the screen: swipe the diagram sideways.</p><figcaption>{caption}</figcaption>{extra}</figure>'

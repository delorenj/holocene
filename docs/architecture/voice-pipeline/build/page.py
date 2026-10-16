CSS = r"""
:root{--bg:#f5f4ef;--fg:#1d1d1b;--mut:#625f57;--box:#ffffff;--person:#efe6cf;--sys:#dfe9f5;--ext:#ecebe6;--cont:#ffffff;--comp:#f4f8fc;--zone:#a9a596;--acc:#b8401a;--acctint:#fbe6dc;--line:#3a3935;--rule:#d8d5c9}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#14151a;--fg:#e8e6df;--mut:#a09d93;--box:#1d2027;--person:#2c2a22;--sys:#1b2a3c;--ext:#22242b;--cont:#1d2027;--comp:#181b21;--zone:#575a65;--acc:#ff8a5b;--acctint:#33211a;--line:#c9c7bf;--rule:#33353d}}
:root[data-theme="dark"]{--bg:#14151a;--fg:#e8e6df;--mut:#a09d93;--box:#1d2027;--person:#2c2a22;--sys:#1b2a3c;--ext:#22242b;--cont:#1d2027;--comp:#181b21;--zone:#575a65;--acc:#ff8a5b;--acctint:#33211a;--line:#c9c7bf;--rule:#33353d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 Geist,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1800px;margin:0 auto;padding:32px 16px 72px}
h1{font:400 40px/1.1 "Instrument Serif",Georgia,serif;margin:0 0 6px}
h2{font:400 28px/1.2 "Instrument Serif",Georgia,serif;margin:56px 0 4px;padding-top:20px;border-top:1px solid var(--rule)}
h3{font-size:14px;margin:0 0 4px}
.eyebrow{font:600 11px/1 "Geist Mono",ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--acc);margin:0 0 10px}
p.lede{color:var(--mut);max-width:80ch;margin:0 0 12px}
nav.toc{display:flex;flex-wrap:wrap;gap:6px 18px;margin:14px 0 0;font:500 13px "Geist Mono",ui-monospace,monospace}
nav.toc a{color:var(--fg);text-decoration:none;border-bottom:1px solid var(--zone)}
nav.toc a:hover{border-color:var(--acc);color:var(--acc)}
figure{margin:14px 0 0;padding:0}
.scroll{overflow-x:auto;border:1px solid var(--rule);border-radius:6px;background:var(--bg);-webkit-overflow-scrolling:touch}
svg{display:block;width:100%;height:auto;color:var(--fg);font-family:Geist,system-ui,sans-serif}
figcaption{color:var(--mut);margin-top:8px;max-width:100ch;font-size:14px}
.box{fill:var(--box);stroke:var(--line);stroke-width:1.2}
.box.person{fill:var(--person)} .box.system{fill:var(--sys);stroke-width:1.8} .box.ext{fill:var(--ext);stroke-dasharray:4 3}
.box.container{fill:var(--cont)} .box.component{fill:var(--comp)}
.box.accent{stroke:var(--acc);stroke-width:2.2;fill:var(--acctint)}
.zone{fill:none;stroke:var(--zone);stroke-width:1.3;stroke-dasharray:3 5}
.zone.solid{stroke-dasharray:none;stroke-width:1}
.z{fill:var(--mut);font:600 12px "Geist Mono",ui-monospace,monospace}
.t{fill:var(--fg);font-size:13px;font-weight:600}
.k{fill:var(--mut);font:10.5px "Geist Mono",ui-monospace,monospace}
.s{fill:var(--mut);font-size:11.5px}
.l{fill:var(--fg);font:11px "Geist Mono",ui-monospace,monospace;paint-order:stroke;stroke:var(--bg);stroke-width:4px;stroke-linejoin:round}
.l.accent{fill:var(--acc);font-weight:600}
.edge{fill:none;stroke:var(--line);stroke-width:1.4}
.edge.dash{stroke-dasharray:5 4}
.edge.accent{stroke:var(--acc);stroke-width:2.2}
.accentfill{fill:var(--acc)}
.bdg{fill:var(--bg);stroke:var(--line);stroke-width:1.3}.bdg.acc{stroke:var(--acc);fill:var(--acctint)}
.bn{fill:var(--fg);font:600 11px "Geist Mono",ui-monospace,monospace}
.lane{fill:none;stroke:var(--rule);stroke-width:1}
.row-a{fill:var(--acctint)}
.h{fill:var(--fg);font-weight:600;font-size:13px}.m{fill:var(--fg);font:11.2px "Geist Mono",ui-monospace,monospace}.ev{fill:var(--mut);font:11px "Geist Mono",ui-monospace,monospace}.tt{fill:var(--mut);font:600 11px "Geist Mono",ui-monospace,monospace}
.legend{display:flex;flex-wrap:wrap;gap:8px 22px;margin:12px 0 0;font-size:13px;color:var(--mut)}
.legend span{display:inline-flex;align-items:center;gap:7px}
.legend i{display:inline-block;width:22px;height:14px;border:1.3px solid var(--line);border-radius:3px;background:var(--box)}
.legend i.p{background:var(--person)}.legend i.sy{background:var(--sys);border-width:1.8px}.legend i.ex{background:var(--ext);border-style:dashed}.legend i.cm{background:var(--comp)}.legend i.ac{border-color:var(--acc);background:var(--acctint);border-width:2px}
.legend i.zn{background:none;border-style:dotted;border-color:var(--zone)}
.legend b{display:inline-block;width:26px;border-top:1.6px solid var(--line)}.legend b.d{border-top-style:dashed}.legend b.a{border-top:2.2px solid var(--acc)}
table{border-collapse:collapse;width:100%;margin-top:14px;font-size:14px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
th{color:var(--mut);font:600 12px "Geist Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em}
code{font:12.5px "Geist Mono",ui-monospace,monospace;background:var(--sys);padding:1px 5px;border-radius:3px}
ul.gaps{margin:10px 0 0;padding-left:22px;font-size:14px;max-width:110ch}ul.gaps li{margin:0 0 6px}ol.hops{margin:14px 0 0;padding-left:26px;font-size:14px}ol.hops li{margin:0 0 6px;break-inside:avoid}
.foot{color:var(--mut);font-size:13px;margin-top:40px}
@media (min-width:1000px){ol.hops{columns:2;column-gap:32px}}
code{overflow-wrap:anywhere}
.tw{overflow-x:auto}
.hint{display:none;margin:8px 0 0;font-size:12.5px;color:var(--mut)}
@media (max-width:900px){.hint{display:block}.scroll{box-shadow:inset -14px 0 12px -12px color-mix(in srgb,var(--fg) 35%,transparent)}}
@media (max-width:640px){h1{font-size:32px}main{padding:20px 16px 56px}}
"""

HEAD = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voice Memo Pipeline C4</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&family=Instrument+Serif&display=swap" rel="stylesheet">
<style>""" + CSS + "</style></head><body><main>"

LEGEND = """<div class="legend"><span><i class="p"></i>person</span><span><i class="sy"></i>software system</span><span><i></i>container</span><span><i class="cm"></i>component</span><span><i class="ex"></i>external</span><span><i class="ac"></i>focal: per-turn wall clock path</span><span><i class="zn"></i>boundary</span><span><b></b>call or message (sync or async)</span><span><b class="d"></b>read-only look-up / optional / not replayed</span><span><b class="a"></b>timeout path</span></div>"""

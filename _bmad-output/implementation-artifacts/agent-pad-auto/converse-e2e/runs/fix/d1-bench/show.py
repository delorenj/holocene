import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l); print(d['variant'],d['i'],d['prompt'],d['path'],d['wall_ms'],d['action'],d['say_chars'],[(a.get('outcome'),a.get('ms')) for a in d['attempts'] or []],[(c.get('model'),c.get('finish'),c.get('ct'),c.get('rt'),c.get('route_hdr'),c.get('sent_effort'),c.get('reask')) for c in d['calls']])

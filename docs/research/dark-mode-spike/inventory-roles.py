"""For each colour token, tally which CSS property consumes it (text vs background vs border/other).
python3 -I docs/research/dark-mode-spike/inventory-roles.py <root>"""
import re,subprocess,sys,os,collections
root=sys.argv[1]
fs=[f for f in subprocess.run(["git","-C",root,"ls-files","src"],stdout=subprocess.PIPE,universal_newlines=True).stdout.split()
    if re.search(r"\.(tsx?|jsx?)$",f) and ".test." not in f and "__tests__" not in f and "/ui/" not in f and "prototypes/" not in f]
pat=re.compile(r"""\b([a-zA-Z]+)\s*:\s*[`"'][^`"'\n]*?var\(--((?:theme|color|surface|text-(?:default|muted|reverse)|border|link)[a-z0-9-]*)""")
def role(p):
    p=p.lower()
    if p=="color": return "fg"
    if p.startswith("background") or p=="bg": return "bg"
    if p.startswith("border") or p.startswith("outline") or p=="boxshadow": return "border"
    if p in("fill","stroke"): return "svg"
    return "other"
t=collections.defaultdict(collections.Counter)
for f in fs:
    s=open(os.path.join(root,f),encoding="utf-8").read()
    for p,n in pat.findall(s): t[n][role(p)]+=1
both=[(n,c) for n,c in t.items() if c["fg"] and c["bg"]]
print("tokens used as BOTH text colour and background:",len(both),"of",len(t))
for n,c in sorted(t.items(),key=lambda x:-sum(x[1].values())):
    print(f'{sum(c.values()):4}  fg={c["fg"]:3} bg={c["bg"]:3} border={c["border"]:3} svg={c["svg"]:2} other={c["other"]:2}  --{n}')

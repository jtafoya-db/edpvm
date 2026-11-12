"""Tally var(--x) references in non-test TS/JS under src by token family. python3 -I docs/research/dark-mode-spike/inventory-tokens.py <root>"""
import re,subprocess,sys,os,collections
root=sys.argv[1]
fs=[f for f in subprocess.run(["git","-C",root,"ls-files","src"],stdout=subprocess.PIPE,universal_newlines=True).stdout.split()
    if re.search(r"\.(tsx?|jsx?)$",f) and ".test." not in f and "__tests__" not in f and "prototypes/" not in f]
fam=collections.Counter(); names=collections.Counter(); perdir=collections.defaultdict(collections.Counter)
def family(n):
    if re.match(r"color-",n): return "palette (--color-*)"
    if re.match(r"theme-",n): return "semantic theme (--theme-*)"
    if re.match(r"(text-(default|muted|reverse)|surface-|border-|link-)",n): return "semantic role (--surface/--text/--border/--link)"
    if re.match(r"(background|foreground|card|popover|primary|secondary|muted|accent|destructive|input|ring|chart|sidebar)\b",n): return "shadcn"
    if re.match(r"(shadow|focus)",n): return "shadow/focus"
    return "non-colour"
for f in fs:
    s=open(os.path.join(root,f),encoding="utf-8").read()
    d=f.split("/")[1] if f.count("/")>=2 else f
    d="/".join(f.split("/")[:3]) if f.startswith("src/components") else "/".join(f.split("/")[:2])
    for n in re.findall(r"var\(--([a-z0-9-]+)",s):
        k=family(n); fam[k]+=1; perdir[d][k]+=1
        if k.startswith("palette"): names[n]+=1
for k,v in fam.most_common(): print(f"{v:6} {k}")
print("\n-- palette refs per dir");
for d,c in sorted(perdir.items(),key=lambda x:-x[1]["palette (--color-*)"]):
    if c["palette (--color-*)"]: print(f'{c["palette (--color-*)"]:5} / sem {c["semantic theme (--theme-*)"]+c["semantic role (--surface/--text/--border/--link)"]:5}  {d}')
print("\n-- top palette tokens");
for n,v in names.most_common(25): print(v,n)

# ---- Headline numbers cited in docs/research/dark-mode-spike.md -------------
MOCK={"browse","domain","dataset","bundle","bundles","search","cart","requests","access"}
def status(f):
    if f=="src/uswds/design-system.js" or f.startswith("src/design-system/"): return "vendored USWDS"
    if f=="src/legacy/admin.jsx": return "admin.jsx (mostly gated ops tabs)"
    if f.startswith("src/legacy/") and os.path.basename(f).rsplit(".",1)[0] in MOCK: return "gated mock screens"
    return "live UI"
split=collections.Counter(); split_files=collections.defaultdict(set); fills=collections.Counter()
# Include direct and conditional/ternary fills. Stop at the end of the style
# property so a later property cannot be mistaken for the background value.
fill_re=re.compile(r"""background(?:Color)?\s*:[^,}\n]*var\(--theme-primary\)""")
for f in fs:
    s=open(os.path.join(root,f),encoding="utf-8").read()
    n=len(re.findall(r"var\(--color-",s)); g=status(f)
    split[g]+=n
    if n: split_files[g].add(f)
    fills[g]+=len(fill_re.findall(s))
sem=fam["semantic theme (--theme-*)"]+fam["semantic role (--surface/--text/--border/--link)"]
print("\n== headline")
print(f"semantic references (--theme-* + roles): {sem}")
print(f"palette references: {fam['palette (--color-*)']}")
for g in ("live UI","gated mock screens","admin.jsx (mostly gated ops tabs)","vendored USWDS"):
    print(f"   {split[g]:4} in {len(split_files[g]):3} files  {g}")
print("background: var(--theme-primary) fills:", dict(fills))

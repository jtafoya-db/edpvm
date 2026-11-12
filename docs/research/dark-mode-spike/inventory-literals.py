"""Group hard-coded colour literals by migration strategy (#347). python3 -I docs/research/dark-mode-spike/inventory-literals.py <root>"""
import re,subprocess,sys,os,collections
root=sys.argv[1]
fs=[f for f in subprocess.run(["git","-C",root,"ls-files","src"],stdout=subprocess.PIPE,universal_newlines=True).stdout.split()
    if re.search(r"\.(tsx?|jsx?|css)$",f) and ".test." not in f and "__tests__" not in f and "routeTree" not in f and "prototypes/" not in f]
LIT=re.compile(r"""(?:(?<=["'`])|(?<=[\s:(,]))(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])|\b(?:rgba?|hsla?|oklch)\([^)]*\))""")
MOCK={"browse","domain","dataset","bundle","bundles","search","cart","requests","access"}
def group(f):
    if f in("src/uswds/uswds.css",): return "0 orphaned token sheet (not imported)"
    if f.endswith(".css"): return "1 token definition sheets"
    if f=="src/uswds/design-system.js" or f.startswith("src/design-system/"): return "2 vendored USWDS component bundle"
    if f.startswith("src/legacy/") and os.path.basename(f)[:-4] in MOCK: return "3 legacy mock screens (gated coming-soon, never rendered)"
    if f.startswith("src/components/ui/"): return "4 shadcn primitives"
    if f.startswith(("src/server/","src/data/","src/deploy/","src/lib/error-")) or f=="src/features/registry.ts": return "9 non-UI (ids/comments/HTML error page)"
    return "5 live UI"
out=collections.defaultdict(lambda: collections.Counter()); files=collections.defaultdict(collections.Counter)
for f in fs:
    s=open(os.path.join(root,f),encoding="utf-8").read()
    g=group(f)
    for m in LIT.finditer(s):
        v=m.group(1)
        if re.fullmatch(r"#\d{3}",v) and s[m.start()-1] not in "\"'`": continue  # issue refs
        pre=s[max(0,m.start()-60):m.start()]
        if re.search(r"var\(--[a-z0-9-]+,\s*$",pre): kind="fallback in var()"
        elif v.lower() in("#fff","#ffffff") : kind="white"
        elif f.endswith(".css") or "--" in pre.splitlines()[-1] if pre else False: kind="token value"
        else: kind="other literal"
        out[g][kind]+=1; files[g][f]+=1
for g in sorted(out):
    print(f"\n## {g}: {sum(out[g].values())}  {dict(out[g])}")
    for f,n in files[g].most_common(): print(f"   {n:4} {f}")

# ---- Headline numbers cited in docs/research/dark-mode-spike.md -------------
code=[f for f in fs if not f.endswith(".css")]
style_re=re.compile(r"style=\{\{|style:\s*\{|Style\s*=\s*\{|: React\.CSSProperties|: CSSProperties")
styles={f:len(style_re.findall(open(os.path.join(root,f),encoding="utf-8").read())) for f in code}
cls=[f for f in code if f.endswith((".tsx",".jsx")) and not f.startswith("src/components/ui/")
     and "className=" in open(os.path.join(root,f),encoding="utf-8").read()]
print("\n== headline")
print(f"inline style objects: {sum(styles.values())} in {sum(1 for v in styles.values() if v)} files")
print(f"app files using className (outside src/components/ui/): {len(cls)}  {sorted(cls)}")

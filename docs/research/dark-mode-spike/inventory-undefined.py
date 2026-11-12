"""var(--x) references whose --x is never defined in src, so the fallback (or nothing) always applies.
python3 -I docs/research/dark-mode-spike/inventory-undefined.py <repo-root>"""
import re,subprocess,sys,os,collections
root=sys.argv[1]
fs=[f for f in subprocess.run(["git","-C",root,"ls-files","src"],stdout=subprocess.PIPE,universal_newlines=True).stdout.split()
    if re.search(r"\.(tsx?|jsx?|css)$",f) and "prototypes/" not in f and "src/uswds/uswds.css"!=f]
defined=set(); refs=collections.defaultdict(list)
for f in fs:
    s=open(os.path.join(root,f),encoding="utf-8").read()
    defined|=set(re.findall(r"(--[a-zA-Z0-9-]+)\s*:",s)); defined|=set(re.findall(r"""["'](--[a-zA-Z0-9-]+)["']\s*:""",s))
    defined|=set(re.findall(r"`(--color-)\$\{",s))
    if ".test." in f or "__tests__" in f: continue
    for i,l in enumerate(s.splitlines(),1):
        for n,fb in re.findall(r"var\((--[a-zA-Z0-9-]+)\s*(,[^)]*)?\)",l): refs[n].append((f,i,fb.strip(", ")))
und={n:v for n,v in refs.items() if n not in defined}
for n,v in sorted(und.items(),key=lambda x:-len(x[1])):
    print(len(v),n,"fallbacks:",sorted(set(x[2] for x in v))[:4],"e.g.",f"{v[0][0]}:{v[0][1]}")

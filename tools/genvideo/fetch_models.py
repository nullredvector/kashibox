"""Download the model files listed in models.txt (one per line: repo  file-in-repo  dest-subfolder).
Downloads only: nothing from this machine is sent anywhere."""
import os, shutil, sys
from huggingface_hub import hf_hub_download

listing, root = sys.argv[1], sys.argv[2]
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
for line in open(listing):
    line = line.split("#")[0].strip()
    if not line:
        continue
    repo, name, sub = line.split()
    dest = os.path.join(root, sub, os.path.basename(name))
    if os.path.exists(dest):
        print("have", dest)
        continue
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    got = hf_hub_download(repo, name, cache_dir="/tmp/hf")
    shutil.copyfile(got, dest)
    print("saved", dest)

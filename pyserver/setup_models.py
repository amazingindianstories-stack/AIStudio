"""
One-time setup: fetch the InstantID custom pipeline code + the antelopev2 face
model. The SDXL base, InstantID ControlNet, and ip-adapter.bin weights are
public and get pulled lazily by diffusers/hf_hub at first run (no token needed).

Run:  ./.venv/bin/python setup_models.py
"""
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

GH_RAW = "https://raw.githubusercontent.com/instantX-research/InstantID/main"
PIPELINE_FILES = {
    "pipeline_stable_diffusion_xl_instantid.py": f"{GH_RAW}/pipeline_stable_diffusion_xl_instantid.py",
    "ip_adapter/__init__.py": None,  # created empty
    "ip_adapter/attention_processor.py": f"{GH_RAW}/ip_adapter/attention_processor.py",
    "ip_adapter/resampler.py": f"{GH_RAW}/ip_adapter/resampler.py",
    "ip_adapter/utils.py": f"{GH_RAW}/ip_adapter/utils.py",
}

# antelopev2 face analysis pack (insightface's default download link is dead;
# this public mirror has the 5 onnx files).
ANTELOPE_REPO = "DIAMONIK7777/antelopev2"
ANTELOPE_FILES = [
    "1k3d68.onnx",
    "2d106det.onnx",
    "genderage.onnx",
    "glintr100.onnx",
    "scrfd_10g_bnkps.onnx",
]


def fetch(url: str, dest: str):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        print(f"  ✓ exists {dest}")
        return
    print(f"  ↓ {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as r, open(dest, "wb") as f:
        f.write(r.read())


def main():
    print("• InstantID pipeline code")
    for rel, url in PIPELINE_FILES.items():
        dest = os.path.join(HERE, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if url is None:
            open(dest, "a").close()
            continue
        fetch(url, dest)

    print("• antelopev2 face model")
    from huggingface_hub import hf_hub_download

    target_dir = os.path.join(HERE, "models", "antelopev2")
    os.makedirs(target_dir, exist_ok=True)
    for fn in ANTELOPE_FILES:
        out = os.path.join(target_dir, fn)
        if os.path.exists(out) and os.path.getsize(out) > 0:
            print(f"  ✓ exists {fn}")
            continue
        print(f"  ↓ {fn}")
        p = hf_hub_download(repo_id=ANTELOPE_REPO, filename=fn)
        # copy into the insightface-expected location
        import shutil

        shutil.copy(p, out)

    print("\n✅ Setup complete. InstantID code + antelopev2 ready.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"\n❌ setup failed: {e}", file=sys.stderr)
        sys.exit(1)

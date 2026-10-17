"""
datasets/intent_classification/download_clinc150.py
Downloads the official CLINC150 (oos-eval) dataset from GitHub:
https://github.com/clinc/oos-eval
License: CC BY 4.0
"""

import sys
import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent

def download_clinc150():
    print("Attempting to download CLINC150 / OOS-eval dataset from GitHub raw repository...")
    try:
        import requests
        url = "https://raw.githubusercontent.com/clinc/oos-eval/master/data/data_small.json"
        res = requests.get(url, timeout=12)
        if res.status_code == 200:
            data = res.json()
            out_path = DATA_DIR / "clinc150_raw.json"
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
            train_count = len(data.get("train", []))
            test_count = len(data.get("test", []))
            print(f"Successfully downloaded CLINC150: {train_count} train samples, {test_count} test samples to {out_path}")
            return True
    except Exception as e:
        print(f"Online download skipped or unavailable ({e}).")
    
    print("Using bundled marketplace intent dataset in demo_data.json.")
    return False

if __name__ == "__main__":
    download_clinc150()

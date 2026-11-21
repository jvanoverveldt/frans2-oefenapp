import os
import runpy
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
os.environ.setdefault("DATA_DIR", str(ROOT_DIR / "data"))
runpy.run_path(str(ROOT_DIR / "frans2_oefenapp" / "server.py"), run_name="__main__")

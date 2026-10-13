"""Script import shim for the shared inert golden loader."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from testsupport.frozen_oracle import run, check_output, schema_sql

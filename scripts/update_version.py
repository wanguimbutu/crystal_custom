import re
import sys
from pathlib import Path

version = sys.argv[1]
init_file = Path(__file__).resolve().parent.parent / "verisure" / "__init__.py"

content = init_file.read_text()
new_content = re.sub(r'__version__\s*=\s*["\'].*["\']', f'__version__ = "{version}"', content)
init_file.write_text(new_content)

print(f" Updated verisure/__init__.py to version {version}")

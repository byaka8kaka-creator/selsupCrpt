from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
root = Path(__file__).resolve().parents[1]
output = root / 'artifacts' / 'selsup-crpt-extension.zip'
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for file in sorted((root / 'extension').iterdir()):
        if file.is_file():
            archive.write(file, 'extension/' + file.name)
    archive.write(root / 'README.md', 'README.md')
print(output)

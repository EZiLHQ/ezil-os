"""Offline VSIX package for this dependency-free extension (VSIX 2.0 schema).

Fixed timestamps, permissions and file ordering make --check compare exact bytes.
Only the explicit distributable files below are included; no tests, config secrets,
node_modules or build logs can enter the image.
"""
import json
from pathlib import Path
import sys
from xml.sax.saxutils import escape, quoteattr
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

source, bundle, output = map(Path, sys.argv[1:])
package = json.loads((source / "package.json").read_text())
assert package["license"] == "AGPL-3.0-only"
properties = {
    "Microsoft.VisualStudio.Code.Engine": package["engines"]["vscode"],
    "Microsoft.VisualStudio.Code.ExtensionKind": ",".join(package["extensionKind"]),
    "Microsoft.VisualStudio.Code.EnabledApiProposals": ",".join(package["enabledApiProposals"]),
    "Microsoft.VisualStudio.Code.ExecutesCode": "true",
    "Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown": "true",
}
props = "".join(f'<Property Id={quoteattr(key)} Value={quoteattr(value)}/>' for key, value in properties.items())
manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata>
<Identity Language="en-US" Id={quoteattr(package["name"])} Version={quoteattr(package["version"])} Publisher={quoteattr(package["publisher"])}/>
<DisplayName>{escape(package["displayName"])}</DisplayName>
<Description xml:space="preserve">{escape(package["description"])}</Description>
<Categories>{escape(",".join(package["categories"]))}</Categories>
<GalleryFlags>Public</GalleryFlags><Properties>{props}</Properties><License>extension/LICENSE.txt</License>
</Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/>
<Assets>
<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" Addressable="true"/>
<Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true"/>
</Assets></PackageManifest>
'''
types = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
for ext, mime in {"js": "application/javascript", "json": "application/json", "md": "text/markdown", "txt": "text/plain", "vsixmanifest": "text/xml"}.items():
    types += f'<Default Extension="{ext}" ContentType="{mime}"/>'
types += '</Types>'
files = {"extension.vsixmanifest": manifest.encode(), "[Content_Types].xml": types.encode(), "extension/dist/extension.js": bundle.read_bytes()}
for src, dest in {"package.json": "package.json", "README.md": "readme.md", "LICENSE": "LICENSE.txt", "ATTRIBUTIONS.md": "ATTRIBUTIONS.md", "schema/models.schema.json": "schema/models.schema.json", "examples/models.example.json": "examples/models.example.json"}.items():
    files[f"extension/{dest}"] = (source / src).read_bytes()
with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
    for name, data in sorted(files.items()):
        info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.external_attr = 0o100644 << 16
        info.compress_type = ZIP_DEFLATED
        archive.writestr(info, data, compress_type=ZIP_DEFLATED, compresslevel=9)

#!/usr/bin/env python3
"""Copy the Worker's workspace snapshot codec into the host agent (REVERSE-MOVE-CONTRACT §2.6).

The export op (lib/ezil_host/export.py) runs the SAME codec as the Cloudflare sandbox, as
`python3 -I -c <script>` in a throwaway container. The bake archives only infra/host-agent
(deploy/aws/mum/rebuild-ami.sh), so the script is committed there, next to the agent, as
lib/ezil_host/workspace-snapshot-script.py (a data file: hyphenated, never imported).

  python3 infra/host-agent/ami/sync-codec.py          # rewrite the copy from the Worker source
  python3 infra/host-agent/ami/sync-codec.py --check  # exit 1 if the copy drifted

test/test_codec_parity.py runs the --check comparison on every host-agent test run.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "..", "..", "..", "worker", "src", "workspace-snapshot-script.ts")
COPY = os.path.join(HERE, "..", "lib", "ezil_host", "workspace-snapshot-script.py")
OPEN = "export const SNAPSHOT_SCRIPT = String.raw`"


def codec_from_source(text):
    """The String.raw body, exactly. A raw template is the source text itself unless it holds
    a backtick or a `${` substitution, which would make this extraction unsafe: refuse those."""
    if text.count(OPEN) != 1:
        raise ValueError("SNAPSHOT_SCRIPT declaration not found exactly once")
    body, sep, _ = text.split(OPEN, 1)[1].partition("`;\n")
    if not sep or "`" in body or "${" in body:
        raise ValueError("SNAPSHOT_SCRIPT is not a plain String.raw template")
    return body


def main(argv):
    with open(SOURCE, encoding="utf-8") as f:
        codec = codec_from_source(f.read())
    if "--check" in argv:
        try:
            with open(COPY, encoding="utf-8") as f:
                same = f.read() == codec
        except FileNotFoundError:
            same = False
        if not same:
            print("workspace-snapshot-script.py drifted from the Worker codec; run ami/sync-codec.py", file=sys.stderr)
        return 0 if same else 1
    with open(COPY, "w", encoding="utf-8") as f:
        f.write(codec)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

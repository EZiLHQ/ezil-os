#!/usr/bin/env python3
"""Optional real, offline CDK probe using only the repository's example config.

Requires the pinned infra dependencies to be installed. Confirms why the current
CDK app cannot pass the lane's no-IAM/no-replacement promotion contract.
"""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[4]
source = repo / "infra/app-computers"
with tempfile.TemporaryDirectory(prefix="ezil-mum-real-synth.") as folder:
    root = Path(folder)
    config = json.loads((source / "config/lifecycle.example.json").read_text()
                        .replace("123456789012", "452630323510").replace("pilot", "mum"))
    config.pop("recoveryVersionArn", None)
    baseline = copy.deepcopy(config)
    config["settings"]["deployment"].update(amiId="ami-22222222222222222",
        stateMachineVersionArn="arn:aws:states:ap-south-1:452630323510:stateMachine:ezil-mum-lifecycle:2")
    templates = []
    for phase, value in (("before", baseline), ("target", config)):
        project = root / phase / "app-computers"
        project.mkdir(parents=True)
        for name in ("package.json", "package-lock.json", "cdk.json", "tsconfig.json", "bin", "lib"):
            path = source / name
            if path.is_dir():
                shutil.copytree(path, project / name)
            else:
                shutil.copyfile(path, project / name)
        (project / "node_modules").symlink_to(source / "node_modules", target_is_directory=True)
        config_path = root / (phase + ".json")
        config_path.write_text(json.dumps(value))
        result = subprocess.run(["env", "EZIL_LIFECYCLE_CONFIG=" + str(config_path), "npm", "--offline",
            "--prefix", str(project), "run", "synth:lifecycle"], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError("offline synth failed: " + result.stdout[-2000:] + result.stderr[-2000:])
        print("PASS " + phase + " actual offline synth", flush=True)
        templates.append(json.loads((project / "cdk.out/lifecycle/ezil-mum-lifecycle.template.json").read_text()))
    old, new = [t["Resources"] for t in templates]
    assert any(r["Type"] == "AWS::Lambda::Version" for k, r in new.items() if k not in old)
    assert any(r["Type"] == "AWS::IAM::Policy" and r != new.get(k) for k, r in old.items())
    for logical in sorted(old.keys() | new.keys()):
        if old.get(logical) != new.get(logical):
            action = "ADD" if logical not in old else "REMOVE" if logical not in new else "MODIFY"
            print(action, logical, (old.get(logical) or new[logical])["Type"])
    (root / "live.json").write_text(json.dumps({"TemplateBody": templates[0]}))
    gate = subprocess.run(["python3", str(repo / "deploy/aws/mum/json-tool.py"), "lifecycle-template",
        str(root / "live.json"), str(root / "before/app-computers/cdk.out/lifecycle/ezil-mum-lifecycle.template.json"),
        str(root / "target/app-computers/cdk.out/lifecycle/ezil-mum-lifecycle.template.json"),
        str(root / "before.json"), str(root / "target.json")], capture_output=True, text=True)
    assert gate.returncode == 1 and "resource addition/removal refused" in gate.stderr, gate.stdout + gate.stderr
    print("PASS contract-required refusal")
    print("RESULT: 3 passed, 0 failed")

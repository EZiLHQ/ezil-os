#!/usr/bin/env python3
"""In-memory guard mutants; source files are never mutated."""
import ast
import contextlib
import copy
import importlib.util
import io
from pathlib import Path
import sys
import unittest
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
spec=importlib.util.spec_from_file_location('final_cases',HERE/'registry_gc_final.py')
t=importlib.util.module_from_spec(spec);spec.loader.exec_module(t)
original=(HERE.parent/'registry_gc_provenance.py').read_text()
labels=['E1 stale/future/outside fence capture','E1 source hash/query mismatch','GC retirement not confirmed: required field/type']
for label in labels:
    tree=ast.parse(original)
    count=0
    for node in ast.walk(tree):
        if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=='need' and len(node.args)>1 and isinstance(node.args[1],ast.Constant) and node.args[1].value==label:
            node.args[0]=ast.Constant(True);count+=1
    assert count==1,label
    ast.fix_missing_locations(tree)
    namespace={'__name__':'mutant'};exec(compile(tree,'<in-memory-mutant>','exec'),namespace)
    old_validate,old_strict=t.p.validate,t.p.strict_retirement
    t.p.validate,t.p.strict_retirement=namespace['validate'],namespace['strict_retirement']
    result=unittest.TextTestRunner(stream=io.StringIO()).run(unittest.defaultTestLoader.loadTestsFromTestCase(t.FinalTests))
    t.p.validate,t.p.strict_retirement=old_validate,old_strict
    assert not result.wasSuccessful(),'SURVIVED: '+label
    print('KILLED',label)

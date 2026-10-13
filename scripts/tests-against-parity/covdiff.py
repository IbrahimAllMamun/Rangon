"""Which of Django's rule code do its own tests reach that no parity case does?

Two coverage files, both with branch data, both of the code at /app:
  tests.coverage   pytest, one context per test and phase (--cov-context=test)
  parity.coverage  Django serving a whole parity comparison, races included

For every statement and every branch the tests execute and the comparison never
does: the function it is in, and the tests that get there while they *run*
(what a fixture reaches while it sets a test up is kept apart).  A test none of
whose statements or branches is the tests' alone stands, as far as coverage can
tell, on code a parity case already exercises.

    python covdiff2.py TESTS PARITY OUT.json
"""

import ast
import collections
import json
import sqlite3
import sys

from coverage.python import PythonParser

TESTS, PARITY, OUT = sys.argv[1:4]
ROOT = "/app/"


def arcs(path, with_context):
    db = sqlite3.connect(path)
    files = dict(db.execute("select id, path from file"))
    out = collections.defaultdict(lambda: collections.defaultdict(set))
    if with_context:
        contexts = dict(db.execute("select id, context from context"))
        rows = db.execute("select file_id, context_id, fromno, tono from arc")
        for file_id, context_id, a, b in rows:
            out[files[file_id]][(a, b)].add(contexts[context_id])
    else:
        for file_id, a, b in db.execute("select file_id, fromno, tono from arc"):
            out[files[file_id]][(a, b)].add("")
    return out


def kind(rel):
    if rel.startswith("tests/") or "/tests/" in rel or "/migrations/" in rel:
        return None
    if rel.startswith("config/") or rel in {"manage.py", "conftest.py"}:
        return None
    if "/management/" in rel:
        return "command"
    if rel.endswith("admin.py"):
        return "admin"
    return "rule"


def owners(path):
    """line -> qualified name of the innermost function (or class body)."""
    tree = ast.parse(open(path).read())
    owner = {}

    def walk(node, prefix):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
                name = f"{prefix}.{child.name}" if prefix else child.name
                for line in range(child.lineno, (child.end_lineno or child.lineno) + 1):
                    owner[line] = name
                walk(child, name)
            else:
                walk(child, prefix)

    walk(tree, "")
    return owner


def split(context):
    test, _, phase = context.rpartition("|")
    return (test, phase) if test else (context, "run")


tests, parity = arcs(TESTS, True), arcs(PARITY, False)
every_test = set()
for by_arc in tests.values():
    for contexts in by_arc.values():
        every_test.update(split(c)[0] for c in contexts if c)

regions = {}
per_test = collections.defaultdict(
    lambda: {"run": collections.Counter(), "setup": collections.Counter()}
)
totals = collections.Counter()

for path in sorted(tests):
    if not path.startswith(ROOT):
        continue
    rel = path[len(ROOT) :]
    what = kind(rel)
    if what is None:
        continue
    t_arcs, p_arcs = tests[path], parity.get(path, {})
    t_lines = collections.defaultdict(set)
    for (a, b), contexts in t_arcs.items():
        for line in (a, b):
            if line > 0:
                t_lines[line].update(contexts)
    p_lines = {line for arc in p_arcs for line in arc if line > 0}
    parser = PythonParser(filename=path)
    parser.parse_source()
    exits, statements, owner = parser.exit_counts(), parser.statements, owners(path)

    totals[f"{what}: statements"] += len(statements)
    totals[f"{what}: reached by the tests"] += len(set(t_lines) & statements)
    totals[f"{what}: reached by the comparison"] += len(p_lines & statements)
    totals[f"{what}: reached by both"] += len(set(t_lines) & p_lines & statements)

    found = collections.defaultdict(
        lambda: {"lines": set(), "branches": set(), "run": set(), "setup": set()}
    )

    def note(name, contexts, what_kind, item):
        entry = found[name]
        entry[what_kind].add(item)
        for context in contexts:
            if not context:
                continue
            test, phase = split(context)
            phase = "run" if phase == "run" else "setup"
            entry[phase].add(test)
            per_test[test][phase][f"{rel}::{name}"] += 1

    for line, contexts in t_lines.items():
        if line in statements and line not in p_lines:
            note(owner.get(line, "<module>"), contexts, "lines", line)
    for (a, b), contexts in t_arcs.items():
        # A way out of a line both reach, which only the tests take.
        if (a, b) not in p_arcs and a > 0 and exits.get(a, 0) > 1 and a in p_lines:
            note(owner.get(a, "<module>"), contexts, "branches", (a, b))

    for name, entry in found.items():
        if not entry["run"] and not entry["setup"]:
            continue  # reached only while the module was imported
        totals[f"{what}: statements only the tests reach"] += len(entry["lines"])
        totals[f"{what}: branches only the tests take"] += len(entry["branches"])
        regions[f"{rel}::{name}"] = {
            "kind": what,
            "lines": sorted(entry["lines"]),
            "branches": sorted(entry["branches"]),
            "tests": sorted(entry["run"]),
            "fixtures_only": sorted(entry["setup"] - entry["run"]),
        }

report = {
    "totals": dict(sorted(totals.items())),
    "regions": dict(sorted(regions.items())),
    "tests": {
        test: {
            "alone": dict(per_test[test]["run"].most_common()) if test in per_test else {},
            "alone_in_setup": dict(per_test[test]["setup"].most_common())
            if test in per_test
            else {},
        }
        for test in sorted(every_test)
    },
}
json.dump(report, open(OUT, "w"), indent=1)
alone = sum(1 for t in report["tests"].values() if t["alone"])
print(json.dumps(report["totals"], indent=1))
print(
    f"{len(every_test)} tests; {alone} reach, while they run, rule code no parity case "
    f"reaches; {len(every_test) - alone} do not; {len(regions)} functions hold such code"
)

"""Summarize profiler output directories and preserve all raw samples."""
import gzip
import json
from pathlib import Path
import statistics
import sys

cases = []
for arg in sys.argv[1:]:
    case = json.loads(next(Path(arg).rglob('overscan.json')).read_text())
    status_file = Path(arg) / '.last-run.json'
    case['testOutcome'] = json.loads(status_file.read_text()).get('status') if status_file.exists() else 'unknown'
    cases.append(case)
def memory(samples):
    return {kind: round(statistics.median(next(p['bytes'] for p in s['memory'] if p['type'] == kind) for s in samples) / 1048576, 2) for kind in ['Tab', 'GPU', 'runtime']}
def pan(frames):
    return {'missingFrames': sum(f['missing'] > 0 for f in frames), 'missingNodeFrames': sum(f['missing'] for f in frames), 'frameP95Ms': round(sorted(f['dt'] for f in frames)[int(len(frames) * .95)], 2)}
summary = []
for case in cases:
    summary.append({'variant': case['variant'], 'testOutcome': case['testOutcome'], 'gl': case.get('gl'), 'captureState': case.get('captureState'), 'heapDiagnostic': case.get('heapDiagnostic'), 'settledMiB': memory([s for s in case['samples'] if s['stage'].startswith('settled')]), 'afterPanMiB': memory([s for s in case['samples'] if s['stage'].startswith('after-pan')]), 'slow': pan(case['slow']), 'fast': pan(case['fast']), 'repeated': [{'round': s['stage'], 'memoryMiB': memory([s])} for s in case['samples'] if s['stage'].startswith('repeat')], 'repeatedGaps': [{'slow': pan(p['slow']), 'fast': pan(p['fast'])} for p in case.get('repeatedPans', [])]})
base = Path(__file__).with_name('viewport-overscan-2026-11-13')
with gzip.open(str(base) + '-summary.json.gz', 'wt') as output:
    json.dump(summary, output, indent=2)
    output.write('\n')
with gzip.open(str(base) + '-raw.json.gz', 'wt') as output:
    json.dump(cases, output)
print(json.dumps(summary, indent=2))

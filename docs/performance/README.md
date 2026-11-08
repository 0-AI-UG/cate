# Performance reports

This directory contains readable findings from local profiling runs. The
reproducible profiling tests live in `e2e/`; each report lists its command and
measurement limitations.

## Raw samples

Generated benchmark JSON is not versioned. Existing samples are retained
locally alongside the reports and ignored by Git. References to JSON filenames
in the reports describe local artifacts, not files available in a fresh clone.
Rerun the relevant profiling test to generate new samples in its configured
output directory. Detailed traces and screenshots also remain local.

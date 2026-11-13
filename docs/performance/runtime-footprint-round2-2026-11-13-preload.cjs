/* global require, process */
/* eslint-disable @typescript-eslint/no-require-imports -- Node loads this profiler through --require. */
const fs = require('node:fs');
process.on('SIGUSR2', () => fs.writeFileSync(process.env.RAM2_SAMPLE, JSON.stringify({ memory: process.memoryUsage(), resources: process.getActiveResourcesInfo() })));

// Isolate offline fallbacks without depending on the public catalog or rate server.
globalThis.fetch = async () => { throw new Error('round2 offline fixture') };
// Mapping attribution is requested only after memory samples, since generating
// a diagnostic report itself allocates memory.
process.on('SIGURG', () => fs.writeFileSync(process.env.RAM2_SAMPLE + '.modules', JSON.stringify({
  modules: Object.keys(require.cache), shared: process.report.getReport().sharedObjects,
})));

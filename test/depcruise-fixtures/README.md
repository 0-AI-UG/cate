Files that break one dependency rule each (`.dependency-cruiser.cjs`).
`src/test/depcruise.test.ts` runs depcruise here and expects every file under
`src/` named `bad*.ts` (or a panel's `session.ts` / `definition.ts`) to be
rejected by the named rule. The other files are import targets.

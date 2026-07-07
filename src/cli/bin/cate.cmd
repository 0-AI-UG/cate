@echo off
rem Windows launcher for the `cate` CLI. Resolves the bundled Node and the
rem bundled CLI RELATIVE to this shim (%~dp0 = this file's dir, trailing slash),
rem so `cate` works without node on PATH. Layout mirrors the POSIX shim.
"%~dp0..\..\runtime\bin\node.exe" "%~dp0..\dist\cli.cjs" %*

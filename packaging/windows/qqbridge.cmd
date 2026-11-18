@echo off
rem qq-cli-bridge portable command line. Uses the bundled Node.js and Python;
rem nothing is added to PATH, so your own Node/Python and AI CLIs are untouched.
rem User data lives outside this folder (override with QQBRIDGE_DATA_DIR).
setlocal
set "QQB_HOME=%~dp0"
if not defined QQBRIDGE_DATA_DIR set "QQBRIDGE_DATA_DIR=%LOCALAPPDATA%\qq-cli-bridge\data"
if not defined QQBRIDGE_DDGS_PYTHON set "QQBRIDGE_DDGS_PYTHON=%QQB_HOME%runtime\python\python.exe"
"%QQB_HOME%runtime\node\node.exe" --disable-warning=ExperimentalWarning "%QQB_HOME%app\dist\cli.js" %*
exit /b %ERRORLEVEL%

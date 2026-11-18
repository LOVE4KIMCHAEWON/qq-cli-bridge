@echo off
rem Double-click to open the QQ CLI Bridge setup wizard / menu.
setlocal
title QQ CLI Bridge
set "QQB_HOME=%~dp0"
if not defined QQBRIDGE_DATA_DIR set "QQBRIDGE_DATA_DIR=%LOCALAPPDATA%\qq-cli-bridge\data"
if not defined QQBRIDGE_DDGS_PYTHON set "QQBRIDGE_DDGS_PYTHON=%QQB_HOME%runtime\python\python.exe"
"%QQB_HOME%runtime\node\node.exe" --disable-warning=ExperimentalWarning "%QQB_HOME%app\launcher\launcher.mjs" %*
set "QQB_EXIT=%ERRORLEVEL%"
if not "%QQB_EXIT%"=="0" pause
exit /b %QQB_EXIT%

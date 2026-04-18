@echo off
call "%~dp0build.cmd" %*
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%
call "%~dp0push.cmd" %*

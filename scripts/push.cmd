@echo off
setlocal

set IMAGE=time4action/t4a-partner-portal-api

:: Read the date tag saved by build.cmd; fall back to generating a new one
if exist "%TEMP%\t4a-ppa-date-tag.tmp" (
    for /f "tokens=*" %%i in (%TEMP%\t4a-ppa-date-tag.tmp) do set DATE_TAG=%%i
    del "%TEMP%\t4a-ppa-date-tag.tmp"
) else (
    for /f "tokens=*" %%i in ('powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd-HHmmss'"') do set DATE_TAG=%%i
)

:: Determine tag
if "%~1"=="--latest" (
    set TAG=latest
) else if "%~1"=="--dev" (
    set TAG=dev
) else (
    set TAG=%DATE_TAG%
)

echo [push] Pushing %IMAGE%:%TAG%...

docker push %IMAGE%:%TAG%
if %ERRORLEVEL% neq 0 (
    echo [push] Push failed!
    exit /b 1
)

echo [push] Done: %IMAGE%:%TAG%

:: If a named tag was specified, also push the date tag
if "%TAG%" neq "%DATE_TAG%" (
    echo [push] Also pushing %IMAGE%:%DATE_TAG%...
    docker push %IMAGE%:%DATE_TAG%
    if %ERRORLEVEL% neq 0 (
        echo [push] Push of date tag failed!
        exit /b 1
    )
    echo [push] Done: %IMAGE%:%DATE_TAG%
)

endlocal

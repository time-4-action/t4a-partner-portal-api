@echo off
setlocal

set IMAGE=time4action/t4a-partner-portal-api

:: Always generate a date tag
for /f "tokens=*" %%i in ('powershell -NoProfile -Command "Get-Date -Format 'yyyyMMdd-HHmmss'"') do set DATE_TAG=%%i

:: Determine tag
if "%~1"=="--latest" (
    set TAG=latest
) else if "%~1"=="--dev" (
    set TAG=dev
) else (
    set TAG=%DATE_TAG%
)

echo [build] Building %IMAGE%:%TAG%...

docker build -t %IMAGE%:%TAG% .
if %ERRORLEVEL% neq 0 (
    echo [build] Build failed!
    exit /b 1
)

echo [build] Done: %IMAGE%:%TAG%

:: If a named tag was specified, also tag with the date
if "%TAG%" neq "%DATE_TAG%" (
    echo [build] Also tagging as %IMAGE%:%DATE_TAG%...
    docker tag %IMAGE%:%TAG% %IMAGE%:%DATE_TAG%
    echo [build] Done: %IMAGE%:%DATE_TAG%
)

endlocal

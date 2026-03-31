@echo off
set IMAGE=etiamsi/t4a-export-api

docker build . -t %IMAGE%
IF ERRORLEVEL 1 (
    echo Docker build failed
    exit /b 1
)

docker push %IMAGE%
IF ERRORLEVEL 1 (
    echo Docker push failed
    exit /b 1
)

echo Build and push completed successfully

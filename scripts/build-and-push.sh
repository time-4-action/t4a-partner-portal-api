#!/usr/bin/env bash
set -e

IMAGE="etiamsi/t4a-export-api"

docker build . -t "$IMAGE"
docker push "$IMAGE"

echo "Build and push completed successfully"

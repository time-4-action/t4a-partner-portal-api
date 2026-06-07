#!/usr/bin/env bash
set -e

IMAGE="time4action/t4a-partner-portal-api"

docker build . -t "$IMAGE"
docker push "$IMAGE"

echo "Build and push completed successfully"

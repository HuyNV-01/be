#!/bin/sh

set -e

echo "MinIO Setup: Waiting for ${MINIO_ENDPOINT}..."

mc alias set myminio http://minio:9000 "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}"

echo "Checking bucket: ${MINIO_DEFAULT_BUCKET}..."
if mc ls myminio/${MINIO_DEFAULT_BUCKET} > /dev/null 2>&1; then
    echo "Bucket '${MINIO_DEFAULT_BUCKET}' already exists."
else
    echo "Bucket '${MINIO_DEFAULT_BUCKET}' does not exist. Creating..."
    mc mb myminio/${MINIO_DEFAULT_BUCKET}
fi

echo "Setting policy public for '${MINIO_DEFAULT_BUCKET}'..."
mc anonymous set public myminio/${MINIO_DEFAULT_BUCKET}

echo "MinIO Setup Completed Successfully!"
exit 0

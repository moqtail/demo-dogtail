#!/bin/sh
# Copyright 2026 The MOQtail Authors
# SPDX-License-Identifier: Apache-2.0
#
# Makes a self-signed cert the browser can trust by hash (WebTransport serverCertificateHashes),
# so other devices need no CA installed. Chrome only accepts ECDSA certs valid for at most 14 days:
# rerun this when it expires, then restart the relay and Vite.
set -e
cd "$(dirname "$0")/.."
mkdir -p cert
IP=${1:-$(ipconfig getifaddr en0 2>/dev/null || hostname -I | cut -d' ' -f1)}
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 13 \
  -subj /CN=dogfight -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:$IP" \
  -keyout cert/key.pem -out cert/cert.pem 2>/dev/null
echo "cert for $IP in cert/, valid 13 days"

/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { X509Certificate, createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { defineConfig } from 'vite'

// The cert from scripts/make-cert.sh serves this page and the relay. The page pins the relay by
// the cert's hash, so devices on the LAN can connect without installing a CA.
const certFile = new URL('./cert/cert.pem', import.meta.url)
const keyFile = new URL('./cert/key.pem', import.meta.url)
const hasCert = existsSync(certFile) && existsSync(keyFile)
const certHash = hasCert
  ? createHash('sha256')
      .update(new X509Certificate(readFileSync(certFile)).raw)
      .digest('hex')
  : ''

export default defineConfig({
  define: { __CERT_HASH__: JSON.stringify(certHash) },
  server: {
    port: 5174,
    host: true,
    https: hasCert ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : undefined,
  },
})

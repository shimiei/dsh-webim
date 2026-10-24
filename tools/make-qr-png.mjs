// Render the remote-entry token link as a standalone PNG QR code (no npm deps).
// Usage: node tools/make-qr-png.mjs <url> <out.png> [scale=8] [quiet=4]
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { qrMatrix } from '../lib/qr.js'

const url = process.argv[2]
const out = process.argv[3] ?? 'artifacts/remote-entry-qr.png'
const scale = Number(process.argv[4] ?? 8)
const quiet = Number(process.argv[5] ?? 4)

if (!url) {
  console.error('usage: node tools/make-qr-png.mjs <url> <out.png> [scale] [quiet]')
  process.exit(2)
}

const { modules: matrix, size, version, mask } = qrMatrix(url)
const modules = size + quiet * 2
const pixels = modules * scale

// Build the raw RGB scanlines (truecolor, filter 0) for a black-on-white code.
const rowBytes = pixels * 3 + 1
const raw = Buffer.alloc(rowBytes * pixels, 0)
for (let y = 0; y < pixels; y += 1) {
  const rowStart = y * rowBytes
  raw[rowStart] = 0
  const moduleY = Math.floor(y / scale) - quiet
  for (let x = 0; x < pixels; x += 1) {
    const moduleX = Math.floor(x / scale) - quiet
    const dark = moduleY >= 0 && moduleY < size && moduleX >= 0 && moduleX < size
      && matrix[moduleY][moduleX] === 1
    const value = dark ? 0x00 : 0xff
    const offset = rowStart + 1 + x * 3
    raw[offset] = value
    raw[offset + 1] = value
    raw[offset + 2] = value
  }
}

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(pixels, 0)
ihdr.writeUInt32BE(pixels, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // truecolor
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

writeFileSync(out, png)
console.log(`QR ${pixels}x${pixels} v${version} mask ${mask} -> ${out}`)
console.log(`encoding: ${url}`)

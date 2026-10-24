import { test } from 'node:test'
import assert from 'node:assert/strict'
import { qrMatrix, renderSvg, svgDataUrl } from '../lib/qr.js'

const FINDER = [
  [1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 1, 1, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1],
]

function assertFinder(matrix, left, top) {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      assert.equal(matrix.modules[top + y][left + x], FINDER[y][x], `finder at ${left},${top} (${x},${y})`)
    }
  }
}

function expectedRuns(matrix, margin) {
  const runs = []
  for (let y = 0; y < matrix.size; y++) {
    let x = 0
    while (x < matrix.size) {
      if (matrix.modules[y][x] === 0) {
        x++
        continue
      }
      const start = x
      while (x < matrix.size && matrix.modules[y][x] === 1) x++
      runs.push({ x: start + margin, y: y + margin, width: x - start })
    }
  }
  return runs
}

test('qrMatrix returns square Uint8Array rows for every supported version', () => {
  for (let version = 1; version <= 20; version++) {
    const matrix = qrMatrix('x', { version, ecc: 'H' })
    assert.equal(matrix.version, version)
    assert.equal(matrix.ecc, 'H')
    assert.equal(matrix.size, 17 + 4 * version)
    assert.equal(matrix.modules.length, matrix.size)
    assert.ok(Number.isInteger(matrix.mask) && matrix.mask >= 0 && matrix.mask <= 7)
    for (const row of matrix.modules) {
      assert.ok(row instanceof Uint8Array)
      assert.equal(row.length, matrix.size)
      for (const value of row) assert.ok(value === 0 || value === 1)
    }
    assert.equal(matrix.modules[matrix.size - 8][8], 1, 'dark module')
  }
})

test('finder patterns and separators are present at the three corners', () => {
  for (const version of [1, 7, 20]) {
    const matrix = qrMatrix('finder-check', { version, ecc: 'M' })
    assertFinder(matrix, 0, 0)
    assertFinder(matrix, matrix.size - 7, 0)
    assertFinder(matrix, 0, matrix.size - 7)

    for (let i = 0; i < 8; i++) {
      assert.equal(matrix.modules[7][i], 0)
      assert.equal(matrix.modules[i][7], 0)
      assert.equal(matrix.modules[7][matrix.size - 8 + i], 0)
      assert.equal(matrix.modules[i][matrix.size - 8], 0)
      assert.equal(matrix.modules[matrix.size - 8][i], 0)
      assert.equal(matrix.modules[matrix.size - 8 + i][7], 0)
    }
  }
})

test('UTF-8 byte mode changes capacity and keeps the matrix deterministic', () => {
  const ascii = qrMatrix('remote access')
  const chinese = qrMatrix('远程接入 dsh-webim 扫码打开')
  assert.equal(chinese.version, 3)
  assert.deepEqual(ascii.modules, qrMatrix('remote access').modules)
  assert.deepEqual(chinese.modules, qrMatrix('远程接入 dsh-webim 扫码打开').modules)
  assert.equal(qrMatrix('remote access', { ecc: 'H' }).ecc, 'H')
})

test('renderSvg uses the requested quiet zone, scale and a full-size background', () => {
  const matrix = qrMatrix('https://example.com/?token=abc', { ecc: 'Q' })
  const margin = 3
  const scale = 5
  const svg = renderSvg('https://example.com/?token=abc', { ecc: 'Q', margin, scale, dark: '#123456', light: '#f0f0f0' })
  const extent = matrix.size + margin * 2
  assert.match(svg, new RegExp(`width="${extent * scale}"`))
  assert.match(svg, new RegExp(`height="${extent * scale}"`))
  assert.match(svg, new RegExp(`viewBox="0 0 ${extent} ${extent}"`))
  assert.match(svg, /shape-rendering="crispEdges"/)
  assert.ok(svg.includes(`<rect width="${extent}" height="${extent}" fill="#f0f0f0"/>`))
  assert.ok(svg.includes('<path fill="#123456" d="'))
})

test('SVG is standalone ASCII with a single balanced svg and an exact module path', () => {
  const matrix = qrMatrix('SVG path check', { ecc: 'H' })
  const margin = 4
  const svg = renderSvg('SVG path check', { ecc: 'H' })

  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'))
  assert.ok(svg.endsWith('</svg>'))
  assert.equal((svg.match(/<svg\b/g) || []).length, 1)
  assert.equal((svg.match(/<\/svg>/g) || []).length, 1)
  assert.equal((svg.match(/"/g) || []).length % 2, 0)
  assert.match(svg, /^[\x00-\x7f]*$/)

  const pathMatch = svg.match(/<path fill="[^"]*" d="([^"]*)"\/>/)
  assert.ok(pathMatch)
  const d = pathMatch[1]
  const runPattern = /M(\d+) (\d+)h(\d+)v1h-\3z/g
  const actual = []
  let match
  while ((match = runPattern.exec(d)) !== null) {
    actual.push({ x: Number(match[1]), y: Number(match[2]), width: Number(match[3]) })
  }
  assert.equal(d.replace(runPattern, ''), '', 'path contains only horizontal run subpaths')
  assert.deepEqual(actual, expectedRuns(matrix, margin))
  assert.ok(actual.length > 0)
})

test('svgDataUrl is base64 of the UTF-8 SVG', () => {
  const options = { ecc: 'M', margin: 2, scale: 4 }
  const svg = renderSvg('data-url', options)
  const url = svgDataUrl('data-url', options)
  const prefix = 'data:image/svg+xml;base64,'
  assert.ok(url.startsWith(prefix))
  assert.equal(Buffer.from(url.slice(prefix.length), 'base64').toString('utf8'), svg)
})

test('alt text is kept in the SVG using ASCII-only character references', () => {
  const svg = renderSvg('alt text', { alt: '扫码打开 <dsh-webim>' })
  assert.match(svg, /^[\x00-\x7f]*$/)
  assert.ok(svg.includes('<title>'))
  assert.ok(svg.includes('role="img"'))
  assert.ok(svg.includes('&#x626B;&#x7801;&#x6253;&#x5F00;'))
  assert.ok(svg.includes('&lt;dsh-webim&gt;'))
})

test('version growth is monotonic and long payloads reach version 10 or higher', () => {
  const lengths = [0, 1, 10, 50, 100, 200, 300]
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    let previous = 0
    for (const length of lengths) {
      const { version } = qrMatrix('x'.repeat(length), { ecc })
      assert.ok(version >= previous, `${ecc}: ${length} bytes regressed from ${previous} to ${version}`)
      previous = version
    }
    assert.ok(qrMatrix('x'.repeat(300), { ecc }).version >= 10)
  }
})

test('over-capacity and invalid options produce clear errors', () => {
  assert.throws(() => qrMatrix('x'.repeat(700), { ecc: 'M' }), /payload too long/u)
  assert.throws(() => qrMatrix('x'.repeat(383), { ecc: 'H' }), /payload too long/u)
  assert.throws(() => qrMatrix('x'.repeat(100), { version: 1, ecc: 'L' }), /does not fit/u)
  assert.throws(() => qrMatrix('x', { ecc: 'Z' }), /Unsupported QR error correction level/u)
  assert.throws(() => qrMatrix('x', { version: 21 }), /Unsupported QR version/u)
  assert.throws(() => qrMatrix(42), TypeError)
  assert.throws(() => renderSvg('x', { margin: -1 }), /margin/u)
  assert.throws(() => renderSvg('x', { scale: 0 }), /scale/u)
})

/**
 * Independent fixtures: byte-mode matrices produced by the Python `qrcode`
 * package for the same payload, ECC level and mask. They pin data placement,
 * Reed–Solomon coding, format/version information and masking, so an encoder
 * that is merely self-consistent still fails here.
 */
const REFERENCE_MATRICES = [
  {
    text: 'hello',
    ecc: 'L',
    mask: 7,
    version: 1,
    rows: [
      '111111100101101111111',
      '100000101101001000001',
      '101110101100101011101',
      '101110100101001011101',
      '101110101000101011101',
      '100000101001101000001',
      '111111101010101111111',
      '000000001111100000000',
      '110100110110001110110',
      '011111011100001000011',
      '001101111010110001101',
      '000101001001000001011',
      '000010110110101010000',
      '000000001111000110101',
      '111111101110010101110',
      '100000100111110110000',
      '101110100101001110001',
      '101110101011000101111',
      '101110100110100010101',
      '100000101110011000000',
      '111111101011100101010',
    ],
  },
  {
    text: 'http://192.168.3.39:3081/?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ecc: 'M',
    mask: 4,
    version: 5,
    rows: [
      '1111111011000101001101000110101111111',
      '1000001000100110101011100010101000001',
      '1011101001100011011111010011101011101',
      '1011101010001010011100110101001011101',
      '1011101011001000001100111111001011101',
      '1000001010001100001100000110001000001',
      '1111111010101010101010101010101111111',
      '0000000010001101011001010010000000000',
      '1000101110111001001110101101011111001',
      '1000100000000000100111000010101010010',
      '0111011111111010110010011111011100100',
      '1101110101001110011001010001100000110',
      '0101111000001111000111100010001000011',
      '0000000000111000111100111101010111001',
      '1001011100101101001011110001110101100',
      '1011000101111001100011010011100000100',
      '0001111111001010100010111101011111101',
      '1011110111110000001100000110101010010',
      '1110001111111101010011011101010100100',
      '0010100100001101111001110011111000110',
      '1000111011001000000101100010101000000',
      '0110010100111100101010011101000110001',
      '0100011001100101010001110001110111100',
      '0111010011111001111111010010000111100',
      '0010101101101010001010101100011111101',
      '1000010010011000100101000010101010000',
      '0000101100000000110010011001001100100',
      '0011110011111100011001010011111000101',
      '1101001011111101000111100010111110000',
      '0000000010101100111000011101100010101',
      '1111111011010001001011111000101011000',
      '1000001000000111100011000011100011100',
      '1011101011111010100110101100111110101',
      '1011101000101100001101000011001100001',
      '1011101001011011010010111101101000100',
      '1000001000010111111001010001110110110',
      '1111111011110100000111100011011000011',
    ],
  },
]

for (const fixture of REFERENCE_MATRICES) {
  test(`matches the independent reference matrix for version ${fixture.version}`, () => {
    const matrix = qrMatrix(fixture.text, { ecc: fixture.ecc })
    assert.equal(matrix.version, fixture.version)
    assert.equal(matrix.mask, fixture.mask)
    assert.equal(matrix.size, fixture.rows.length)
    const rows = matrix.modules.map((row) => Array.from(row, (cell) => (cell === 1 ? '1' : '0')).join(''))
    assert.deepEqual(rows, fixture.rows)
  })
}


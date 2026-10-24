// Dependency-free QR Code (Model 2) encoder for byte-mode payloads.
//
// The tables below cover versions 1..20. Each entry is [count, totalCodewords,
// dataCodewords] and the four inner arrays are the L, M, Q and H block layouts.
const RS_BLOCKS = [
  // Version 1
  [
    [[1, 26, 19]],
    [[1, 26, 16]],
    [[1, 26, 13]],
    [[1, 26, 9]],
  ],
  // Version 2
  [
    [[1, 44, 34]],
    [[1, 44, 28]],
    [[1, 44, 22]],
    [[1, 44, 16]],
  ],
  // Version 3
  [
    [[1, 70, 55]],
    [[1, 70, 44]],
    [[2, 35, 17]],
    [[2, 35, 13]],
  ],
  // Version 4
  [
    [[1, 100, 80]],
    [[2, 50, 32]],
    [[2, 50, 24]],
    [[4, 25, 9]],
  ],
  // Version 5
  [
    [[1, 134, 108]],
    [[2, 67, 43]],
    [[2, 33, 15], [2, 34, 16]],
    [[2, 33, 11], [2, 34, 12]],
  ],
  // Version 6
  [
    [[2, 86, 68]],
    [[4, 43, 27]],
    [[4, 43, 19]],
    [[4, 43, 15]],
  ],
  // Version 7
  [
    [[2, 98, 78]],
    [[4, 49, 31]],
    [[2, 32, 14], [4, 33, 15]],
    [[4, 39, 13], [1, 40, 14]],
  ],
  // Version 8
  [
    [[2, 121, 97]],
    [[2, 60, 38], [2, 61, 39]],
    [[4, 40, 18], [2, 41, 19]],
    [[4, 40, 14], [2, 41, 15]],
  ],
  // Version 9
  [
    [[2, 146, 116]],
    [[3, 58, 36], [2, 59, 37]],
    [[4, 36, 16], [4, 37, 17]],
    [[4, 36, 12], [4, 37, 13]],
  ],
  // Version 10
  [
    [[2, 86, 68], [2, 87, 69]],
    [[4, 69, 43], [1, 70, 44]],
    [[6, 43, 19], [2, 44, 20]],
    [[6, 43, 15], [2, 44, 16]],
  ],
  // Version 11
  [
    [[4, 101, 81]],
    [[1, 80, 50], [4, 81, 51]],
    [[4, 50, 22], [4, 51, 23]],
    [[3, 36, 12], [8, 37, 13]],
  ],
  // Version 12
  [
    [[2, 116, 92], [2, 117, 93]],
    [[6, 58, 36], [2, 59, 37]],
    [[4, 46, 20], [6, 47, 21]],
    [[7, 42, 14], [4, 43, 15]],
  ],
  // Version 13
  [
    [[4, 133, 107]],
    [[8, 59, 37], [1, 60, 38]],
    [[8, 44, 20], [4, 45, 21]],
    [[12, 33, 11], [4, 34, 12]],
  ],
  // Version 14
  [
    [[3, 145, 115], [1, 146, 116]],
    [[4, 64, 40], [5, 65, 41]],
    [[11, 36, 16], [5, 37, 17]],
    [[11, 36, 12], [5, 37, 13]],
  ],
  // Version 15
  [
    [[5, 109, 87], [1, 110, 88]],
    [[5, 65, 41], [5, 66, 42]],
    [[5, 54, 24], [7, 55, 25]],
    [[11, 36, 12], [7, 37, 13]],
  ],
  // Version 16
  [
    [[5, 122, 98], [1, 123, 99]],
    [[7, 73, 45], [3, 74, 46]],
    [[15, 43, 19], [2, 44, 20]],
    [[3, 45, 15], [13, 46, 16]],
  ],
  // Version 17
  [
    [[1, 135, 107], [5, 136, 108]],
    [[10, 74, 46], [1, 75, 47]],
    [[1, 50, 22], [15, 51, 23]],
    [[2, 42, 14], [17, 43, 15]],
  ],
  // Version 18
  [
    [[5, 150, 120], [1, 151, 121]],
    [[9, 69, 43], [4, 70, 44]],
    [[17, 50, 22], [1, 51, 23]],
    [[2, 42, 14], [19, 43, 15]],
  ],
  // Version 19
  [
    [[3, 141, 113], [4, 142, 114]],
    [[3, 70, 44], [11, 71, 45]],
    [[17, 47, 21], [4, 48, 22]],
    [[9, 39, 13], [16, 40, 14]],
  ],
  // Version 20
  [
    [[3, 135, 107], [5, 136, 108]],
    [[3, 67, 41], [13, 68, 42]],
    [[15, 54, 24], [5, 55, 25]],
    [[15, 43, 15], [10, 44, 16]],
  ],
]

const ECC_LEVELS = ['L', 'M', 'Q', 'H']
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 }

const ALIGNMENT_POSITIONS = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
]

// GF(256) arithmetic with the QR Code primitive polynomial x^8+x^4+x^3+x^2+1.
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let value = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = value
    GF_LOG[value] = i
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
}

const generatorCache = new Map()

function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

function rsGenerator(degree) {
  const cached = generatorCache.get(degree)
  if (cached) return cached
  let generator = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(generator.length + 1)
    for (let j = 0; j < generator.length; j++) {
      next[j] ^= generator[j]
      next[j + 1] ^= gfMultiply(generator[j], GF_EXP[i])
    }
    generator = next
  }
  generatorCache.set(degree, generator)
  return generator
}

function rsEncode(data, ecLength) {
  const generator = rsGenerator(ecLength)
  const remainder = new Uint8Array(ecLength)
  for (const byte of data) {
    const factor = byte ^ remainder[0]
    remainder.copyWithin(0, 1)
    remainder[ecLength - 1] = 0
    if (factor !== 0) {
      for (let i = 0; i < ecLength; i++) {
        remainder[i] ^= gfMultiply(generator[i + 1], factor)
      }
    }
  }
  return remainder
}

function bitLength(value) {
  let length = 0
  while (value !== 0) {
    value >>>= 1
    length++
  }
  return length
}

function bchRemainder(value, polynomial) {
  let remainder = value
  const polynomialLength = bitLength(polynomial)
  while (bitLength(remainder) >= polynomialLength) {
    remainder ^= polynomial << (bitLength(remainder) - polynomialLength)
  }
  return remainder
}

function formatBits(ecc, mask) {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask
  const remainder = bchRemainder(data << 10, 0x537)
  return ((data << 10) | remainder) ^ 0x5412
}

function versionBits(version) {
  return (version << 12) | bchRemainder(version << 12, 0x1f25)
}

function charCountBits(version) {
  return version <= 9 ? 8 : 16
}

function normalizeEcc(ecc) {
  const normalized = typeof ecc === 'string' ? ecc.toUpperCase() : ''
  if (!ECC_LEVELS.includes(normalized)) {
    throw new Error(`Unsupported QR error correction level: ${String(ecc)} (expected L, M, Q or H)`)
  }
  return normalized
}

function normalizeVersion(version) {
  if (!Number.isInteger(version) || version < 1 || version > 20) {
    throw new Error(`Unsupported QR version: ${String(version)} (expected an integer from 1 to 20)`)
  }
  return version
}

function blockLayout(version, ecc) {
  return RS_BLOCKS[version - 1][ECC_LEVELS.indexOf(ecc)]
}

function dataCapacity(version, ecc) {
  return blockLayout(version, ecc).reduce((sum, [count, , data]) => sum + count * data, 0)
}

function encodedLength(bytes, version) {
  return 4 + charCountBits(version) + bytes.length * 8
}

function chooseVersion(bytes, ecc) {
  for (let version = 1; version <= 20; version++) {
    if (encodedLength(bytes, version) <= dataCapacity(version, ecc) * 8) return version
  }
  const maximum = dataCapacity(20, ecc) * 8
  const maxBytes = Math.floor((maximum - 4 - charCountBits(20)) / 8)
  throw new Error(
    `QR Code payload too long: ${bytes.length} UTF-8 bytes (maximum is ${maxBytes} bytes for version 20 at ECC ${ecc})`,
  )
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
}

function createDataCodewords(bytes, version, ecc) {
  const capacity = dataCapacity(version, ecc)
  const capacityBits = capacity * 8
  const needed = encodedLength(bytes, version)
  if (needed > capacityBits) {
    throw new Error(
      `QR Code payload of ${bytes.length} UTF-8 bytes does not fit version ${version} at ECC ${ecc}`,
    )
  }

  const bits = []
  appendBits(bits, 0b0100, 4)
  appendBits(bits, bytes.length, charCountBits(version))
  for (const byte of bytes) appendBits(bits, byte, 8)

  const terminatorLength = Math.min(4, capacityBits - bits.length)
  for (let i = 0; i < terminatorLength; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const codewords = new Uint8Array(capacity)
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    codewords[i / 8] = byte
  }
  const padding = [0xec, 0x11]
  for (let i = bits.length / 8, p = 0; i < capacity; i++, p++) codewords[i] = padding[p % 2]
  return codewords
}

function createCodewords(bytes, version, ecc) {
  const layout = blockLayout(version, ecc)
  const data = createDataCodewords(bytes, version, ecc)
  const dataBlocks = []
  const ecBlocks = []
  let offset = 0
  let ecLength = 0

  for (const [count, total, dataLength] of layout) {
    ecLength = total - dataLength
    for (let i = 0; i < count; i++) {
      const block = data.subarray(offset, offset + dataLength)
      dataBlocks.push(block)
      ecBlocks.push(rsEncode(block, ecLength))
      offset += dataLength
    }
  }

  const interleaved = []
  const longestData = Math.max(...dataBlocks.map((block) => block.length))
  for (let i = 0; i < longestData; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) interleaved.push(block[i])
    }
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of ecBlocks) interleaved.push(block[i])
  }
  return Uint8Array.from(interleaved)
}

function createPatterns(version) {
  const size = 17 + 4 * version
  const modules = Array.from({ length: size }, () => new Uint8Array(size))
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size))

  const setFunction = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    modules[y][x] = dark ? 1 : 0
    isFunction[y][x] = 1
  }

  const drawFinder = (x, y) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6
        const dark =
          inside &&
          (dx === 0 || dx === 6 || dy === 0 || dy === 6 ||
            (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4))
        setFunction(x + dx, y + dy, dark)
      }
    }
  }

  drawFinder(0, 0)
  drawFinder(size - 7, 0)
  drawFinder(0, size - 7)

  for (let i = 8; i < size - 8; i++) {
    setFunction(i, 6, i % 2 === 0)
    setFunction(6, i, i % 2 === 0)
  }

  const centers = ALIGNMENT_POSITIONS[version - 1]
  for (const y of centers) {
    for (const x of centers) {
      if (
        (x === 6 && y === 6) ||
        (x === size - 7 && y === 6) ||
        (x === 6 && y === size - 7)
      ) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1
          setFunction(x + dx, y + dy, dark)
        }
      }
    }
  }

  // Reserve the dark module and both format-information areas.
  setFunction(8, size - 8, true)
  for (let i = 0; i < 15; i++) {
    if (i < 6) setFunction(8, i, false)
    else if (i < 8) setFunction(8, i + 1, false)
    else setFunction(8, size - 15 + i, false)

    if (i < 8) setFunction(size - i - 1, 8, false)
    else if (i < 9) setFunction(7, 8, false)
    else setFunction(14 - i, 8, false)
  }

  if (version >= 7) {
    const bits = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1
      const row = Math.floor(i / 3)
      const column = (i % 3) + size - 11
      setFunction(column, row, dark)
      setFunction(row, column, dark)
    }
  }

  return { size, modules, isFunction }
}

function placeData(patterns, codewords) {
  const { size, modules, isFunction } = patterns
  let bitIndex = 0
  let upward = true

  for (let column = size - 1; column > 0; column -= 2) {
    if (column === 6) column--
    for (let offset = 0; offset < size; offset++) {
      const y = upward ? size - 1 - offset : offset
      for (let dx = 0; dx < 2; dx++) {
        const x = column - dx
        if (isFunction[y][x]) continue
        const bit =
          bitIndex < codewords.length * 8
            ? (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1
            : 0
        modules[y][x] = bit
        bitIndex++
      }
    }
    upward = !upward
  }

  return { size, modules, isFunction }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

function writeFormatInfo(modules, size, ecc, mask) {
  const bits = formatBits(ecc, mask)
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1
    let x
    let y
    if (i < 6) {
      x = 8
      y = i
    } else if (i < 8) {
      x = 8
      y = i + 1
    } else {
      x = 8
      y = size - 15 + i
    }
    modules[y][x] = dark ? 1 : 0

    if (i < 8) {
      x = size - i - 1
      y = 8
    } else if (i < 9) {
      x = 7
      y = 8
    } else {
      x = 14 - i
      y = 8
    }
    modules[y][x] = dark ? 1 : 0
  }
}

function finderPenaltyAddHistory(runLength, history, size) {
  if (history[0] === 0) runLength += size
  history.pop()
  history.unshift(runLength)
}

function finderPenaltyCountPatterns(history) {
  const n = history[1]
  const core =
    n > 0 &&
    history[2] === n &&
    history[3] === n * 3 &&
    history[4] === n &&
    history[5] === n
  if (!core) return 0
  return (
    (history[0] >= n * 4 && history[6] >= n ? 1 : 0) +
    (history[6] >= n * 4 && history[0] >= n ? 1 : 0)
  )
}

function finderPenaltyTerminate(runColor, runLength, history, size) {
  if (runColor) {
    finderPenaltyAddHistory(runLength, history, size)
    runLength = 0
  }
  runLength += size
  finderPenaltyAddHistory(runLength, history, size)
  return finderPenaltyCountPatterns(history)
}

function scoreLine(size, moduleAt, score) {
  let runColor = 0
  let runLength = 0
  const history = [0, 0, 0, 0, 0, 0, 0]

  for (let i = 0; i < size; i++) {
    const color = moduleAt(i)
    if (color === runColor) {
      runLength++
      if (runLength === 5) score += 3
      else if (runLength > 5) score += 1
    } else {
      finderPenaltyAddHistory(runLength, history, size)
      if (!runColor) score += finderPenaltyCountPatterns(history) * 40
      runColor = color
      runLength = 1
    }
  }
  score += finderPenaltyTerminate(runColor, runLength, history, size) * 40
  return score
}

function penaltyScore(modules) {
  const size = modules.length
  let score = 0

  for (let y = 0; y < size; y++) {
    score = scoreLine(size, (x) => modules[y][x], score)
  }
  for (let x = 0; x < size; x++) {
    score = scoreLine(size, (y) => modules[y][x], score)
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const value = modules[y][x]
      if (
        modules[y][x + 1] === value &&
        modules[y + 1][x] === value &&
        modules[y + 1][x + 1] === value
      ) score += 3
    }
  }

  let dark = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) dark += modules[y][x]
  }
  const total = size * size
  const imbalance = Math.abs(dark * 20 - total * 10)
  score += Math.max(0, Math.ceil(imbalance / total) - 1) * 10

  return score
}

/**
 * Encode text as a QR Code Model 2 matrix.
 *
 * @param {string} text Payload to encode as UTF-8 byte-mode data.
 * @param {{ ecc?: 'L'|'M'|'Q'|'H', version?: number }} [options] Error
 *   correction level (default M) and optional fixed version (1..20).
 * @returns {{ size: number, version: number, ecc: string, mask: number, modules: Uint8Array[] }}
 *   The size, chosen version/ECC/mask and rows of dark (1) and light (0) modules.
 */
export function qrMatrix(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('QR Code text must be a string')
  const ecc = normalizeEcc(options.ecc ?? 'M')
  const bytes = Buffer.from(text, 'utf8')
  const version =
    options.version === undefined ? chooseVersion(bytes, ecc) : normalizeVersion(options.version)
  const codewords = createCodewords(bytes, version, ecc)
  const patterns = createPatterns(version)
  const { size, modules, isFunction } = placeData(patterns, codewords)

  let best = null
  let bestPenalty = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row) => Uint8Array.from(row))
    const maskFn = MASKS[mask]
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!isFunction[y][x] && maskFn(x, y)) candidate[y][x] ^= 1
      }
    }
    writeFormatInfo(candidate, size, ecc, mask)
    const penalty = penaltyScore(candidate)
    if (penalty < bestPenalty) {
      bestPenalty = penalty
      best = { mask, modules: candidate }
    }
  }

  return { size, version, ecc, mask: best.mask, modules: best.modules }
}

function escapeXml(value) {
  let output = ''
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0)
    if (character === '&') output += '&amp;'
    else if (character === '<') output += '&lt;'
    else if (character === '>') output += '&gt;'
    else if (character === '"') output += '&quot;'
    else if (character === "'") output += '&apos;'
    else if (codePoint >= 0x20 && codePoint <= 0x7e) output += character
    else output += `&#x${codePoint.toString(16).toUpperCase()};`
  }
  return output
}

/**
 * Render a QR Code as a standalone SVG document.
 *
 * @param {string} text Payload to encode.
 * @param {{ ecc?: 'L'|'M'|'Q'|'H', version?: number, margin?: number,
 *   scale?: number, dark?: string, light?: string, alt?: string }} [options]
 *   Error correction, optional version, quiet-zone width in modules, pixels per
 *   module, colors and an optional accessible title.
 * @returns {string} A complete ASCII-only SVG document.
 */
export function renderSvg(text, options = {}) {
  const margin = options.margin ?? 4
  const scale = options.scale ?? 8
  if (!Number.isInteger(margin) || margin < 0) {
    throw new Error(`QR margin must be a non-negative integer, got ${String(margin)}`)
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`QR scale must be a positive number, got ${String(scale)}`)
  }

  const dark = escapeXml(options.dark ?? '#000000')
  const light = escapeXml(options.light ?? '#ffffff')
  const matrix = qrMatrix(text, options)
  const extent = matrix.size + 2 * margin
  const pixels = extent * scale

  let path = ''
  for (let y = 0; y < matrix.size; y++) {
    let x = 0
    while (x < matrix.size) {
      if (matrix.modules[y][x] === 0) {
        x++
        continue
      }
      const start = x
      while (x < matrix.size && matrix.modules[y][x] === 1) x++
      const width = x - start
      path += `M${start + margin} ${y + margin}h${width}v1h-${width}z`
    }
  }

  const title =
    options.alt === undefined || options.alt === null
      ? ''
      : `<title>${escapeXml(options.alt)}</title>`
  const label =
    options.alt === undefined || options.alt === null
      ? ''
      : ` role="img" aria-label="${escapeXml(options.alt)}"`

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" ` +
    `viewBox="0 0 ${extent} ${extent}" shape-rendering="crispEdges"${label}>` +
    `${title}<rect width="${extent}" height="${extent}" fill="${light}"/>` +
    `<path fill="${dark}" d="${path}"/></svg>`
  )
}

/**
 * Build a base64 SVG data URL for a QR Code.
 *
 * @param {string} text Payload to encode.
 * @param {Parameters<typeof renderSvg>[1]} [options] Rendering options.
 * @returns {string} `data:image/svg+xml;base64,...`
 */
export function svgDataUrl(text, options = {}) {
  return 'data:image/svg+xml;base64,' + Buffer.from(renderSvg(text, options), 'utf8').toString('base64')
}

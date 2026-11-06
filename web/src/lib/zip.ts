/**
 * A minimal zip writer: files are stored as they are (no compression), which keeps it small and is fine for notes
 * and for attachments like images that are compressed already. No zip64, so the whole archive must stay under 4 GB.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS time and date, as zip files store them (local time, 2-second precision, 1980 or later). */
function dosDateTime(date: Date): {time: number; day: number} {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

export interface ZipEntry {
  path: string
  data: Uint8Array | string
  modified?: Date
}

export function makeZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder()
  const parts: BlobPart[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.path)
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data
    const crc = crc32(data)
    const {time, day} = dosDateTime(entry.modified ?? new Date())

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true) // local file header
    local.setUint16(4, 20, true) // version needed
    local.setUint16(6, 0x0800, true) // flags: names are UTF-8
    local.setUint16(8, 0, true) // stored
    local.setUint16(10, time, true)
    local.setUint16(12, day, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true)
    parts.push(local.buffer, name, data as Uint8Array<ArrayBuffer>)

    const header = new DataView(new ArrayBuffer(46))
    header.setUint32(0, 0x02014b50, true) // central directory header
    header.setUint16(4, 20, true) // made by
    header.setUint16(6, 20, true)
    header.setUint16(8, 0x0800, true)
    header.setUint16(10, 0, true)
    header.setUint16(12, time, true)
    header.setUint16(14, day, true)
    header.setUint32(16, crc, true)
    header.setUint32(20, data.length, true)
    header.setUint32(24, data.length, true)
    header.setUint16(28, name.length, true)
    // extra, comment, disk, internal and external attributes: 0
    header.setUint32(42, offset, true)
    central.push(new Uint8Array(header.buffer), name)

    offset += 30 + name.length + data.length
  }

  const centralSize = central.reduce((n, part) => n + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true) // end of central directory
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)

  return new Blob([...parts, ...(central as Uint8Array<ArrayBuffer>[]), end.buffer], {type: "application/zip"})
}

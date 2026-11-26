import { crc32 } from 'node:zlib'
import { generateKeyPairSync, sign } from 'node:crypto'
import {
  APP_NAME,
  BUNDLE_ID,
  REPOSITORY,
  sha256,
  type UpdateManifest,
} from '../electron/updates/protocol'
export function zip(entries: { name: string; content?: string; mode?: number }[]) {
  const local: Buffer[] = [],
    central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      bytes = Buffer.from(entry.content ?? '')
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc32(bytes), 14)
    header.writeUInt32LE(bytes.length, 18)
    header.writeUInt32LE(bytes.length, 22)
    header.writeUInt16LE(name.length, 26)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50)
    directory.writeUInt16LE(0x314, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt32LE(crc32(bytes), 16)
    directory.writeUInt32LE(bytes.length, 20)
    directory.writeUInt32LE(bytes.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    directory.writeUInt32LE(offset, 42)
    local.push(header, name, bytes)
    central.push(directory, name)
    offset += header.length + name.length + bytes.length
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
export function updateFixture(
  version = '1.2.0',
  archive = zip([{ name: `${APP_NAME}/Contents/Info.plist`, content: 'fixture' }]),
) {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString(
    'base64',
  )
  const manifest: UpdateManifest = {
    schemaVersion: 1,
    repository: REPOSITORY,
    bundleId: BUNDLE_ID,
    version,
    commit: 'a'.repeat(40),
    platform: 'darwin',
    arch: 'arm64',
    minimumSystemVersion: '13.0',
    zip: { name: `app-${version}-arm64.zip`, size: archive.length, sha256: sha256(archive) },
    dmg: { name: 'app.dmg', size: 1, sha256: 'b'.repeat(64) },
  }
  const encode = () => {
    const bytes = Buffer.from(JSON.stringify(manifest))
    return { bytes, signature: sign(null, bytes, keys.privateKey).toString('base64') }
  }
  return { keys, publicKey, archive, manifest, encode }
}

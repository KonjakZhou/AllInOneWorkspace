import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { hashFile } from '../electron/updates/files.ts'
import { manifestSchema, MANIFEST_NAME, SIGNATURE_NAME } from '../electron/updates/protocol.ts'

// A permanent download URL, independent of the versioned updater assets.
export const INSTALLER_ALIAS_NAME = 'all-in-one-workspace-arm64.dmg'

async function assertAsset(path, asset) {
  if ((await stat(path)).size !== asset.size || (await hashFile(path)) !== asset.sha256)
    throw new Error('发布包已变化，拒绝生成下载副本或上传')
}

// Callers verify the manifest's signature before preparing files for upload.
export async function prepareReleaseFiles(directory, input) {
  const manifest = manifestSchema.parse(input)
  const versioned = [manifest.zip, manifest.dmg]
  if (versioned.some((asset) => asset.name === INSTALLER_ALIAS_NAME))
    throw new Error('签名清单必须保留独立的版本附件，不能覆盖为固定下载名')
  for (const asset of versioned) await assertAsset(join(directory, asset.name), asset)

  const alias = join(directory, INSTALLER_ALIAS_NAME)
  const temporary = `${alias}.${randomUUID()}.tmp`
  try {
    await copyFile(join(directory, manifest.dmg.name), temporary, constants.COPYFILE_EXCL)
    await assertAsset(temporary, manifest.dmg)
    await rename(temporary, alias)
  } finally {
    await rm(temporary, { force: true })
  }
  return [
    manifest.zip.name,
    manifest.dmg.name,
    MANIFEST_NAME,
    SIGNATURE_NAME,
    INSTALLER_ALIAS_NAME,
  ].map((name) => join(directory, name))
}

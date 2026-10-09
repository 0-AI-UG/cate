// Skills bundled with the runtime tarball (`cate-cli`, `cate-theme`): one more
// source, read from disk, so installing them works offline and matches the
// runtime's version. Ids match the curated index (`cate/<name>`), so a bundled
// and a curated install are the same skill to the manifest.

import path from 'node:path'
import { parseFrontmatter, slugifySkillName, type SkillEntry, type SkillFile } from '../contract'
import { readDirectory, skillFiles } from './bundle'
import type { SkillFiles } from './files'

export const BUNDLED_SOURCE_ID = 'cate'
const BUNDLED_REPO = '0-AI-UG/cate'

export async function listBundledSkills(files: SkillFiles, dir: string | undefined): Promise<SkillEntry[]> {
  if (!dir) return []
  let nodes: Array<{ name: string; isDirectory: boolean }>
  try { nodes = await files.readDir(dir) } catch { return [] }
  const out: SkillEntry[] = []
  for (const node of nodes.filter((n) => n.isDirectory).sort((a, b) => a.name.localeCompare(b.name))) {
    let text: string
    try { text = await files.readFile(path.join(dir, node.name, 'SKILL.md')) } catch { continue }
    const { fm, tags } = parseFrontmatter(text)
    const name = fm.name || node.name
    out.push({
      id: `${BUNDLED_SOURCE_ID}/${slugifySkillName(name)}`,
      name,
      description: (fm.description ?? '').replace(/\s+/g, ' ').trim(),
      tags,
      format: 'skill-md',
      source: { repo: BUNDLED_REPO, ref: 'main', path: `skills/${node.name}` },
      provenance: 'bundled',
      sourceId: BUNDLED_SOURCE_ID,
      firstParty: true,
    })
  }
  return out
}

/** The files of a bundled skill, by its dir name. */
export async function readBundledSkill(files: SkillFiles, dir: string, name: string): Promise<SkillFile[]> {
  return skillFiles(await readDirectory(files, path.join(dir, name)))
}

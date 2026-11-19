import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const documents = ['README.md', 'README.zh-CN.md', 'SETUP.md', 'cards/README.md', ...readdirSync(join(root, 'docs'), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
  .map(entry => relative(root, join(entry.parentPath, entry.name)))]
const read = (path: string): string => readFileSync(join(root, path), 'utf8')

describe('Super-Org documentation', () => {
  it('resolves local links across the documentation, including event references', () => {
    const missing = documents.flatMap(file => [...read(file).matchAll(/\]\(([^)\s]+)\)/g)]
      .map(([, link]) => link!.split('#')[0]!)
      .filter(target => target && !/^[a-z]+:/i.test(target) && !existsSync(resolve(root, dirname(file), target)))
      .map(target => `${file} → ${target}`))
    expect(missing).toEqual([])
  })

  it('contains no merge conflict markers', () => {
    expect(documents.filter(file => /^(<{7}|>{7}) /m.test(read(file)))).toEqual([])
  })
})

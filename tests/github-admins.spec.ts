import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/export-github-admins', import.meta.url))
it('exports all pages as a static allowed list, excluding non-admins and bots', () => {
  const output = execFileSync('python3', ['-c', `
import json, runpy, sys
from unittest.mock import patch, Mock
export = runpy.run_path(sys.argv[1])['export']
pages = [
    [{'login': 'bob', 'type': 'User', 'permissions': {'admin': True}},
     {'login': 'writer', 'type': 'User', 'permissions': {'admin': False}}],
    [{'login': 'alice', 'type': 'User', 'permissions': {'admin': True}},
     {'login': 'bob', 'type': 'User', 'permissions': {'admin': True}},
     {'login': 'reviewer[bot]', 'type': 'Bot', 'permissions': {'admin': True}}],
]
with patch('subprocess.run', return_value=Mock(stdout=json.dumps(pages))) as run:
    allowed = export('acme/widgets', '/custom/gh')
    print(json.dumps({'allowed': allowed, 'args': run.call_args.args[0]}))
`, script], { encoding: 'utf8' })
  expect(JSON.parse(output)).toEqual({ allowed: [{ id: 'alice' }, { id: 'bob' }],
    args: ['/custom/gh', 'api', 'repos/acme/widgets/collaborators?permission=admin&per_page=100', '--paginate', '--slurp'] })
})
it('fails without emitting an empty or partial list when the GitHub read fails', () => {
  const result = spawnSync('python3', ['-c', `
import json, runpy, subprocess, sys
from unittest.mock import patch
export = runpy.run_path(sys.argv[1])['export']
with patch('subprocess.run', side_effect=subprocess.CalledProcessError(1, 'gh')):
    print(json.dumps(export('acme/widgets')))
`, script], { encoding: 'utf8' })
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
})

/**
 * Benchmark cases for the PowerShell → Git Bash comparison.
 *
 * Every command is written the way a model would naturally write it on Linux.
 * The same string is handed to both shells; it is deliberately NOT translated
 * into the native syntax of the other shell. A case passes only when the first
 * attempt exits successfully, produces the expected text, and writes nothing
 * to stderr.
 *
 * @module dsh-win-mingw/benchmarks/cases
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Create a deterministic fixture tree inside `root`. */
export function createFixture(root) {
  mkdirSync(join(root, 'src', 'nested'), { recursive: true })
  writeFileSync(join(root, 'data.txt'), 'alpha 1\nbeta 2\nGamma 3\n中文 4\n')
  writeFileSync(join(root, 'notes with space.txt'), 'space-note\n')
  writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1\n')
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b: number = 2\n')
  writeFileSync(join(root, 'src', 'nested', 'c.js'), 'export const c = 3\n')
}

/**
 * Each case has the same command for both shells.
 *
 * `expect` is a list of regular expressions; every expression must match the
 * combined stdout. Keep cases small and deterministic so the comparison is
 * about shell dialect, not about which external tools happen to be installed.
 */
export const CASES = [
  {
    id: 'printf-utf8',
    area: 'encoding',
    description: 'UTF-8 printf output',
    command: String.raw`printf '中文-é\n'`,
    expect: [/^中文-é$/mu],
  },
  {
    id: 'variable-expansion',
    area: 'variables',
    description: 'POSIX assignment and interpolation',
    command: String.raw`name=world; printf 'hello %s\n' "$name"`,
    expect: [/^hello world$/mu],
  },
  {
    id: 'single-quotes',
    area: 'quoting',
    description: 'Single quotes preserve dollar signs',
    command: String.raw`printf '%s\n' 'literal $HOME'`,
    expect: [/^literal \$HOME$/mu],
  },
  {
    id: 'test-and',
    area: 'control-flow',
    description: 'test plus && chaining',
    command: `test -f data.txt && echo file-ok`,
    expect: [/^file-ok$/mu],
  },
  {
    id: 'grep-numbered',
    area: 'text-search',
    description: 'grep with line numbers',
    command: `grep -n 'Gamma' data.txt`,
    expect: [/^3:Gamma 3$/mu],
  },
  {
    id: 'sed-line-range',
    area: 'text-stream',
    description: 'sed line selection',
    command: `sed -n '2p' data.txt`,
    expect: [/^beta 2$/mu],
  },
  {
    id: 'awk-fields',
    area: 'text-stream',
    description: 'awk field filtering',
    command: `awk '$2 >= 2 { print $1 }' data.txt`,
    expect: [/^beta$/mu, /^Gamma$/mu],
  },
  {
    id: 'find-sort',
    area: 'filesystem',
    description: 'find with a glob and sort',
    command: `find src -name '*.js' | sort`,
    expect: [/^src\/a\.js$/mu, /^src\/nested\/c\.js$/mu],
  },
  {
    id: 'wc-input-redirect',
    area: 'redirection',
    description: 'wc fed by stdin redirection',
    command: `wc -l < data.txt`,
    expect: [/^4$/mu],
  },
  {
    id: 'for-glob',
    area: 'control-flow',
    description: 'for loop over a glob',
    command: `for f in src/*.js; do printf '%s\\n' "$f"; done`,
    expect: [/^src\/a\.js$/mu],
  },
  {
    id: 'if-directory',
    area: 'control-flow',
    description: 'if [ -d ... ] condition',
    command: `if [ -d src ]; then echo dir-ok; fi`,
    expect: [/^dir-ok$/mu],
  },
  {
    id: 'inline-env',
    area: 'environment',
    description: 'Inline environment assignment',
    command: `FOO=bar node -e "console.log(process.env.FOO)"`,
    expect: [/^bar$/mu],
  },
  {
    id: 'command-substitution',
    area: 'control-flow',
    description: 'POSIX command substitution',
    command: `echo "$(printf 'sub')"`,
    expect: [/^sub$/mu],
  },
  {
    id: 'pipe-tr',
    area: 'pipeline',
    description: 'Pipe into tr',
    command: String.raw`printf 'ab\ncd\n' | tr a-z A-Z`,
    expect: [/^AB$/mu, /^CD$/mu],
  },
  {
    id: 'redirect-bytes',
    area: 'redirection',
    description: 'Write a file and inspect its bytes',
    command: String.raw`printf 'x\n' > out.txt; od -An -tx1 out.txt`,
    expect: [/78 0a/u],
  },
  {
    id: 'heredoc',
    area: 'quoting',
    description: 'POSIX here-document',
    command: ["cat <<'EOF'", 'heredoc', 'EOF'].join('\n'),
    expect: [/^heredoc$/mu],
  },
  {
    id: 'pwd',
    area: 'filesystem',
    description: 'POSIX working-directory path',
    command: 'pwd',
    expect: [/^\//mu],
  },
  {
    id: 'command-v',
    area: 'discovery',
    description: 'POSIX command lookup',
    command: 'command -v bash',
    expect: [/(?:usr\/)?bin\/bash$/mu],
  },
  {
    id: 'ls-lines',
    area: 'filesystem',
    description: 'ls one entry per line',
    command: 'ls -1 src',
    expect: [/^a\.js$/mu, /^b\.ts$/mu, /^nested$/mu],
  },
  {
    id: 'head',
    area: 'text-stream',
    description: 'head selects leading lines',
    command: 'head -2 data.txt',
    expect: [/^alpha 1$/mu, /^beta 2$/mu],
  },
  {
    id: 'mkdir-spaces',
    area: 'filesystem',
    description: 'mkdir -p with a spaced path',
    command: `mkdir -p 'dir with space' && test -d 'dir with space' && echo ok`,
    expect: [/^ok$/mu],
  },
  {
    id: 'exit-status',
    area: 'exit-codes',
    description: 'Capture $? after a failure',
    command: String.raw`false; printf 'status=%s\n' "$?"`,
    expect: [/^status=1$/mu],
  },
  {
    id: 'cat-spaced-file',
    area: 'filesystem',
    description: 'Read a path containing spaces',
    command: `cat 'notes with space.txt'`,
    expect: [/^space-note$/mu],
  },
  {
    id: 'git-control',
    area: 'control',
    description: 'Cross-shell control: native git',
    command: 'git --version',
    expect: [/^git version /mu],
  },
  {
    id: 'node-control',
    area: 'control',
    description: 'Cross-shell control: native node',
    command: `node -e "console.log(process.version)"`,
    expect: [/^v\d+\./mu],
  },
]

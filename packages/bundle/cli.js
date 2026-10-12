#!/usr/bin/env node
/**
 * `dsh-wechat-send` entry point.
 *
 * A launcher, and nothing more: the command itself is TypeScript beside the host half, beside the
 * functions it shares with it. A non-TypeScript file is what npm's `bin` needs, and it stays free of
 * any import of its own because the built `lib/` is the only half whose `@dsh-wechat/core` specifier
 * gets rewritten for the two install paths — see `docs/INTERNALS.md`.
 *
 * The import is dynamic for that reason alone. `--help` is deliberately *not* answered here: one
 * implementation of the usage text is the point, and the launcher would be a second copy of it that
 * drifts the first time an exit code changes.
 *
 * Exit codes are documented in `--help` and implemented in `src/cli.ts`.
 */

const { runCli } = await import('./lib/cli.js')
const { code } = await runCli(process.argv.slice(2))
process.exit(code)

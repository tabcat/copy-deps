#!/usr/bin/env node
import process from 'node:process'
import { exec } from 'node:child_process'
import path from 'node:path'
import util from 'node:util'
import { program } from 'commander'

const copyDependenciesKey = 'copyDependencies'
const errors = {
  packageFileImportFail: (packagePath: string, cwd: string) =>
    new Error(
      `Failed to import package.json file.
packagePath: ${packagePath}
cwd: ${cwd}`
    ),
  copyDepsMissing: () =>
    new Error(`required package.${copyDependenciesKey} field is missing`),
  copyDepsEmpty: () =>
    new Error(`required package.${copyDependenciesKey} field is empty`),
  missingPackage: (pack: string) =>
    new Error(
      `package '${pack}' does not exist in dependencies or devDependencies`
    ),
  noDependencies: (pack: Pack) =>
    new Error(`Package '${pack.name}' does not have any dependencies`),
  duplicateCopiedDeps: (duplicates: Record<string, string[]>) =>
    new Error(
      `There are two or more packages trying to copy the same dependencies:
${util.inspect(duplicates)}`
    ),
  unexpectedListOutput: (name: string, stdout: string) =>
    new Error(
      `The list command gave unexpected output for package '${name}'
stdout: ${stdout}`
    ),
  installFailed: (cmd: string) =>
    new Error(
      `Failed to install packages
cmd: ${cmd}`
    ),
  packMissing: (name: string) =>
    new Error(
      `Pack missing for '${name}' from internal map object. Mismatch in copyDeps and retrieved package files.`
    ),
  depsMissing: (missing: Record<string, string[]>) =>
    new Error(
      `Deps missing inside retrieved package files.
missing: ${util.inspect(missing)}`
    )
}

interface Dependencies {
  [key: string]: string
}
interface CopyDependencies {
  [key: string]: string[]
}
interface Pack {
  name: string
  version: string
  dependencies?: Dependencies
  devDependencies?: Dependencies
  copyDependencies?: CopyDependencies
}
interface ExecException extends Error {
  cmd?: string | undefined
  killed?: boolean | undefined
  code?: number | undefined
  signal?: NodeJS.Signals | undefined
}

program
  .option(
    '-p, --package [path]',
    'path to package.json file',
    path.join(process.cwd(), 'package.json')
  )
  .option('--pnpm', 'use pnpm')
program.parse()

const { package: packagePath, pnpm } = program.opts()
const cwd = path.dirname(packagePath)

/**
 * import package.json file
 */
let pack: Pack
try {
  const { default: json } = await import(packagePath, {
    assert: { type: 'json' }
  })
  pack = json
} catch (e) {
  console.error(e)
  throw errors.packageFileImportFail(packagePath, cwd)
}

if (pack[copyDependenciesKey] == null) {
  throw errors.copyDepsMissing()
}
const copyDependencies = pack[copyDependenciesKey]
if (Object.keys(copyDependencies).length === 0) {
  throw errors.copyDepsEmpty()
}

/**
 * check all packages to copy are installed
 */
const dependencies: Set<string> = new Set()
const devDependencies: Set<string> = new Set()
for (const name of Object.keys(copyDependencies)) {
  if (pack.dependencies?.[name] != null) {
    dependencies.add(name)
  } else if (pack.devDependencies?.[name] != null) {
    devDependencies.add(name)
  } else {
    throw errors.missingPackage(name)
  }
}

/**
 * check for duplicate packages and if positive log error
 */
const dep2names: Map<string, string[]> = new Map()
for (const [name, deps] of Object.entries(copyDependencies)) {
  for (const dep of deps) {
    const names = dep2names.get(dep)

    if (names != null) {
      names.push(name)
    } else {
      dep2names.set(dep, [name])
    }
  }
}
const duplicates: { [key: string]: string[] } = Object.fromEntries(
  Array.from(dep2names.entries()).filter(([, names]) => names.length > 1)
)
if (Object.keys(duplicates).length > 0) {
  throw errors.duplicateCopiedDeps(duplicates)
}

/**
 * get package files for dependencies
 */
const pm = pnpm === true ? 'pnpm' : 'npm'
const name2pack: Map<string, Pack> = new Map()
const promises: Array<Promise<void>> = []
for (const name of Object.keys(copyDependencies)) {
  const promise = new Promise<Pack>((resolve, reject) =>
    exec(
      `${pm} list --json --long ${name}`,
      { cwd, encoding: 'utf8' },
      (error: ExecException | null, stdout: string) => {
        if (error != null) {
          reject(error)
        }

        let pack: Pack
        try {
          const json = JSON.parse(stdout).dependencies[name]
          json.dependencies = json._dependencies
          pack = json
        } catch (e) {
          throw errors.unexpectedListOutput(name, stdout)
        }

        resolve(pack)
      }
    )
  )
    .catch((error) => {
      throw error
    })
    .then((pack) => {
      name2pack.set(name, pack)
    })

  promises.push(promise)
}
await Promise.all(promises)

/**
 * check for missing deps in pack files and prep for install
 */
const nameAtVersion = (name: string, version: string): string =>
  `${name}@${version}`
const missing: Record<string, string[]> = {}
const prod: string[] = []
const dev: string[] = []
for (const [name, deps] of Object.entries(copyDependencies)) {
  const hits = dependencies.has(name) ? prod : dev
  const pack = name2pack.get(name)

  if (pack == null) {
    throw errors.packMissing(name)
  }
  if (pack.dependencies == null) {
    throw errors.noDependencies(pack)
  }

  const misses: string[] = []
  for (const dep of deps) {
    if (pack.dependencies[dep] == null) {
      misses.push(dep)
    } else {
      hits.push(nameAtVersion(dep, pack.dependencies[dep] as string))
    }
  }
  if (misses.length > 0) {
    missing[name] = misses
  }
}
if (Object.keys(missing).length > 0) {
  throw errors.depsMissing(missing)
}

/**
 * install same versions of packages as dependencies
 */
const installDeps = (deps: string[], dev = false): string =>
  `${pm} install ${deps.join(' ')}${dev ? '-D' : ''}`
const cmds: string[] = []
prod.length > 0 && cmds.push(installDeps(prod))
dev.length > 0 && cmds.push(installDeps(dev, true))
const installCmd = cmds.join(' && ')
console.log(installCmd)
try {
  await new Promise<void>((resolve, reject) =>
    exec(
      installCmd,
      { cwd },
      (error: ExecException | null, _stdout: string) => {
        if (error != null) {
          reject(error)
        }

        resolve()
      }
    )
  )
} catch (e) {
  console.error(e)
  throw errors.installFailed(installCmd)
}
console.log('copyDependencies have been installed')

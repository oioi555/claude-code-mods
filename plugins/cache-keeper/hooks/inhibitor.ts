// The command that holds off idle sleep for as long as it lives, per platform.
// The module spawns it with `$.process.spawn`; ending the loop, or the module
// unloading, kills it, and the OS drops the hold with the process.
import type { CacheKeeperSleep as Sleep } from '../types'

export type Platform = Sleep['platform']

const WHO = 'Claude Code cache-keeper'
const WHY = 'Keep the prompt cache alive before compacting'

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by this PowerShell thread until it exits
const WINDOWS_SCRIPT = [
  "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
  '$t = Add-Type -MemberDefinition $sig -Name Power -Namespace CacheKeeper -PassThru',
  'if ($t::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 2 }',
  'while ($true) { Start-Sleep -Seconds 3600 }',
].join('; ')

export function inhibitorArgv(platform: Platform): string[] | undefined {
  switch (platform) {
    case 'linux':
      return ['systemd-inhibit', '--what=idle:sleep', `--who=${WHO}`, `--why=${WHY}`, '--mode=block', 'sleep', 'infinity']
    case 'windows':
      return ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT]
    case 'macos':
      return ['caffeinate', '-i']
    default:
      return undefined
  }
}

/** `uname -s` output to a platform; Windows is told by `OS=Windows_NT` first. */
export function platformOf(osVar: string | undefined, uname: string | undefined): Platform {
  if (osVar === 'Windows_NT') return 'windows'
  const name = uname?.trim()
  if (name === 'Linux') return 'linux'
  if (name === 'Darwin') return 'macos'
  return 'unsupported'
}

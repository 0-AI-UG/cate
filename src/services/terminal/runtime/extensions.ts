// Extension points of the terminal service. Other runtime modules (the api
// router, agents, T3) plug in here, so terminal never imports them.

import type { LaunchIntent, TerminalActivity } from '../contract'
import type { ProcTree } from './procScan'

export interface LaunchCommand {
  executable: string
  args: string[]
}

/** What a launch intent turns into: a program run in place of the shell,
 *  text typed into the shell once it starts, or both. */
export interface LaunchPlan {
  command?: LaunchCommand
  input?: string
}

export type LaunchResolver = (params: unknown, spawn: { cwd: string; panelId: string | null }) => LaunchPlan | Promise<LaunchPlan>

/** Everything known about a PTY right before it spawns. */
export interface SpawnInfo {
  terminalId: string
  panelId: string | null
  cwd: string
  launch: LaunchIntent | null
  /** The program that runs: the shell or the launch command. */
  executable: string
  args: readonly string[]
  /** The env so far, contributors before this one included. */
  env: Readonly<Record<string, string>>
}

/** Returns variables to set (merged over the env so far). A contributor that
 *  throws is skipped: a terminal must open even when a contributor fails. */
export type EnvContributor = (spawn: SpawnInfo) => Record<string, string> | undefined | void | Promise<Record<string, string> | undefined | void>

export type OutputObserver = (terminalId: string, data: string) => void
export type InputObserver = (terminalId: string, data: string) => void
export type ExitObserver = (terminalId: string, exitCode: number) => void

/** One activity scan of one live PTY, with the process table it was read
 *  from (agent presence checks its own pids against the same snapshot). */
export interface ActivityScan {
  terminalId: string
  panelId: string | null
  pid: number
  activity: TerminalActivity
  tree: ProcTree
}

export type ActivityObserver = (scan: ActivityScan) => void

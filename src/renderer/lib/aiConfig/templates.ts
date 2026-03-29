import type { AIToolId } from '../../../shared/types'

export interface ProjectContext {
  projectName: string
  packageJson?: {
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  } | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatScripts(scripts: Record<string, string>): string {
  return Object.entries(scripts)
    .map(([key, _]) => `npm run ${key}`)
    .join('\n')
}

function buildCommandsBlock(scripts: Record<string, string> | undefined): string {
  if (!scripts || Object.keys(scripts).length === 0) return ''
  return `\`\`\`bash\n${formatScripts(scripts)}\n\`\`\``
}

// ---------------------------------------------------------------------------
// Template functions
// ---------------------------------------------------------------------------

export function getClaudeMdTemplate(ctx: ProjectContext): string {
  const { projectName, packageJson } = ctx
  const scripts = packageJson?.scripts

  const buildSection = scripts && Object.keys(scripts).length > 0
    ? `## Build System\n\n${buildCommandsBlock(scripts)}`
    : `## Build System\n\n<!-- Add build and run commands here -->`

  return `# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

${projectName} — describe what this project does and its purpose here.

${buildSection}

## Architecture

<!-- Describe the high-level structure: key directories, modules, data flow, etc. -->

## Key Patterns

<!-- List conventions and patterns Claude should follow, e.g.:
- State management approach
- Error handling conventions
- Naming conventions
- File organization rules
-->
`.trimStart()
}

export function getAgentsMdTemplate(ctx: ProjectContext): string {
  const { projectName, packageJson } = ctx
  const scripts = packageJson?.scripts

  const devSection = scripts && Object.keys(scripts).length > 0
    ? `## Dev Environment\n\n${buildCommandsBlock(scripts)}`
    : `## Dev Environment\n\n<!-- Add setup and build commands here -->`

  return `# AGENTS.md

Instructions for AI coding agents (e.g. OpenAI Codex) working in this repository.

## Repository Expectations

<!-- Describe what agents should know about this repo:
- Branch naming conventions
- Commit message style
- PR requirements
-->

${devSection}

## Testing Instructions

<!-- Describe how to run tests and what coverage is expected:
- Test framework used
- How to run individual tests
- What must pass before submitting changes
-->

## Coding Conventions

<!-- Specify style rules and conventions agents must follow for ${projectName}:
- Language/framework patterns
- Linting and formatting rules
- Patterns to avoid
-->
`.trimStart()
}

export function getGeminiMdTemplate(ctx: ProjectContext): string {
  const { projectName, packageJson } = ctx
  const scripts = packageJson?.scripts

  const buildSection = scripts && Object.keys(scripts).length > 0
    ? `## Build Commands\n\n${buildCommandsBlock(scripts)}`
    : `## Build Commands\n\n<!-- Add build and run commands here -->`

  return `# Project: ${projectName}

This file configures Gemini CLI's understanding of this project.

## General Instructions

<!-- Provide high-level guidance for Gemini:
- Project purpose and goals
- Important constraints or requirements
- Files or directories to avoid modifying
-->

## Coding Style

<!-- Describe the coding style Gemini should follow:
- Language conventions and idioms
- Formatting preferences
- Documentation expectations
-->

${buildSection}
`.trimStart()
}

export function getCursorRulesTemplate(ctx: ProjectContext): string {
  const { projectName, packageJson } = ctx
  const deps = packageJson?.dependencies ?? {}
  const devDeps = packageJson?.devDependencies ?? {}
  const allDeps = { ...deps, ...devDeps }
  const topDeps = Object.keys(allDeps).slice(0, 8)

  const techStack = topDeps.length > 0
    ? topDeps.map((d) => `- ${d}`).join('\n')
    : '- <!-- list main frameworks and libraries -->'

  return `# ${projectName}

## Project Overview

Describe the purpose of ${projectName} and what problems it solves.

## Tech Stack

${techStack}

## Coding Conventions

<!-- Define the conventions Cursor should follow:
- Naming conventions (files, variables, functions, components)
- Preferred patterns (e.g. functional vs class components)
- Error handling approach
- Comment and documentation style
-->

## Architecture Notes

<!-- Key architectural decisions and constraints:
- Directory structure overview
- Module boundaries and responsibilities
- State management patterns
- Data flow conventions
-->
`.trimStart()
}

export function getClaudeSettingsTemplate(): string {
  return JSON.stringify(
    {
      permissions: {
        allow: [],
        deny: [],
      },
    },
    null,
    2,
  )
}

export function getMcpJsonTemplate(): string {
  return JSON.stringify(
    {
      mcpServers: {},
    },
    null,
    2,
  )
}

export function getOpenCodeMdTemplate(ctx: ProjectContext): string {
  const { projectName, packageJson } = ctx
  const scripts = packageJson?.scripts

  const buildSection = scripts && Object.keys(scripts).length > 0
    ? `## Build System\n\n${buildCommandsBlock(scripts)}`
    : `## Build System\n\n<!-- Add build and run commands here -->`

  return `# OPENCODE.md

This file provides guidance to OpenCode when working with this repository.

## Project Overview

${projectName} — describe what this project does and its purpose here.

${buildSection}

## Architecture

<!-- Describe the high-level structure: key directories, modules, data flow, etc. -->

## Key Patterns

<!-- List conventions and patterns OpenCode should follow, e.g.:
- State management approach
- Error handling conventions
- Naming conventions
- File organization rules
-->
`.trimStart()
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function getTemplateContent(
  toolId: AIToolId,
  relativePath: string,
  ctx: ProjectContext,
): string {
  switch (toolId) {
    case 'claude':
      if (relativePath === 'CLAUDE.md') return getClaudeMdTemplate(ctx)
      if (relativePath === '.claude/settings.json') return getClaudeSettingsTemplate()
      if (relativePath === '.mcp.json') return getMcpJsonTemplate()
      break

    case 'codex':
      if (relativePath === 'AGENTS.md') return getAgentsMdTemplate(ctx)
      break

    case 'gemini':
      if (relativePath === 'GEMINI.md') return getGeminiMdTemplate(ctx)
      break

    case 'cursor':
      if (relativePath === '.cursorrules') return getCursorRulesTemplate(ctx)
      break

    case 'opencode':
      if (relativePath === 'OPENCODE.md') return getOpenCodeMdTemplate(ctx)
      break
  }

  return `# ${relativePath}\n\n<!-- Add configuration for ${toolId} here -->\n`
}

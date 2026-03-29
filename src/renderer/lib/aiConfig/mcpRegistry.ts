export interface MCPRegistryEntry {
  name: string
  description: string
  category: string
  package: string
  command: string
  args: string[]
  requiredEnv: string[]
}

// Bundled registry — loaded inline to avoid runtime fetch
import registryData from '../../../../assets/mcp-registry.json'

let cachedRegistry: MCPRegistryEntry[] | null = null

export function getRegistry(): MCPRegistryEntry[] {
  if (!cachedRegistry) {
    cachedRegistry = registryData as MCPRegistryEntry[]
  }
  return cachedRegistry
}

export function searchRegistry(query: string): MCPRegistryEntry[] {
  const registry = getRegistry()
  if (!query.trim()) return registry
  const lower = query.toLowerCase()
  return registry.filter(
    (entry) =>
      entry.name.toLowerCase().includes(lower) ||
      entry.description.toLowerCase().includes(lower) ||
      entry.category.toLowerCase().includes(lower),
  )
}

export function getCategories(): string[] {
  const registry = getRegistry()
  return [...new Set(registry.map((e) => e.category))].sort()
}

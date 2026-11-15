// The project's two-letter badge, coloured by its name: the same mark in every sidebar view.

const PROJECT_BADGE_COLORS = ['bg-lime-400/10 text-lime-400', 'bg-pink-400/10 text-pink-400', 'bg-blue-400/10 text-blue-400', 'bg-violet-400/10 text-violet-400', 'bg-amber-400/10 text-amber-400']

export function ProjectBadge({ name }: { name: string }) {
  const words = name.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const initials = words.length > 1 ? words[0][0] + words.at(-1)![0] : name.slice(0, 2)
  const color = PROJECT_BADGE_COLORS[Math.max(0, (name.toUpperCase().charCodeAt(0) || 65) - 65) % PROJECT_BADGE_COLORS.length]
  return <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-semibold ${color}`}>{initials.toUpperCase()}</span>
}

export function DocumentErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-surface-4 gap-2 p-4 text-center">
      <span className="text-red-400 text-sm">{message}</span>
      <button onClick={onRetry} className="text-xs text-neutral-400 hover:text-white underline">Try Again</button>
    </div>
  )
}

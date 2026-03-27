// =============================================================================
// AIChatPanel — AI chat panel (paid feature scaffold).
// =============================================================================

import React, { useState, useCallback, useRef, useEffect } from 'react'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface AIChatPanelProps {
  panelId: string
  workspaceId: string
  nodeId: string
}

export default function AIChatPanel({ panelId, workspaceId, nodeId }: AIChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [messages])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || isLoading) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setIsLoading(true)

    // Placeholder: In production, this would call the Claude API
    // For now, show a message indicating this is a paid feature
    setTimeout(() => {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'AI Chat requires an API key. Configure your Anthropic API key in Settings to enable this feature.',
      }])
      setIsLoading(false)
    }, 500)
  }, [input, isLoading])

  return (
    <div className="flex flex-col h-full bg-[#1E1E24]">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-white/30 text-sm mt-8">
            <div className="text-2xl mb-2">🤖</div>
            <p>AI Chat Panel</p>
            <p className="text-xs mt-1 text-white/20">Paid feature — requires API key</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`text-sm rounded-lg px-3 py-2 max-w-[85%] ${
              msg.role === 'user'
                ? 'ml-auto bg-blue-600/30 text-white/90'
                : 'mr-auto bg-white/[0.05] text-white/80'
            }`}
          >
            {msg.content}
          </div>
        ))}
        {isLoading && (
          <div className="mr-auto text-white/40 text-sm px-3 py-2">
            Thinking...
          </div>
        )}
      </div>

      {/* Input */}
      <div className="p-2 border-t border-white/[0.05]">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
            className="flex-1 bg-[#28282E] text-white text-sm px-3 py-2 rounded-lg border border-white/[0.1] outline-none focus:border-blue-500/50"
            placeholder="Ask anything..."
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="px-3 py-2 bg-blue-600/30 hover:bg-blue-600/40 text-white/80 text-sm rounded-lg disabled:opacity-30"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

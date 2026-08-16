import { useState } from 'react'
import { Bot, Send, Trash2, X } from 'lucide-react'
import { api } from '../api'
import type { AdvisorConversation } from '../types'

export function AdvisorDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [question, setQuestion] = useState('')
  const [conversation, setConversation] = useState<AdvisorConversation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!open) return null
  const send = async () => {
    if (!question.trim() || busy) return
    setBusy(true); setError(null)
    try {
      const result = await api.askAdvisor(question, conversation?.conversation_id)
      setConversation(result); setQuestion(''); setError(result.error ?? null)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Advisor request failed') }
    finally { setBusy(false) }
  }
  const clear = async () => {
    if (conversation) await api.deleteConversation(conversation.conversation_id)
    setConversation(null); setError(null)
  }
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="advisor-drawer" aria-label="Economic advisor" onMouseDown={(event) => event.stopPropagation()}>
    <header><span className="product-glyph"><Bot size={18} /></span><div><strong>Economic advisor</strong><small>Grounded in current deterministic actions</small></div><button className="icon-button" onClick={onClose} aria-label="Close advisor"><X size={17} /></button></header>
    <div className="advisor-privacy">On-demand only · raw logs are never sent · route feasibility remains unknown.</div>
    <div className="advisor-messages">
      {conversation?.messages.map((message) => <article className={message.role} key={message.message_id}><small>{message.role === 'user' ? 'You' : 'Advisor'}</small><p>{message.content}</p>{message.action_ids.length > 0 && <span>{message.action_ids.length} verified action reference{message.action_ids.length === 1 ? '' : 's'}</span>}</article>)}
      {!conversation && <div className="advisor-empty"><Bot size={28} /><strong>Ask for the next economic task</strong><p>For example: “What should I move first to stabilize production?”</p></div>}
    </div>
    {error && <p className="field-error">{error}</p>}
    <div className="advisor-compose"><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What should I do next?" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} /><button className="icon-button primary" disabled={busy || !question.trim()} onClick={() => void send()} aria-label="Ask advisor"><Send size={16} /></button></div>
    {conversation && <button className="button ghost" onClick={() => void clear()}><Trash2 size={14} /> Clear local conversation</button>}
  </aside></div>
}

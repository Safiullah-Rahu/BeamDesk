import { useEffect, useRef, useState } from 'preact/hooks';
import { Send, X } from 'lucide-preact';
import type { ChatMessage } from '@beamdesk/core';
import { IconButton } from './kit.tsx';

export function ChatPanel({ title, messages, onSend, onClose }: { title: string; messages: ChatMessage[]; onSend: (text: string) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);
  useEffect(() => inputRef.current?.focus(), []);

  const send = () => {
    if (!text.trim()) return;
    onSend(text);
    setText('');
  };

  return (
    <aside class="chat" aria-label={`Chat with ${title}`} onKeyDown={(e) => e.stopPropagation()} onKeyUp={(e) => e.stopPropagation()}>
      <div class="chat-head">
        <strong>Chat · {title}</strong>
        <IconButton label="Close chat" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      <div class="chat-list" ref={listRef} role="log" aria-live="polite">
        {messages.length === 0 && <p class="empty">Messages are end-to-end encrypted.</p>}
        {messages.map((m, i) => (
          <div key={i} class={`bubble ${m.from}`}>
            <span>{m.text}</span>
            <time>{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
          </div>
        ))}
      </div>
      <form
        class="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          placeholder="Type a message"
          value={text}
          maxLength={4000}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          aria-label="Message"
        />
        <IconButton label="Send" onClick={send}>
          <Send size={18} />
        </IconButton>
      </form>
    </aside>
  );
}

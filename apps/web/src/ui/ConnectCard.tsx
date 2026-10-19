import { useState } from 'preact/hooks';
import { ArrowRight, KeyRound, LifeBuoy, Pencil, Star, X, Eye, Ellipsis, Search } from 'lucide-preact';
import { formatId, parseId } from '@beamdesk/core';
import { connect, contacts, helpLink, presence, removeContact, rememberPassword, savedPassword, serverState, upsertContact } from '../state/app.ts';
import { Button, copyText, Menu, MenuItem, MenuSep, Segmented } from './kit.tsx';
import { PlatformIcon } from './PlatformIcon.tsx';
import { platformLabel, timeAgo } from './hooks.ts';

/** Formats digits as "123 456 789" while typing. */
function formatPartial(v: string): string {
  return v.replace(/\D/g, '').slice(0, 9).replace(/(\d{3})(?=\d)/g, '$1 ');
}

export function ConnectCard() {
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [usePassword, setUsePassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const valid = !!parseId(id);

  const submit = (e: Event) => {
    e.preventDefault();
    if (!valid) return;
    if (connect(id, { password: usePassword ? password : undefined, remember })) {
      setId('');
      setPassword('');
    }
  };

  return (
    <section class="card connect-card" aria-labelledby="connect-title">
      <header class="card-head">
        <h2 id="connect-title">Connect to another device</h2>
      </header>
      <form onSubmit={submit} class="connect-form">
        <label class="field-label" for="partner-id">
          Partner ID
        </label>
        <div class="id-row">
          <input
            id="partner-id"
            class="id-input"
            inputMode="numeric"
            autoComplete="off"
            spellcheck={false}
            placeholder="123 456 789"
            value={id}
            onInput={(e) => setId(formatPartial(e.currentTarget.value))}
            aria-describedby="partner-hint"
            data-testid="partner-id"
          />
          <Button type="submit" variant="primary" size="lg" disabled={!valid || serverState.value !== 'online'} icon={<ArrowRight size={20} />} data-testid="connect">
            Connect
          </Button>
        </div>
        <p id="partner-hint" class="hint">
          Ask the other person for the ID shown in their BeamDesk.
        </p>
        {!usePassword ? (
          <button type="button" class="link small" onClick={() => setUsePassword(true)}>
            <KeyRound size={14} /> I have a password
          </button>
        ) : (
          <div class="password-box">
            <input
              type="password"
              class="input"
              placeholder="Password"
              autoComplete="off"
              value={password}
              onInput={(e) => setPassword(e.currentTarget.value)}
              aria-label="Password"
              data-testid="partner-password"
            />
            <label class="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} /> Remember on this device
            </label>
          </div>
        )}
      </form>

      <div class="help-box">
        <LifeBuoy size={22} />
        <div>
          <strong>Help someone who doesn’t have BeamDesk</strong>
          <p class="hint">Send them your help link. They open it, click “Share my screen”, and you can join — nothing to install.</p>
        </div>
        <Button size="sm" onClick={() => copyText(helpLink(), 'Help link copied')}>
          Copy help link
        </Button>
      </div>
    </section>
  );
}

export function ContactsCard() {
  const [filter, setFilter] = useState<'all' | 'fav'>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const list = contacts.value
    .filter((c) => filter === 'all' || c.favorite)
    .filter((c) => !query || c.name.toLowerCase().includes(query.toLowerCase()) || c.id.includes(query.replace(/\s/g, '')))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.lastConnected - a.lastConnected);

  return (
    <section class="card contacts-card" aria-labelledby="contacts-title">
      <header class="card-head wrap">
        <h2 id="contacts-title">Recent &amp; favorites</h2>
        <div class="contacts-tools">
          <label class="search">
            <Search size={16} />
            <input placeholder="Search" value={query} onInput={(e) => setQuery(e.currentTarget.value)} aria-label="Search devices" />
          </label>
          <Segmented
            label="Filter"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'fav', label: 'Favorites' },
            ]}
          />
        </div>
      </header>
      {list.length === 0 ? (
        <p class="empty">{contacts.value.length ? 'No matches.' : 'Devices you connect to will appear here for one-click access.'}</p>
      ) : (
        <ul class="contact-list">
          {list.map((c) => {
            const online = presence.value[c.id];
            return (
              <li class="contact" key={c.id}>
                <span class={`avatar ${online ? 'online' : ''}`} title={platformLabel(c.platform)}>
                  <PlatformIcon platform={c.platform} />
                </span>
                <div class="contact-main">
                  {editing === c.id ? (
                    <input
                      class="input slim"
                      autoFocus
                      value={c.name}
                      maxLength={64}
                      aria-label="Device name"
                      onBlur={(e) => {
                        upsertContact({ id: c.id, name: e.currentTarget.value.trim() || formatId(c.id) });
                        setEditing(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                  ) : (
                    <div class="contact-name">
                      {c.name}
                      {c.favorite && <Star size={14} class="fav" fill="currentColor" />}
                    </div>
                  )}
                  <div class="contact-sub">
                    {formatId(c.id)} · <span class={online ? 'ok-text' : ''}>{online ? 'Online' : online === false ? 'Offline' : '—'}</span> · {timeAgo(c.lastConnected)}
                  </div>
                </div>
                <Button size="sm" variant="primary" onClick={() => connect(c.id)}>
                  Connect
                </Button>
                <Menu label="More actions" align="right" trigger={<Ellipsis size={18} />}>
                  {(close) => (
                    <>
                      <MenuItem icon={<Eye size={16} />} onClick={() => (close(), connect(c.id, { viewOnly: true }))}>
                        Connect view-only
                      </MenuItem>
                      <MenuItem icon={<Star size={16} />} onClick={() => (close(), upsertContact({ id: c.id, favorite: !c.favorite }))}>
                        {c.favorite ? 'Remove from favorites' : 'Add to favorites'}
                      </MenuItem>
                      <MenuItem icon={<Pencil size={16} />} onClick={() => (close(), setEditing(c.id))}>
                        Rename
                      </MenuItem>
                      {savedPassword(c.id) && (
                        <MenuItem icon={<KeyRound size={16} />} onClick={() => (close(), rememberPassword(c.id, null))}>
                          Forget saved password
                        </MenuItem>
                      )}
                      <MenuSep />
                      <MenuItem danger icon={<X size={16} />} onClick={() => (close(), removeContact(c.id))}>
                        Remove from list
                      </MenuItem>
                    </>
                  )}
                </Menu>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

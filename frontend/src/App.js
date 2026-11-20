import React, { useState, useEffect, useCallback } from 'react';
import './App.css';
import { API_BASE_URL } from './config';
import ChaosPanel from './ChaosPanel';
import ChatPane from './ChatPane';

// How often to read the API's config again (to see which frameworks' workers have started or stopped)
// and the chaos flags (for the count in the sidebar)
const REFRESH_MS = 10000;
// Above this many frameworks, the sidebar offers a filter box
const FILTER_ABOVE = 6;

// The API's GET /api/config: the AI frameworks it serves, each with its labels, language and whether a
// worker runs its chats. Null if the API can't be reached.
async function fetchFrameworks() {
  try {
    const response = await fetch(`${API_BASE_URL}/config`);
    if (response.ok) {
      const config = await response.json();
      return Array.isArray(config.frameworks) ? config.frameworks : null;
    }
  } catch (error) {
    console.log(`Couldn't read the API's config: ${error}`);
  }
  return null;
}

// How many chaos flags are on for this browser session, or null if unknown
async function fetchChaosCount() {
  try {
    const response = await fetch(`${API_BASE_URL}/chaos`);
    if (response.ok) {
      const chaos = await response.json();
      return (chaos.flags || []).filter((f) => f.enabled).length;
    }
  } catch (error) {
    // The sidebar just shows no count
  }
  return null;
}

const SHOW_CHAOS_KEY = 'showChaosPanel';

function loadShowChaos() {
  try {
    return localStorage.getItem(SHOW_CHAOS_KEY) === 'true';
  } catch (e) {
    return false;
  }
}

// The frameworks grouped by language, keeping the API's order: [[language, [framework...]]...]
function byLanguage(frameworks) {
  const groups = [];
  frameworks.forEach((f) => {
    const language = f.language || 'Other';
    let group = groups.find(([name]) => name === language);
    if (!group) {
      group = [language, []];
      groups.push(group);
    }
    group[1].push(f);
  });
  return groups;
}

// A sidebar that lists every AI framework the API serves, grouped by language, and the selected
// framework's chat beside it. Each framework keeps its own live chat, so the same questions can be put to
// several frameworks and compared.
function App() {
  const [frameworks, setFrameworks] = useState(null);
  const [selected, setSelected] = useState(null);
  // Per framework: {active: a chat is running, unseen: events that arrived while it wasn't selected}
  const [chatState, setChatState] = useState({});
  const [filter, setFilter] = useState('');
  const [showChaos, setShowChaos] = useState(loadShowChaos);
  const [chaosCount, setChaosCount] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const [latest, count] = await Promise.all([fetchFrameworks(), fetchChaosCount()]);
      if (cancelled) return;
      setChaosCount(count);
      if (latest === null) return;
      setFrameworks(latest);
      setSelected((current) => (
        latest.some((f) => f.framework === current) ? current : (latest[0] && latest[0].framework)
      ));
    };
    refresh();
    const intervalId = setInterval(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  const updateChat = useCallback((name, change) => {
    setChatState((prev) => {
      const current = prev[name] || {};
      const next = { ...current };
      if (change.active !== undefined) next.active = change.active;
      if (change.unseen) next.unseen = (current.unseen || 0) + change.unseen;
      return { ...prev, [name]: next };
    });
  }, []);

  const select = (name) => {
    setSelected(name);
    setChatState((prev) => ({ ...prev, [name]: { ...prev[name], unseen: 0 } }));
  };

  const handleToggleChaos = async () => {
    const next = !showChaos;
    setShowChaos(next);
    try {
      localStorage.setItem(SHOW_CHAOS_KEY, String(next));
    } catch (e) {
      // Not remembered across reloads; the panel still toggles.
    }
    if (!next) setChaosCount(await fetchChaosCount());
  };

  // Without the API's config, one chat that starts without naming a framework
  const panes = frameworks && frameworks.length > 0 ? frameworks : [null];
  const listed = (frameworks || []).filter((f) => (
    !filter || `${f.label} ${f.language}`.toLowerCase().includes(filter.toLowerCase())
  ));

  return (
    <div className="layout">
      <div className="App">
        <nav className="sidebar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Wealth Management
          </div>
          {frameworks && frameworks.length > FILTER_ABOVE && (
            <input
              className="framework-filter"
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter frameworks"
              aria-label="Filter frameworks"
            />
          )}
          <div className="framework-list" role="tablist" aria-orientation="vertical" aria-label="AI frameworks">
            {byLanguage(listed).map(([language, group]) => (
              <div className="framework-group" key={language}>
                <div className="framework-group-label">{language}</div>
                {group.map((f) => {
                  const state = chatState[f.framework] || {};
                  const isSelected = f.framework === selected;
                  const classes = ['framework-tab'];
                  if (isSelected) classes.push('selected');
                  if (!f.available) classes.push('unavailable');
                  return (
                    <button
                      key={f.framework}
                      role="tab"
                      aria-selected={isSelected}
                      className={classes.join(' ')}
                      title={f.available
                        ? `${f.label} (task queue ${f.task_queue})`
                        : `${f.label}: no worker is polling task queue ${f.task_queue}`}
                      onClick={() => select(f.framework)}
                    >
                      <span
                        className={`dot ${state.active ? 'live' : ''}`}
                        aria-label={state.active ? 'chat running' : undefined}
                      />
                      <span className="framework-name">{f.short_label || f.label}</span>
                      {!f.available && <span className="framework-note">no worker</span>}
                      {f.available && !isSelected && state.unseen > 0 && (
                        <span className="unseen" aria-label="new replies">{state.unseen}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {frameworks && listed.length === 0 && <div className="framework-empty">No framework matches.</div>}
          </div>
          <button
            className={`chaos-toggle ${showChaos ? 'open' : ''}`}
            onClick={handleToggleChaos}
            aria-pressed={showChaos}
          >
            <span>Chaos</span>
            <span className={`chaos-count ${chaosCount ? 'on' : ''}`}>
              {chaosCount ? `${chaosCount} on` : 'off'}
            </span>
          </button>
        </nav>
        <main className="chat-area">
          {panes.map((f) => (
            <ChatPane
              key={f ? f.framework : 'default'}
              framework={f}
              visible={f === null || f.framework === selected}
              onChange={(change) => f && updateChat(f.framework, change)}
            />
          ))}
        </main>
      </div>
      {showChaos && <ChaosPanel />}
    </div>
  );
}

export default App;
